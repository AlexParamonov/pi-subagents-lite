/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers tools, commands, and event listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - description: "." (single character — tells LLM nothing)
 *   - No promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Model parameter removed from schema — injected via tool_call listener
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lite.json at session_start
 *   - Module-level __config cache; tool_call reads from cache
 *   - Config mutations update cache + atomic write to disk
 *   - Migrates subagent-model-defaults.json on first load
 *
 * Commands:
 *   - /agents: Management menu with 5 sub-menus
 *
 * Events:
 *   - tool_call: Inject model into Agent tool calls
 *   - session_start: Load config, register agents, initialise manager
 *   - session_shutdown: Abort all, dispose manager
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { SubagentsConfig } from "./model-precedence.js";
import { resolveModel } from "./model-precedence.js";
import { resolveType, getAgentConfig, registerAgents, getAvailableTypes, getAllTypes } from "./agent-types.js";
import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { steerAgent } from "./agent-runner.js";
import type { AgentRecord, ThinkingLevel } from "./types.js";
import { ModelSelectorDialog, type ModelOption } from "./model-selector.js";
import { ResultViewer } from "./result-viewer.js";
import { AgentManager } from "./agent-manager.js";
import type { SpawnOptions as AgentManagerSpawnOptions } from "./agent-manager.js";
import { AgentWidget, formatTurns, formatMs, formatSessionTokens, getDisplayName, type AgentActivity, type UICtx } from "./ui/agent-widget.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.js";

// ============================================================================
// Constants
// ============================================================================

const CONFIG_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");
// ============================================================================
// Module-level state
// ============================================================================

/** Config cache — loaded at session_start, updated by /agents menu mutations. */
let __config: SubagentsConfig = {
  agent: { default: null },
  concurrency: { default: 4 },
};

/** Agent manager singleton — module-level, no globalThis access. */
let manager: AgentManager;

/** Live activity state per agent, keyed by agent ID. Read by AgentWidget for rendering. */
const agentActivity = new Map<string, AgentActivity>();

/** Live TUI widget showing running/completed agents above the editor. */
let widget: AgentWidget | undefined;

/** ExtensionAPI reference — stored at init for execute callbacks. */
let piInstance: ExtensionAPI;

// ============================================================================
// Nudge scheduling (200ms hold to batch completion notifications)
// ============================================================================

const pendingNudges = new Set<string>();
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNudge(agentId: string, record: AgentRecord): void {
  pendingNudges.add(agentId);

  if (nudgeTimer) return;

  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    const batch = [...pendingNudges];
    pendingNudges.clear();

    for (const id of batch) {
      emitIndividualNudge(id, manager?.getRecord(id));
    }
  }, 200);
}

function emitIndividualNudge(agentId: string, record?: AgentRecord): void {
  if (!record) return;

  // Stats go in details only (rendered by the UI message renderer).
  // Content is just the result text — the model only sees this.
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const elapsedMs = record.completedAt
    ? record.completedAt - record.startedAt
    : 0;

  const details: Record<string, unknown> = {
    type: record.type,
    description: record.description,
    status: record.status,
    outputFile: record.outputFile,
    turnCount: record.turnCount ?? agentActivity.get(agentId)?.turnCount,
    maxTurns: record.maxTurns,
    toolUses: record.toolUses,
    tokens: totalTokens,
    contextPercent: getSessionContextPercent(record.session),
    durationMs: elapsedMs,
    compactions: record.compactionCount,
  };

  // Deliver the result directly to the session so the model sees it.
  piInstance.sendMessage(
    {
      customType: "subagent-result",
      content: record.result ?? "",
      details,
      display: true,
    },
    {
      deliverAs: "steer",
      triggerTurn: true,
    },
  );
}

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a "provider/model-id" string into { provider, modelId }.
 * Returns null if the format is invalid.
 */
function parseModelKey(modelStr: string): { provider: string; modelId: string } | null {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx <= 0) return null;
  return { provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
}

/**
 * Build ModelOption[] from raw "provider/model-id" strings.
 * Includes "(inherits parent)" as the first option.
 */
