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
 *   - Module-level __config cache; tool_call reads from cache
 *   - Config mutations update cache + atomic write to disk
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
import type { SessionModelOverrides, SubagentsConfig } from "./model-precedence.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { registerAgents, getAvailableTypes, setAgentScanDirs } from "./agent-types.js";
import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { AgentManager } from "./agent-manager.js";
import { AgentWidget, type AgentActivity, type UICtx } from "./ui/agent-widget.js";
import { showAgentsMainMenu } from "./menus.js";
import { loadConfig, DEFAULT_CONFIG } from "./config-io.js";
import { executeAgentTool, toolCallListener, backgroundAgentIds, scheduleNudge } from "./tool-execution.js";
import { executeStopAgentTool } from "./stop-agent-tool.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./renderer.js";

// ============================================================================
// Module-level state
// ============================================================================

/** Session-only model overrides — not persisted, cleared on session_start. */
export let sessionOverrides: SessionModelOverrides = { default: null };

/** Config cache — loaded at session_start, updated by /agents menu mutations. */
export let __config: SubagentsConfig = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent }, concurrency: { ...DEFAULT_CONFIG.concurrency } };

/** Agent manager singleton — module-level, no globalThis access. */
export let manager: AgentManager;

/** Live activity state per agent, keyed by agent ID. Read by AgentWidget and tool-execution. */
export const agentActivity = new Map<string, AgentActivity>();

/** Live TUI widget showing running/completed agents above the editor. Used by tool-execution. */
export let widget: AgentWidget | undefined;

/** ExtensionAPI reference — stored at init for execute callbacks. */
export let piInstance: ExtensionAPI;

/** Update the cost display toggle in config and sync to widget. */
export function setShowCostEnabled(enabled: boolean): void {
  __config.agent.showCost = enabled;
  widget?.setShowCost(enabled);
}

/** Sync widget display settings from config to the widget instance. */
export function syncWidgetSettings(): void {
  if (!widget) return;
  widget.setForceCompact(__config.agent.widgetCompact === true);
  widget.setWidgetShortcut(__config.agent.widgetShortcut === true);
  widget.setMaxLines(__config.agent.widgetMaxLines ?? 12);
  widget.setMaxLinesCompact(
    __config.agent.widgetMaxLinesCompact ?? Math.floor((__config.agent.widgetMaxLines ?? 12) / 2),
  );
}

/** Track previous tool expansion state to detect ctrl+o toggle. */
let lastToolsExpanded: boolean | undefined;

/** Sync compact mode with the tool expansion state (ctrl+o toggle).
 *  Only syncs when widgetShortcut is enabled in config (opt-in behavior).
 *  Only triggers on state change (not every tool_execution_start).
 *  When forceCompact (widgetCompact) is ON, ignores ctrl+o state changes.
 */
export function syncCompactFromToolsExpanded(expanded: boolean): void {
  if (__config.agent.widgetShortcut !== true) {
    lastToolsExpanded = expanded;
    return;
  }
  // When forceCompact is ON, ignore ctrl+o state changes
  if (__config.agent.widgetCompact === true) {
    lastToolsExpanded = expanded;
    return;
  }
  // Tools expanded → widget full, tools collapsed → widget compact
  if (lastToolsExpanded !== undefined && lastToolsExpanded !== expanded) {
    widget?.setCompactMode(!expanded);
  }
  lastToolsExpanded = expanded;
}



// ============================================================================
// Config loader — session_start handler logic
// ============================================================================

/**
 * Ensure the manager and widget singletons exist.
 * Idempotent — safe to call on every session_start.
 */
function ensureManagerAndWidget(): void {
  if (manager) return;

  manager = new AgentManager(
    (record) => {
      // Only nudge for background (async) agents — sync agents already returned via tool result
      if (backgroundAgentIds.has(record.id)) {
        scheduleNudge(record.id);
        backgroundAgentIds.delete(record.id);
      }

      // Mark finished and update widget BEFORE deleting activity —
      // renderFinishedLine reads activity for turn count, tokens, etc.
      widget?.markFinished(record.id);
      widget?.update();

      // Remove from live activity tracking
      agentActivity.delete(record.id);
    },
    __config.concurrency,
  );

  // Create/replace widget tied to this manager instance
  if (!widget) {
    widget = new AgentWidget(manager, agentActivity);
    widget.setShowCost(__config.agent.showCost === true);
    syncWidgetSettings();
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
  __config = loadConfig();
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
      description: Type.String(),
      agent: agentParam,
      run_in_background: Type.Optional(Type.Boolean()),

    }),
    execute: executeAgentTool,

    renderCall: (args, theme) => renderAgentToolCall(args as Record<string, unknown>, theme),

    renderResult: (result, options, theme) => renderAgentToolResult(
      result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
      options as { expanded?: boolean },
      theme,
    ),
  });
}

// ============================================================================
// Extension factory
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Store pi for execute callbacks
  piInstance = pi;

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

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) =>
    renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
    ),
  );

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
    if (!widget) {
      ensureManagerAndWidget();
    }
    widget?.setUICtx(ctx.ui as unknown as UICtx);
    widget?.onTurnStart();
  });



  // session_start — load config, scan agents, register into registry,
  // then re-register Agent tool with dynamic agent type enum
  // Listen for ctrl+o keypress to sync compact mode (push-based, no polling)
  let unregisterTerminalInput: (() => void) | undefined;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    sessionOverrides = { default: null };
    agentActivity.clear();
    lastToolsExpanded = undefined;
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
              widget?.notifyToolsExpansionChanged(expanded);
            }
          }, 0);
        }
        return undefined; // Don't consume the input
      });
    }
    // Sync compact mode with initial tool expansion state
    syncCompactFromToolsExpanded(false);
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    // Warn if agents were killed
    if (manager) {
      const records = manager.listAgents();
      const active = records.filter(r => r.status === "running" || r.status === "queued");
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`${active.length} agent(s) killed by reload`, "warning");
      }
    }
    widget?.dispose();
    widget = undefined;
    if (manager) {
      await manager.dispose();
      manager = undefined as any;
    }
  });
}
