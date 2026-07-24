import type { AgentRecord } from "./types.js";

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease } from "@earendil-works/pi-tui";
import { registerAgents, getAvailableTypes, setAgentScanDirs, scanAndMerge } from "./agents/agent-types.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./ui/conversation-viewer.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { registerAgentTool } from "./registration.js";
import {
  getPiInstance,
  getManager,
  getWidget,
  getCoordinator,
  getStore,
  setSessionCtx,
  setManager,
  setWidget,
  setCoordinator,
} from "./shell.js";

// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the manager and widget singletons exist.
 * Idempotent — safe to call on every session_start.
 */
export function ensureManagerAndWidget(): void {
  const currentManager = getManager();
  const currentWidget = getWidget();

  // Create manager if missing
  if (!currentManager) {
    // Coordinator will be created after manager, so use a placeholder onComplete
    // that we'll replace once coordinator is created.
    const newManager = new AgentManager(
      undefined, // onComplete wired below
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
      undefined,
      getStore().agent.outputThinkingBufferSize,
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    // Now create coordinator with the real manager
    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    // Wire the manager's onComplete to the coordinator
    newManager.setOnComplete((record) => {
      // Delegate completion side-effects to coordinator
      coordinator.onAgentComplete(record);

      // Mark finished and update widget
      getWidget()?.markFinished(record.id);
      getWidget()?.update();
    });
  }

  // Create widget if missing (uses existing or newly created manager)
  if (!currentWidget) {
    const newWidget = new AgentWidget(
      getManager()!,
      (id: string) => getCoordinator()?.liveView(id),
    );
    setWidget(newWidget);
    // Sync the widget as a config side-effect target. setDeps re-syncs showCost +
    // all widget display settings from current config (absorbs the old
    // newWidget.setShowCost(...) + syncWidgetSettings() calls).
    getStore().setDeps({ widget: newWidget });
  }
}

/**
 * Scan agent files from user, shared, and project directories, merge with defaults,
 * and register into the type registry.
 */
export async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const homeDir = process.env.HOME || "";
  const userAgentDir = path.join(homeDir, ".pi", "agent", "agents");
  const sharedAgentDir = path.join(ctx.cwd, ".agents", "agents");
  const projectAgentDir = path.join(ctx.cwd, ".pi", "agents");

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;

  // Scan user/shared/project layers and merge with defaults
  // (skip defaults when disableDefaultAgents is on)
  const merged = await scanAndMerge({ disableDefaultAgents: disableDefaults });

  registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

export async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // ConfigStore is authoritative for config + session overrides + widget/manager
  // side effects.
  getStore().reload();
  ensureManagerAndWidget();
  await scanAndRegisterAgents(ctx);
}

// ============================================================================
// Event listener setup
// ============================================================================

/**
 * Open a ConversationViewer overlay for the given agent record.
 * Sets viewerOpen flag on the widget to prevent nav deactivation while open.
 */
async function openViewer(ctx: ExtensionContext, record: AgentRecord | null): Promise<void> {
  if (!record) return;
  if (!record.execution?.session) return;
  const widget = getWidget();
  if (!widget) return;
  const manager = getManager();
  const coordinator = getCoordinator();

  try {
    widget.setViewerOpen(true);

    await ctx.ui.custom<void>(
      (tui, theme, kb, done) =>
        new ConversationViewer(
          tui,
          record.execution.session!,
          record,
          theme,
          done,
          () => manager?.abort(record.id, "user"),
          kb,
          (msg: string) => manager?.steer(record.id, msg),
        ),
      { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` } },
    );
  } finally {
    widget.setViewerOpen(false);
  }
}

/**
 * Return type for terminal input listeners.
 */
type InputListenerResult = { consume: true } | undefined;

/**
 * Factory for the navigation + ctrl+o terminal input handler.
 * Exposed so tests can drive the real handler with a stubbed ctx.
 */
export function createNavInputHandler(ctx: ExtensionContext): (data: string) => InputListenerResult {
  return (data: string) => {
    const widget = getWidget();

    // Only fire on key press (not release).
    if (isKeyRelease(data)) return undefined;

    // Viewer overlay open — don't consume, don't deactivate.
    if (widget?.isViewerOpen()) { return undefined; }

    // Editor lost focus (dialog, menu, etc.) — deactivate.
    if (widget && !widget.isEditorFocused()) {
      if (widget.isNavActive()) widget.navDeactivate();
      return undefined;
    }

    if (widget) {
      if (!widget.isNavActive()) {
        // ↓ + empty editor + agents exist → activate
        const agents = getManager()?.listAgents() ?? [];
        const hasAgents = agents.length > 0;
        const editorEmpty = (ctx.ui as any).getEditorText?.() === "";
        if (matchesKey(data, "down") && hasAgents && editorEmpty) {
          widget.navActivate();
          return { consume: true };
        }
      } else {
        // Nav active
        if (matchesKey(data, "down")) { widget.navDown(); return { consume: true }; }
        if (matchesKey(data, "up")) { widget.navUp(); return { consume: true }; }
        if (matchesKey(data, "escape")) { widget.navDeactivate(); return { consume: true }; }
        if (matchesKey(data, "enter")) {
          const record = widget.navSelect();
          openViewer(ctx, record).catch(err => {
            ctx.ui.notify(`Failed to open agent viewer: ${String(err)}`, "error");
          });
          return { consume: true };
        }
        // Any other key → deactivate, pass through.
        widget.navDeactivate();
      }
    }

    // ctrl+o = 0x0F (15) — toggles tool expansion
    if (data === "\u000f") {
      // Read state after a tick to let the built-in handler process it first
      setTimeout(() => {
        const ui = ctx.ui as unknown as { getToolsExpanded?: () => boolean };
        const expanded = ui.getToolsExpanded?.();
        if (expanded !== undefined) {
          // Widget render hint (tool row state), then config-gated compact toggle.
          getWidget()?.notifyToolsExpansionChanged(expanded);
          getStore().notifyToolsExpanded(expanded);
        }
      }, 0);
    }

    return undefined; // Don't consume the input
  };
}

/** Register all pi.on() event listeners. */
export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  pi.on("tool_execution_start", async (_event, ctx) => {
    // Set UI context on first tool execution
    if (!getWidget()) {
      ensureManagerAndWidget();
    }
    getWidget()?.setUICtx(ctx.ui as unknown as UICtx);
    getWidget()?.onTurnStart();
  });


  // session_start — load config, scan agents, register into registry,
  // then re-register Agent tool with dynamic agent type enum
  // Listen for ctrl+o keypress to sync compact mode (push-based, no polling)
  let unregisterTerminalInput: (() => void) | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    // Re-register with updated agent type list (now includes user/project agents)
    registerAgentTool(pi);
    // Register ctrl+o listener
    if (ctx.hasUI && !unregisterTerminalInput) {
      unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
    }
    // Sync compact mode with initial tool expansion state
    getStore().notifyToolsExpanded(false);
  });

  // session_shutdown — abort all, dispose manager
  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    // Warn if agents were killed
    const currentManager = getManager();
    if (currentManager) {
      const records = currentManager.listAgents();
      const active = records.filter(r => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    }
    // Dispose coordinator, store, widget, then manager
    getCoordinator()?.dispose();
    setCoordinator(null);
    getStore().dispose();
    getWidget()?.dispose();
    setWidget(null);
    const mgr = getManager();
    if (mgr) {
      await mgr.dispose();
      setManager(null);
    }
  });
}