function buildModelOptions(rawOptions: string[]): ModelOption[] {
  const items: ModelOption[] = [
    { value: "(inherits parent)", label: "(inherits parent)", provider: "" },
  ];

  for (const opt of rawOptions) {
    const parsed = parseModelKey(opt);
    if (!parsed) continue;
    items.push({ value: opt, label: parsed.modelId, provider: parsed.provider });
  }
  return items;
}

// ============================================================================
// Config persistence (atomic writes)
// ============================================================================

function loadConfig(): SubagentsConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as SubagentsConfig;
  } catch {
    // File doesn't exist or is invalid — return defaults
  }

  return {
    agent: { default: null },
    concurrency: { default: 4 },
  };
}

function saveConfigAtomic(config: SubagentsConfig): void {
  const tmpPath = CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${err}`);
  }
}

/**
 * Show the ModelSelectorDialog and return the chosen model string, or null.
 */
async function promptModelSelection(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
  currentValue: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const opts = buildModelOptions(modelOptions);
      return new ModelSelectorDialog(opts, currentValue, {
        onSelect: (m) => done(m),
        onCancel: () => done(null),
      }, theme);
    }, // no overlay — renders inline below editor, matching pi's model selector look and feel
  );
}

/**
 * Show a select menu and dispatch the chosen action.
 * Pattern used by model settings, concurrency settings, and running agents menus.
 */
async function runMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[],
  actions: Array<() => Promise<void>>,
): Promise<void> {
  const choice = await ctx.ui.select(title, items);
  if (choice === undefined) return;
  const idx = items.indexOf(choice);
  if (idx >= 0 && idx < actions.length) {
    await actions[idx]();
  }
}

// ============================================================================
// /agents command handler
// ============================================================================

async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Model settings — Set global default and per-type model overrides",
    "2. Concurrency settings — Set per-model slot limits",
    "3. Running agents — List running/queued agents",
    "4. Agent types — List available agent types and their configs",
    "5. Agent briefing — Send agent types/capabilities info to LLM (Optional, if having issues)",
    "",
    "Press Escape to close",
  ];

  // Loop so sub-menus navigate back to root; only Escape at root closes
  while (true) {
    const choice = await ctx.ui.select("Subagents Management", menuItems);
    if (choice === undefined || choice === "Press Escape to close") return;

    if (choice.startsWith("1.")) {
      await showModelSettingsMenu(ctx, modelOptions);
    } else if (choice.startsWith("2.")) {
      await showConcurrencySettingsMenu(ctx, modelOptions);
    } else if (choice.startsWith("3.")) {
      await showRunningAgentsMenu(ctx);
    } else if (choice.startsWith("4.")) {
      await showAgentTypes(ctx);
    } else if (choice.startsWith("5.")) {
      await handleAgentBriefing(ctx);
    }
  }
}

async function handleAgentBriefing(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAvailableTypes();
  const agents = types.map((t) => ({ name: t, config: getAgentConfig(t) }));

  const lines: string[] = [
    "# Agent Types and Capabilities\n",
    "The following agent types are available. Use the `agent` parameter to select one.\n",
  ];

  for (const { name, config } of agents) {
    if (!config) continue;
    lines.push(`## ${config.displayName ?? name}`);
    lines.push(config.description);
    lines.push("");

    if (config.builtinToolNames) {
      lines.push(`**Tools:** ${config.builtinToolNames.join(", ")}`);
    }
    if (config.model) {
      lines.push(`**Default model:** ${config.model}`);
    }
    if (config.maxTurns) {
      lines.push(`**Max turns:** ${config.maxTurns}`);
    }
    lines.push("");
  }

  // Parameter descriptions
  lines.push("## Agent Tool Parameters\n");
  lines.push("| Parameter | Description |");
  lines.push("|-----------|-------------|");
  lines.push("| `prompt` | The task for the agent (required) |");
  lines.push("| `description` | One-line summary of what the agent should do (required) |");
  lines.push("| `agent` | Which agent type to use (default: general-purpose) |");
  lines.push("| `thinking` | Optional thinking mode override (e.g., `high`, `medium`, `low`, `off`) |");
  lines.push("| `run_in_background` | When `true`, result is auto-delivered — do NOT poll. Continue working while waiting. |");
  lines.push("| `resume` | Agent ID to resume from; when set, `prompt` is appended to the previous conversation |");
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, the result will arrive when ready");
  lines.push("- Use `resume` to continue an incomplete agent's conversation");
  piInstance.sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

