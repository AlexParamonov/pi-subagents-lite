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

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
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
import { AgentWidget, buildStatsParts, formatMs, getDisplayName, type AgentActivity, type Theme, type UICtx } from "./ui/agent-widget.js";
import { showAgentsMainMenu } from "./menus.js";
import { loadConfig, DEFAULT_CONFIG } from "./config-io.js";
import { executeAgentTool, toolCallListener, backgroundAgentIds, scheduleNudge } from "./tool-execution.js";
import { executeStopAgentTool } from "./stop-agent-tool.js";

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
// UI helpers — stats card rendering (shared by renderResult and message renderer)
// ============================================================================

/** Format agent display name with optional model: "Agent (mimo-v2.5-pro)" or "Agent". */
function agentNameLabel(d: Record<string, unknown>, theme: Theme): string {
  const typeName = getDisplayName((d.type as string) || "");
  const modelName = d.modelName as string | undefined;
  return modelName ? `${theme.bold(typeName)} (${modelName})` : theme.bold(typeName);
}

/** Build the stats line for an agent result card. Used by both renderers. */
function buildStatsLine(d: Record<string, unknown>, theme: Theme): string {
  const parts = buildStatsParts({
    toolUses: (d.toolUses as number) ?? 0,
    turnCount: d.turnCount as number | undefined,
    maxTurns: d.maxTurns as number | undefined,
    tokens: (d.tokens as number) ?? 0,
    contextPercent: d.contextPercent as number | null,
    compactions: (d.compactions as number) ?? 0,
  }, theme);
  parts.push(formatMs(d.durationMs as number));
  return parts.join("·");
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

    renderCall(args, theme) {
      const typeName = getDisplayName((args.agent as string) || "");
      const label = typeName || "Agent";
      let text = `▸ ${theme.fg("accent", theme.bold(label))}`;

      // Show model in parens when it differs from the parent model
      // _modelOverride is injected by toolCallListener when the resolved
      // model differs from the session's parent model
      const a = args as Record<string, unknown>;
      const modelOverride = a._modelOverride as string | undefined;
      if (modelOverride) {
        text += ` (${modelOverride})`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const { expanded } = options as { expanded?: boolean };
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const d = result.details as Record<string, unknown> | undefined;
      const isError = !!(result as any).isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const desc = (d?.description as string) || "";

      if (d && d.turnCount != null) {
        const namePart = agentNameLabel(d, theme);
        const statsLine = buildStatsLine(d, theme);
        let lines = `${icon} ${namePart}·${statsLine}\n  ${theme.fg("text", desc)}`;
        if (expanded && text) {
          lines += "\n" + text.split("\n").map(l => `  ${l}`).join("\n");
        }
        return new Text(lines, 0, 0);
      }

      // Minimal card — type name already shown by renderCall
      // For background spawns (no stats), use space placeholder — agent isn't done yet
      const isBackground = text.includes("running in background") || text.includes("queued");
      const prefix = isBackground ? "  " : `${icon} `;
      if (desc) {
        return new Text(`${prefix}${theme.fg("text", desc)}`, 0, 0);
      }

      return new Text(`${prefix}${theme.fg("dim", text)}`, 0, 0);
    },
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
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const { expanded } = options as { expanded?: boolean };
    const d = message.details as Record<string, unknown> | undefined;
    const text = (message.content as string)?.trim() || "";

    const inner = new Container();
    inner.addChild(new Text(theme.fg("customMessageLabel", "Subagent Result"), 0, 0));
    inner.addChild(new Spacer(1));

    if (d && d.turnCount != null) {
      const isError = d.status === "error" || d.status === "aborted" || d.status === "stopped";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const desc = (d.description as string) || "";

      const namePart = agentNameLabel(d, theme);
      const statsLine = buildStatsLine(d, theme);
      let headerLine = `${icon} ${namePart}·${statsLine}\n  ${theme.fg("text", desc)}`;
      if ((d.outputFile as string)) {
        headerLine += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
      }
      inner.addChild(new Text(headerLine, 0, 0));

      if (expanded && text) {
        inner.addChild(new Spacer(1));
        const resultLines = text.split("\n").map(l => `  ${l}`).join("\n");
        inner.addChild(new Text(resultLines, 0, 0));
      }
    } else {
      const desc = (d?.description as string) || "";
      let line = `${theme.fg("success", "✓")}`;
      if (d?.type) {
        line += ` ${agentNameLabel(d, theme)}`;
      }
      if (desc) line += `\n  ${theme.fg("text", desc)}`;
      if (d?.outputFile) {
        line += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
      }
      inner.addChild(new Text(line, 0, 0));
    }

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(inner);

    const outer = new Container();
    outer.addChild(new Spacer(1));
    outer.addChild(box);
    outer.addChild(new Spacer(1));
    return outer;
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
    widget?.setUICtx(ctx.ui as unknown as UICtx);
    widget?.onTurnStart();
  });

  // session_start — load config, scan agents, register into registry,
  // then re-register Agent tool with dynamic agent type enum
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    sessionOverrides = { default: null };
    agentActivity.clear();
    await loadConfigAndRegisterAgents(ctx);
    // Re-register with updated agent type list (now includes user/project agents)
    registerAgentTool(pi);
  });

  pi.on("session_shutdown", async (_event: unknown) => {
    widget?.dispose();
    widget = undefined;
    if (manager) {
      await manager.dispose();
    }
  });
}
