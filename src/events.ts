import type { AgentRecord } from "./types.js";

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease } from "@earendil-works/pi-tui";
import { registerAgents, setAgentScanDirs, scanAndMerge } from "./agents/agent-types.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { ConversationViewer } from "./ui/conversation-viewer.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { registerAgentTool } from "./registration.js";
import {
  getManager,
  getWidget,
  getCoordinator,
  getStore,
  setSessionCtx,
  setManager,
  setWidget,
  setCoordinator,
} from "./shell.js";

// --- Config loader — session_start handler logic ---

/** Idempotent — safe to call on every session_start. */
export function ensureManagerAndWidget(): void {
  const currentManager = getManager();
  const currentWidget = getWidget();

  if (!currentManager) {
    // Coordinator needs the manager, so wire onComplete after creating it.
    const newManager = new AgentManager(
      undefined,
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
      undefined,
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    newManager.setOnComplete((record) => {
      coordinator.onAgentComplete(record);
      getWidget()?.update();
    });
  }

  if (!currentWidget) {
    const newWidget = new AgentWidget(getManager()!, (id: string) => getCoordinator()?.liveView(id));
    setWidget(newWidget);
    // Sync widget as config side-effect target — setDeps re-syncs all display settings from config.
    getStore().setDeps({ widget: newWidget });
  }
}

export async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const agentDir = getAgentDir();
  const userAgentDir = path.join(agentDir, "agents");
  const projectTrusted = ctx.isProjectTrusted();
  const sharedAgentDir = projectTrusted ? path.join(ctx.cwd, ".agents", "agents") : "";
  const projectAgentDir = projectTrusted ? path.join(ctx.cwd, ".pi", "agents") : "";

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;

  const merged = await scanAndMerge({ disableDefaultAgents: disableDefaults });

  registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

export async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // Project config (.pi/subagents-lite.json) loads only in trusted projects,
  // mirroring the .pi/agents scan-dir gate in scanAndRegisterAgents.
  const projectDir = ctx.isProjectTrusted() ? path.join(ctx.cwd, ".pi") : undefined;
  getStore().setProjectDir(projectDir);
  // ConfigStore is authoritative for config + session overrides + widget/manager
  // side effects.
  getStore().reload();
  ensureManagerAndWidget();
  await scanAndRegisterAgents(ctx);
}

// --- Event listener setup ---

/** Open the viewer overlay; the viewerOpen flag prevents nav deactivation while open. */
async function openViewer(ctx: ExtensionContext, record: AgentRecord | null): Promise<void> {
  if (!record) return;
  if (!record.execution?.session) return;
  const widget = getWidget();
  if (!widget) return;
  const manager = getManager();

  try {
    widget.setViewerOpen(true);

    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      const viewer = new ConversationViewer(
        tui,
        record.execution.session!,
        record,
        theme,
        done,
        () => manager?.abort(record.id, "user"),
        kb,
        (msg: string) => manager?.steer(record.id, msg),
      );
      viewer.setModelDisplayStyle(getStore().agent.modelDisplayStyle);
      return viewer;
    });
  } finally {
    widget.setViewerOpen(false);
  }
}

type InputListenerResult = { consume: true } | undefined;

/** Exposed for tests to drive the real handler with a stubbed ctx. */
export function createNavInputHandler(ctx: ExtensionContext): (data: string) => InputListenerResult {
  return (data: string) => {
    const widget = getWidget();

    // Only fire on key press (not release).
    if (isKeyRelease(data)) return undefined;

    // Viewer overlay open — don't consume, don't deactivate.
    if (widget?.isViewerOpen()) {
      return undefined;
    }

    // Editor lost focus (dialog, menu, etc.) — deactivate.
    if (widget && !widget.isEditorFocused()) {
      if (widget.isNavActive()) widget.navDeactivate();
      return undefined;
    }

    if (widget) {
      if (!widget.isNavActive()) {
        // ↓ + empty editor + visible agents exist → activate
        const editorEmpty = (ctx.ui as any).getEditorText?.() === "";
        if (matchesKey(data, "down") && widget.hasVisibleAgents() && editorEmpty) {
          widget.navActivate();
          return { consume: true };
        }
      } else {
        if (matchesKey(data, "down")) {
          widget.navDown();
          return { consume: true };
        }
        if (matchesKey(data, "up")) {
          widget.navUp();
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          widget.navDeactivate();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          const record = widget.navSelect();
          openViewer(ctx, record).catch((err) => {
            ctx.ui.notify(`Failed to open agent viewer: ${String(err)}`, "error");
          });
          return { consume: true };
        }
        // Any other key → deactivate, pass through.
        widget.navDeactivate();
      }
    }

    // ctrl+o toggles tool expansion — sync compact mode with the new state.
    // Not consumed: pi's built-in handler owns the actual toggle.
    if (matchesKey(data, "ctrl+o")) {
      // Read state after a tick so the built-in handler applies the toggle first.
      setTimeout(() => {
        const ui = ctx.ui as unknown as { getToolsExpanded?: () => boolean };
        const expanded = ui.getToolsExpanded?.();
        if (expanded !== undefined) {
          getStore().notifyToolsExpanded(expanded);
        }
      }, 0);
    }

    return undefined; // Don't consume the input
  };
}

export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  pi.on("turn_start", async (_event, ctx) => {
    // Set UI context on first turn
    if (!getWidget()) {
      ensureManagerAndWidget();
    }
    getWidget()?.setUICtx(ctx.ui as unknown as UICtx);
  });

  let unregisterTerminalInput: (() => void) | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadConfigAndRegisterAgents(ctx);
    // Re-register with updated agent type list (now includes user/project agents)
    registerAgentTool(pi);
    // ctrl+o syncs compact mode with tool expansion (push-based, no polling)
    if (ctx.hasUI && !unregisterTerminalInput) {
      unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
    }
    // Sync compact mode with initial tool expansion state
    getStore().notifyToolsExpanded(false);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const currentManager = getManager();
    if (currentManager) {
      const records = currentManager.listAgents();
      const active = records.filter((r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued");
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