async function showModelSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Loop so actions stay in this menu; only Back/Escape leaves
  while (true) {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    // Global default
    const globalLabel = __config.agent.default
      ? `Global default model · ${__config.agent.default}`
      : "Global default model · (inherits parent)";
    items.push(globalLabel);
    actions.push(async () => {
      const chosen = await promptModelSelection(
        ctx, modelOptions, __config.agent.default ?? "(inherits parent)",
      );
      if (chosen === null) return;

      const updated = { ...__config };
      updated.agent = { ...updated.agent };
      updated.agent.default = chosen === "(inherits parent)" ? null : chosen;
      __config = updated;
      saveConfigAtomic(updated);
      ctx.ui.notify(
        chosen === "(inherits parent)"
          ? "Global default cleared — agents inherit parent model"
          : `Global default model set to ${chosen}`,
        "info",
      );
    });

    items.push("─── per-type overrides ───");
    actions.push(async () => {}); // separator

    // Per-type overrides
    const types = getAllTypes();
    for (const typeName of types) {
      const cfg = getAgentConfig(typeName);
      const currentOverride = __config.agent[typeName];
      const displayModel = currentOverride
        ? currentOverride
        : (cfg?.model ?? __config.agent.default ?? "(inherits parent)");
      const frontmatterHint = currentOverride && cfg?.model ? ` → ${cfg.model}` : "";
      items.push(`${typeName}  ·  ${displayModel}${frontmatterHint}`);

      actions.push(async () => {
        const currentDisplay = __config.agent[typeName] ?? cfg?.model ?? __config.agent.default ?? "(inherits parent)";
        const chosen = await promptModelSelection(ctx, modelOptions, currentDisplay);
        if (chosen === null) return;

        const updated = { ...__config };
        updated.agent = { ...updated.agent };
        updated.agent[typeName] = chosen === "(inherits parent)" ? null : chosen;
        __config = updated;
        saveConfigAtomic(updated);
        ctx.ui.notify(
          chosen === "(inherits parent)"
            ? `${typeName} inherits parent model`
            : `${typeName} model set to ${chosen}`,
          "info",
        );
      });
    }

    // Clear all overrides
    items.push("Clear all overrides");
    actions.push(async () => {
      const hasOverrides = Object.entries(__config.agent).some(
        ([k, v]) => k !== "default" && v != null,
      );
      if (!hasOverrides && __config.agent.default === null) {
        ctx.ui.notify("No overrides to clear", "info");
        return;
      }
      const updated = { ...__config };
      updated.agent = { default: __config.agent.default };
      __config = updated;
      saveConfigAtomic(updated);
      ctx.ui.notify("All model overrides cleared", "info");
    });

    // Append blank spacer + "Back" as the last items
    items.push("");
    actions.push(async () => {});
    items.push("Back");
    actions.push(async () => {});

    const choice = await ctx.ui.select("Model Settings", items);
    if (choice === undefined || choice === "Back") return;
    const idx = items.indexOf(choice);
    if (idx >= 0 && idx < actions.length) {
      await actions[idx]();
    }
  }
}

