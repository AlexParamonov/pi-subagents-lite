/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers tools, commands, and event listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - No description, no promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Model parameter removed from schema — injected via tool_call listener
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lite.json at session_start
 *   - ConfigStore owns config + session overrides + persistence + side effects
 *   - Tool execution and menus read/write through store
 *
 * Commands:
 *   - /agents: Management menu (model settings, concurrency, running agents, debug)
 *
 * Events:
 *   - tool_call: Inject model into Agent tool calls
 *   - session_start: Load config, register agents, initialise manager
 *   - session_shutdown: Abort all, dispose manager
 */

import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./agents/default-agents.js";
import { registerAgents, getAvailableTypes, setAgentScanDirs } from "./agents/agent-types.js";
import { scanAgentFilesInDir, mergeAgents } from "./agents/agent-discovery.js";
import { AgentManager } from "./agents/agent-manager.js";
import { AgentWidget, type UICtx } from "./ui/agent-widget.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { executeAgentTool, executeStopAgentTool, toolCallListener } from "./tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import {
  getPiInstance,
  getManager,
  getWidget,
  getCoordinator,
  getStore,
  setPiInstance,
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
function ensureManagerAndWidget(): void {
  const currentManager = getManager();
  const currentWidget = getWidget();

  // Create manager if missing
  if (!currentManager) {
    // Coordinator will be created after manager, so use a placeholder onComplete
    // that we'll replace once coordinator is created.
    const newManager = new AgentManager(
      undefined, // onComplete wired below
      getStore().concurrency as unknown as ConstructorParameters<typeof AgentManager>[1],
    );
    setManager(newManager);
    // Sync the manager as a config side-effect target (concurrency setters call setConcurrency).
    getStore().setDeps({ manager: newManager });

    // Now create coordinator with the real manager
    const coordinator = new SpawnCoordinator(newManager, getPiInstance());
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
 * Scan agent files from user and project directories, merge with defaults,
 * and register into the type registry.
 */
async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const homeDir = process.env.HOME || "";
  const userAgentDir = path.join(homeDir, ".pi", "agent", "agents");
  const projectAgentDir = path.join(ctx.cwd, ".pi", "agents");

  // Store scan dirs for on-demand discovery (agents added during the session)
  setAgentScanDirs(userAgentDir, projectAgentDir);

  const [userAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);

  // Merge with defaults
  const merged = mergeAgents(DEFAULT_AGENTS, userAgents, projectAgents);

  // Register into the type registry
  registerAgents(merged);
}

async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // ConfigStore is authoritative for config + session overrides + widget/manager
  // side effects.
  getStore().reload();
  ensureManagerAndWidget();
  await scanAndRegisterAgents(ctx);
}



// ============================================================================
// Agent tool registration helper — dynamic enum for agent types
// ============================================================================

/**
 * Register (or re-register) the Agent tool with current agent types.
 * At init time only defaults exist; call again from session_start after
 * user/project agents are loaded to update the enum.
 */
function registerAgentTool(pi: ExtensionAPI): void {
  const types = getAvailableTypes();
  // Use plain string to avoid verbose anyOf in prompt.
  // Available types are listed in description for discoverability.
  const agentParam = types.length > 0
    ? Type.Optional(Type.String({ description: types.join(",") }))
    : Type.Optional(Type.String());
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: agentParam,
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }),
    execute: executeAgentTool,

    renderCall: (args, theme) => renderAgentToolCall(args as Record<string, unknown>, theme),

    renderResult: (result, options, theme) => {
      const showCost = getStore().agent.showCost;
      return renderAgentToolResult(
        result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
        options as { expanded?: boolean },
        theme,
        showCost,
      );
    },
  });
}

// ============================================================================
// Extension factory
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Store pi for execute callbacks
  setPiInstance(pi);

  // ========================================================================
  // Tool registration (stealth schemas — at init time)
  // ========================================================================

  // Agent tool — stealth schema with dynamic agent type enum
  registerAgentTool(pi);

  // StopAgent tool — stealth schema, stop a running agent by ID
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }),
    execute: executeStopAgentTool,
  });

  // AgentStatus tool — stealth schema, list all agents and their statuses
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({}),
    execute: executeAgentStatusTool,
  });

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const showCost = getStore().agent.showCost;
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      showCost,
    );
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const modelOptions = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });

  // Event listeners
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
      unregisterTerminalInput = ctx.ui.onTerminalInput((data: string) => {
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
      });
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