async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Loop so actions stay in this menu; only Back/Escape leaves
  while (true) {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    // Global default
    items.push(`Default concurrency limit · ${__config.concurrency.default}`);
    actions.push(async () => {
      const input = await ctx.ui.input(
        "Default concurrency limit",
        String(__config.concurrency.default),
      );
      if (input === undefined) return;
      const parsed = parseInt(input.trim(), 10);
      if (isNaN(parsed) || parsed < 1) {
        ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
        return;
      }
      const updated = { ...__config };
      updated.concurrency = { ...updated.concurrency, default: parsed };
      __config = updated;
      saveConfigAtomic(updated);
      ctx.ui.notify(`Default concurrency limit set to ${parsed}`, "info");
      manager?.setConcurrency({
        default: __config.concurrency.default,
        providers: __config.concurrency.providers ?? {},
        models: __config.concurrency.models ?? {},
      });
    });

    // Extract unique providers from model options
    const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();

    // Per-provider limits
    const providerLimits = __config.concurrency.providers ?? {};
    const configuredProviders = Object.keys(providerLimits);
    if (configuredProviders.length > 0) {
      items.push("─── per-provider limits ───");
      actions.push(async () => {}); // separator

      for (const provider of configuredProviders) {
        items.push(`${provider}  ·  ${providerLimits[provider]} slots`);
        actions.push(async () => {
          const input = await ctx.ui.input(
            `Concurrency slots for ${provider}`,
            String(providerLimits[provider]),
          );
          if (input === undefined) return;
          const parsed = parseInt(input.trim(), 10);
          if (isNaN(parsed) || parsed < 1) {
            ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
            return;
          }
          const updated = { ...__config };
          updated.concurrency.providers = { ...providerLimits, [provider]: parsed };
          __config = updated;
          saveConfigAtomic(updated);
          ctx.ui.notify(`${provider} concurrency set to ${parsed}`, "info");
          manager?.setConcurrency({
            default: __config.concurrency.default,
            providers: __config.concurrency.providers ?? {},
            models: __config.concurrency.models ?? {},
          });
        });
      }
    }

    // Add per-provider limit
    items.push("Add per-provider limit...");
    actions.push(async () => {
      const currentProviders = __config.concurrency.providers ?? {};
      const provider = await ctx.ui.select("Select provider", providers);
      if (provider === undefined) return;
      const input = await ctx.ui.input("Concurrency slots", "1");
      if (input === undefined) return;
      const parsed = parseInt(input.trim(), 10);
      if (isNaN(parsed) || parsed < 1) {
        ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
        return;
      }
      const updated = { ...__config };
      updated.concurrency.providers = { ...currentProviders, [provider]: parsed };
      __config = updated;
      saveConfigAtomic(updated);
      ctx.ui.notify(`${provider} concurrency set to ${parsed}`, "info");
      manager?.setConcurrency({
        default: __config.concurrency.default,
        providers: __config.concurrency.providers ?? {},
        models: __config.concurrency.models ?? {},
      });
    });

    // Per-model limits
    const models = __config.concurrency.models ?? {};
    const modelKeys = Object.keys(models);
    if (modelKeys.length > 0) {
      items.push("─── per-model limits ───");
      actions.push(async () => {}); // separator

      for (const modelKey of modelKeys) {
        items.push(`${modelKey}  ·  ${models[modelKey]} slots`);
        actions.push(async () => {
          const input = await ctx.ui.input(
            `Concurrency slots for ${modelKey}`,
            String(models[modelKey]),
          );
          if (input === undefined) return;
          const parsed = parseInt(input.trim(), 10);
          if (isNaN(parsed) || parsed < 1) {
            ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
            return;
          }
          const updated = { ...__config };
          updated.concurrency.models = { ...models, [modelKey]: parsed };
          __config = updated;
          saveConfigAtomic(updated);
          ctx.ui.notify(`${modelKey} concurrency set to ${parsed}`, "info");
          manager?.setConcurrency({
            default: __config.concurrency.default,
            providers: __config.concurrency.providers ?? {},
            models: __config.concurrency.models ?? {},
          });
        });
      }
    }

    // Add per-model limit
    items.push("Add per-model limit...");
    actions.push(async () => {
      const currentModels = __config.concurrency.models ?? {};
      const modelKey = await promptModelSelection(
        ctx,
        modelOptions,
        __config.agent.default ?? "(inherits parent)",
      );
      if (modelKey === null) return;
      const input = await ctx.ui.input("Concurrency slots", "1");
      if (input === undefined) return;
      const parsed = parseInt(input.trim(), 10);
      if (isNaN(parsed) || parsed < 1) {
        ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
        return;
      }
      const updated = { ...__config };
      updated.concurrency.models = { ...currentModels, [modelKey.trim()]: parsed };
      __config = updated;
      saveConfigAtomic(updated);
      ctx.ui.notify(`${modelKey.trim()} concurrency set to ${parsed}`, "info");
      manager?.setConcurrency({
        default: __config.concurrency.default,
        providers: __config.concurrency.providers ?? {},
        models: __config.concurrency.models ?? {},
      });
    });

    // Append blank spacer + "Back" as the last items
    items.push("");
    actions.push(async () => {});
    items.push("Back");
    actions.push(async () => {});

    const choice = await ctx.ui.select("Concurrency Settings", items);
    if (choice === undefined || choice === "Back") return;
    const idx = items.indexOf(choice);
    if (idx >= 0 && idx < actions.length) {
      await actions[idx]();
    }
  }
}

async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Loop so sub-actions navigate back to this menu; only Escape closes
  while (true) {
    const records = manager?.listAgents() ?? [];
    const running = records.filter((r) => r.status === "running" || r.status === "queued");

    if (records.length === 0) {
      ctx.ui.notify("No agents have been spawned this session", "info");
      return;
    }

    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    for (const record of records) {
      const elapsed = Math.round((Date.now() - record.startedAt) / 1000);
      const statusIcon = record.status === "running" ? "▶" :
        record.status === "completed" ? "✓" :
        record.status === "queued" ? "⏳" :
        record.status === "error" ? "✗" : "•";
      items.push(
        `${statusIcon} ${record.id.slice(0, 8)}  ${record.type}  ${record.status}  ${elapsed}s`,
      );

      actions.push(async () => {
        await showAgentActions(ctx, record);
      });
    }

    if (running.length > 0) {
      items.push("─── actions ───");
      actions.push(async () => {}); // separator

      items.push(`Stop ${running.length} running agent(s)`);
      actions.push(async () => {
        for (const record of running) {
          manager?.abort(record.id);
        }
        ctx.ui.notify(`Stopped ${running.length} agent(s)`, "info");
      });
    }

    // Append blank spacer + "Back" as the last items
    items.push("");
    actions.push(async () => {});
    items.push("Back");
    actions.push(async () => {});

    const choice = await ctx.ui.select("Running Agents", items);
    if (choice === undefined || choice === "Back") return;
    const idx = items.indexOf(choice);
    if (idx >= 0 && idx < actions.length) {
      await actions[idx]();
    }
  }
}

/**
 * Send a steer message to a specific agent. Used by the per-agent action menu.
 */
async function steerAgentById(
  agentId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const record = manager?.getRecord(agentId);
  if (!record) {
    ctx.ui.notify("Agent not found", "error");
    return;
  }

  const message = await ctx.ui.input(`Steer ${record.type}`);
  if (!message?.trim()) return;

  try {
    if (!record.session) {
      if (!record.pendingSteers) {
        record.pendingSteers = [];
      }
      record.pendingSteers.push(message.trim());
      ctx.ui.notify(`Steer message queued for ${record.id.slice(0, 8)}…`, "info");
    } else {
      await steerAgent(record.session, message.trim());
      ctx.ui.notify(`Steer sent to ${record.id.slice(0, 8)}…`, "info");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Steer failed: ${msg}`, "error");
  }
}

/**
 * Sub-menu with actions for a single agent. Replaces the old showAgentDetail
 * notify popup — clicking an agent in the running agents menu opens actions.
 */
async function showAgentActions(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
): Promise<void> {
  const items: string[] = [];
  const actions: Array<() => Promise<void>> = [];

  const isRunning = record.status === "running" || record.status === "queued";
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  if (isRunning) {
    items.push("Steer");
    actions.push(async () => {
      await steerAgentById(record.id, ctx);
    });

    items.push("Stop");
    actions.push(async () => {
      manager?.abort(record.id);
      ctx.ui.notify(`Stopped ${record.id.slice(0, 8)}`, "info");
    });
  }

  if (hasResult) {
    items.push("View result");
    actions.push(async () => {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new ResultViewer(
            `${getDisplayName(record.type)} · ${record.id.slice(0, 8)}`,
            record.result!,
            { onClose: () => done() },
            theme,
          ),
      );
    });
  }

  if (hasError) {
    items.push("View error");
    actions.push(async () => {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new ResultViewer(
            `${getDisplayName(record.type)} · Error`,
            record.error!,
            { onClose: () => done() },
            theme,
          ),
      );
    });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${record.id.slice(0, 8)} — no actions available`, "info");
    return;
  }

  // Append blank spacer + "Back" as the last items
  items.push("");
  actions.push(async () => {});
  items.push("Back");
  actions.push(async () => {});

  await runMenu(ctx, `Agent ${record.id.slice(0, 8)}`, items, actions);
}

async function showAgentTypes(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const lines: string[] = ["Available agent types:\n"];
  for (const name of types) {
    const cfg = getAgentConfig(name);
    if (!cfg) continue;
    const disabled = cfg.enabled === false ? " [DISABLED]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.builtinToolNames
      ? `  Tools: ${cfg.builtinToolNames.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${disabled}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
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

  const concurrencyConfig = {
    default: __config.concurrency.default,
    providers: __config.concurrency.providers ?? {},
    models: __config.concurrency.models ?? {},
  };
  manager = new AgentManager(
    (record) => {
      // Schedule nudge BEFORE removing activity — nudge reads turn count
      scheduleNudge(record.id, record);

      // Mark finished and update widget BEFORE deleting activity —
      // renderFinishedLine reads activity for turn count, tokens, etc.
      widget?.markFinished(record.id);
      widget?.update();

      // Remove from live activity tracking
      agentActivity.delete(record.id);
    },
    concurrencyConfig,
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

  const [userAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);

  const { DEFAULT_AGENTS } = await import("./default-agents.js");

  // Merge with defaults
  const merged = mergeAgents(DEFAULT_AGENTS, userAgents, projectAgents);

  // Register into the type registry
  registerAgents(merged);
}

async function loadConfigAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  // Load config (with migration if needed)
  __config = loadConfig();

  // Ensure manager exists
  ensureManagerAndWidget();

  // Scan agent files and register
  await scanAndRegisterAgents(ctx);
}

// ============================================================================
// Activity tracking — bridge between spawn callbacks and widget renderer
// ============================================================================

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: unknown) => {
      state.session = session as Parameters<typeof getSessionContextPercent>[0];
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

// ============================================================================
// Tool execute handlers
// ============================================================================

// These are wired in the registerTool calls below.
// We define them as functions here for clarity.

async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Resolve type — default to general-purpose when not specified
  const type = (params.agent as string) || "general-purpose";
  const resolvedType = resolveType(type);
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = params.description as string;
  const resume = params.resume as string | undefined;
  const runInBackground = params.run_in_background as boolean | undefined;
  const isolated = params.isolated as boolean | undefined;
  const maxTurns = params.max_turns as number | undefined;
  const thinking = params.thinking as string | undefined;

  // Model is injected by tool_call listener — use it directly
  const modelStr = params.model as string | undefined;

  // Resolve model string to Model object
  const model = resolveModelString(modelStr, ctx);

  // Compute modelKey for concurrency pool lookup
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  if (resume) {
    return executeResumeAgent(resume, prompt);
  }

  const spawnOptions: AgentManagerSpawnOptions = {
    description,
    model,
    maxTurns,
    isolated,
    thinkingLevel: thinking as ThinkingLevel | undefined,
    modelKey,
  };

  if (runInBackground) {
    return executeSpawnBackground(resolvedType, prompt, ctx, spawnOptions);
  }

  return executeSpawnForeground(resolvedType, prompt, ctx, spawnOptions);
}

// ============================================================================
// Model string resolution
// ============================================================================

/**
 * Parse a "provider/model-id" string into a Model object.
 * Falls back to ctx.model if the string lacks a provider or the registry
 * can't find the model.
 */
function resolveModelString(
  modelStr: string | undefined,
  ctx: ExtensionContext,
): Model<any> | undefined {
  if (!modelStr) return undefined;

  const parsed = parseModelKey(modelStr);
  if (!parsed) return ctx.model;

  return ctx.modelRegistry?.find(parsed.provider, parsed.modelId) ?? ctx.model;
}

// ============================================================================
// Sub-handlers for executeAgentTool
// ============================================================================

async function executeResumeAgent(
  resume: string,
  prompt: string,
): Promise<any> {
  const record = await manager.resume(resume, prompt);
  if (!record) {
    return errorResult(`Agent not found: ${resume}`);
  }
  return successResult(record.result ?? "");
}

async function executeSpawnBackground(
  resolvedType: string,
  prompt: string,
  ctx: ExtensionContext,
  spawnOptions: AgentManagerSpawnOptions,
): Promise<any> {
  const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(
    spawnOptions.maxTurns,
  );

  const agentId = manager.spawn(piInstance, ctx, resolvedType, prompt, {
    ...spawnOptions,
    isBackground: true,
    ...bgCallbacks,
  });
  agentActivity.set(agentId, bgState);
  widget?.ensureTimer();
  widget?.update();

  const record = manager.getRecord(agentId);
  if (!record) {
    return errorResult("Failed to create agent");
  }
  const bgDetails: Record<string, unknown> = { type: resolvedType, description: spawnOptions.description };
  if (record.status === "queued") {
    return successResult(`[Agent queued] Concurrency limit reached. It will start automatically when a slot frees up. Do NOT poll — you will be notified when ready.

Agent ID: ${agentId}`, bgDetails);
  }
  return successResult(
    `[Agent started in background] Do NOT poll — the result will be delivered to you automatically when it completes. Continue with other work while waiting.\n\nAgent ID: ${agentId}`,
    bgDetails,
  );
}

async function executeSpawnForeground(
  resolvedType: string,
  prompt: string,
  ctx: ExtensionContext,
  spawnOptions: AgentManagerSpawnOptions,
): Promise<any> {
  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
    spawnOptions.maxTurns,
  );

  // Capture agent ID when session is created
  let fgId: string | undefined;
  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session) => {
    origOnSession(session);
    for (const a of manager!.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        agentActivity.set(a.id, fgState);
        widget?.ensureTimer();
        break;
      }
    }
  };

  const { isBackground: _isBackground, ...spawnOpts } = spawnOptions;
  const record = await manager.spawnAndWait(piInstance, ctx, resolvedType, prompt, {
    ...spawnOpts,
    ...fgCallbacks,
  });

  // Clean up foreground agent from widget
  if (fgId) {
    agentActivity.delete(fgId);
    widget?.markFinished(fgId);
    widget?.update();
  }

  // Build raw stats for the reply card — formatted in renderResult with theme
  const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const stats = {
    type: resolvedType,
    turnCount: fgState.turnCount,
    maxTurns: fgState.maxTurns,
    toolUses: record.toolUses,
    tokens: totalTokens,
    contextPercent: getSessionContextPercent(fgState.session),
    durationMs: elapsedMs,
    description: spawnOptions.description,
    compactions: record.compactionCount,
  };

  if (record.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, stats as any);
  }

  return successResult(record.result ?? "", stats as any);
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// ============================================================================

async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  // Only handle Agent tool calls
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const subagentType = input.agent as string | undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  // Resolve effective model using precedence chain
  const effectiveModel = resolveModel(
    subagentType ?? "general-purpose",
    agentConfig,
    __config,
    ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
  );

  if (effectiveModel) {
    input.model = effectiveModel;
  }
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

  // Agent tool — stealth schema
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: ".",
    // No promptSnippet, no promptGuidelines
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.String(),
      agent: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(Type.String()),
    }),
    execute: executeAgentTool,

    renderCall(args, theme) {
      const typeName = getDisplayName((args.agent as string) || "");
      const label = typeName || "Agent";
      return new Text("▸ " + theme.fg("accent", theme.bold(label)), 0, 0);
    },

    renderResult(result, options, theme) {
      const { expanded } = options as { expanded?: boolean };
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const d = result.details as Record<string, unknown> | undefined;
      const isError = !!(result as any).isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");

      const typeName = getDisplayName((d?.type as string) || "");
      const desc = (d?.description as string) || "";

      if (d && d.turnCount != null) {
        // Rich stats card — format with theme (matching pi-subagents style)
        const parts: string[] = [];
        if ((d.toolUses as number) > 0) {
          parts.push(`${d.toolUses}🛠 `);
        }
        if (d.turnCount != null && (d.turnCount as number) > 0) {
          parts.push(formatTurns(d.turnCount as number, d.maxTurns as number | undefined));
        }
        if ((d.tokens as number) > 0) {
          const tokenText = formatSessionTokens(
            d.tokens as number,
            d.contextPercent as number | null,
            theme,
            (d.compactions as number) ?? 0,
          );
          parts.push(tokenText);
        }
        parts.push(formatMs(d.durationMs as number));

        const statsLine = parts.join("·");
        let lines = `${icon} ${theme.bold(typeName)}·${statsLine}\n  ${theme.fg("text", desc)}`;
        if (expanded && text) {
          lines += "\n" + text.split("\n").map(l => `  ${l}`).join("\n");
        }
        return new Text(lines, 0, 0);
      }

      // Minimal card when we have type/description but no stats (e.g. background spawn)
      if (typeName || desc) {
        let lines = `${icon}`;
        if (typeName) lines += ` ${theme.bold(typeName)}`;
        if (desc) lines += `\n  ${theme.fg("text", desc)}`;
        return new Text(lines, 0, 0);
      }

      return new Text(`${icon} ${theme.fg("dim", text)}`, 0, 0);
    },
  });

  // ========================================================================
  // Message renderer — subagent-result (background agent completion)
  // ========================================================================
  // Renders a collapsible stats card matching the foreground Agent tool card.
  // Stats come from `details` (UI-only), content is just the result text.

  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const { expanded } = options as { expanded?: boolean };
    const d = message.details as Record<string, unknown> | undefined;
    const text = (message.content as string)?.trim() || "";

    // Build the content inside the purple card
    const inner = new Container();

    // Title — matches default CustomMessageComponent style
    const titleText = theme.fg("customMessageLabel", `[subagent-result]`);
    inner.addChild(new Text(titleText, 0, 0));
    inner.addChild(new Spacer(1));

    if (d && d.turnCount != null) {
      // Rich stats card — matching the foreground Agent tool renderResult
      const isError = d.status === "error" || d.status === "aborted" || d.status === "stopped";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const typeName = getDisplayName((d.type as string) || "");
      const desc = (d.description as string) || "";

      const parts: string[] = [];
      if ((d.toolUses as number) > 0) {
        parts.push(`${d.toolUses}🛠 `);
      }
      if ((d.turnCount as number) > 0) {
        parts.push(formatTurns(d.turnCount as number, d.maxTurns as number | undefined));
      }
      if ((d.tokens as number) > 0) {
        const tokenText = formatSessionTokens(
          d.tokens as number,
          d.contextPercent as number | null,
          theme,
          (d.compactions as number) ?? 0,
        );
        parts.push(tokenText);
      }
      parts.push(formatMs(d.durationMs as number));

      const statsLine = parts.join("·");
      let headerLine = `${icon} ${theme.bold(typeName)}·${statsLine}\n  ${theme.fg("text", desc)}`;
      if ((d.outputFile as string)) {
        headerLine += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
      }
      inner.addChild(new Text(headerLine, 0, 0));

      // Result text — only when expanded (collapsible)
      if (expanded && text) {
        inner.addChild(new Spacer(1));
        const resultLines = text.split("\n").map(l => `  ${l}`).join("\n");
        inner.addChild(new Text(resultLines, 0, 0));
      }
    } else {
      // Minimal card — no stats (shouldn't happen, but handle gracefully)
      const typeName = getDisplayName((d?.type as string) || "");
      const desc = (d?.description as string) || "";
      let line = `${theme.fg("success", "✓")}`;
      if (typeName) line += ` ${theme.bold(typeName)}`;
      if (desc) line += `\n  ${theme.fg("text", desc)}`;
      if (d?.outputFile) {
        line += `\n  ${theme.fg("dim", `tail -f ${d.outputFile}`)}`;
      }
      inner.addChild(new Text(line, 0, 0));
    }

    // Wrap in purple card matching default CustomMessageComponent styling
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(inner);

    const outer = new Container();
    outer.addChild(new Spacer(1));
    outer.addChild(box);
    outer.addChild(new Spacer(1));
    return outer;
  });

  // ========================================================================
  // Command registration
  // ========================================================================

  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const modelOptions = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });

  // ========================================================================
  // Event listeners
  // ========================================================================

  // tool_call listener — inject model into Agent tool calls
  pi.on("tool_call", toolCallListener);

  // Grab UI context for widget rendering on first tool execution each session,
  // and advance finished-agent linger state on each turn.
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget?.setUICtx(ctx.ui as unknown as UICtx);
    widget?.onTurnStart();
  });

  // session_start — load config, scan agents, register into registry
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    agentActivity.clear();
    await loadConfigAndRegisterAgents(ctx);
  });

  // session_shutdown — clean up
  pi.on("session_shutdown", async (_event: unknown) => {
    // Dispose widget before manager
    widget?.dispose();
    widget = undefined;
    if (manager) {
      await manager.dispose();
    }
  });
}
