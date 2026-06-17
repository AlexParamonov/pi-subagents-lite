/**
 * menus.ts — /agents command menu system.
 *
 * All menu-related functions extracted from index.ts.
 * Imports shared state (config, manager) from shell.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getAllTypes } from "./agent-types.js";
import type { AgentRecord } from "./types.js";
import { SHORT_ID_LENGTH, CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import { ModelSelectorDialog, type ModelOption } from "./model-selector.js";
import { ResultViewer, type ResultViewerStats } from "./result-viewer.js";
import { getDisplayName } from "./format.js";
import { buildSnapshotMarkdown } from "./context.js";

import { parseModelKey } from "./utils.js";
import {
  getPiInstance,
  getStore,
  getManager,
} from "./shell.js";

// Spawn wizard — imported and re-exported so the dispatcher calls it from here.
import { showSpawnAgentMenu } from "./spawn-wizard.js";
export { showSpawnAgentMenu };

// ============================================================================
// Helpers
// ============================================================================

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

/**
 * Show the ModelSelectorDialog and return the chosen model string, or null.
 */
export async function promptModelSelection(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
  currentValue: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const opts = buildModelOptions(modelOptions);
      return new ModelSelectorDialog(opts, currentValue, {
        onSelect: (m) => done(m),
        onCancel: () => done(null),
      }, theme);
    }, // no overlay — renders inline below editor, matching pi's model selector look and feel
  );
}

/**
 * Prompt user to choose between session-only or permanent persistence.
 * When showClear is true, also offers "Clear".
 * Returns "session", "permanent", "clear", or null if cancelled.
 */
async function promptOverrideMode(
  ctx: ExtensionCommandContext,
  showClear: boolean = false,
): Promise<"session" | "permanent" | "clear" | null> {
  const choices: string[] = [
    "Set for this session (not saved)",
    "Set permanently (saved to config)",
  ];
  if (showClear) {
    choices.push("Clear");
  }
  const choice = await ctx.ui.select("Save mode", choices);
  if (choice === undefined) return null;
  if (choice.startsWith("Set for this session")) return "session";
  if (choice.startsWith("Set permanently")) return "permanent";
  return "clear";
}

/**
 * Prompt for a model selection and apply it as an override.
 * "(inherits parent)" clears the override (sets to null).
 * The caller is responsible for persistence (saveConfigAtomic).
 */
async function applyModelOverride(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
  label: string,
  currentValue: string,
  apply: (chosen: string | null) => void,
): Promise<void> {
  const chosen = await promptModelSelection(ctx, modelOptions, currentValue);
  if (chosen === null) return;

  const effective = chosen === "(inherits parent)" ? null : chosen;
  apply(effective);
  ctx.ui.notify(
    effective === null
      ? `${label} inherits parent model`
      : `${label} model set to ${effective}`,
    "info",
  );
}

/**
 * Prompt for numeric input, validate (integer ≥ min), return parsed value or undefined.
 * Returns undefined if the user cancels or the value is invalid.
 */
export async function parseNumericInput(
  ctx: ExtensionCommandContext,
  label: string,
  initialValue: string,
  min: number,
  minLabel: string,
): Promise<number | undefined> {
  const input = await ctx.ui.input(label, initialValue);
  if (input === undefined) return undefined;
  const parsed = parseInt(input.trim(), 10);
  if (isNaN(parsed) || parsed < min) {
    ctx.ui.notify(`Invalid value — must be a number ${minLabel}`, "error");
    return undefined;
  }
  return parsed;
}

/**
 * Parse a concurrency input: prompt, validate (integer ≥ 1), return parsed value or undefined.
 */
async function parseConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  initialValue: string,
): Promise<number | undefined> {
  return parseNumericInput(ctx, label, initialValue, 1, "≥ 1");
}

/**
 * Prompt for a concurrency value, validate, and apply via setter.
 * The setter handles save + sync internally.
 */
async function promptConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  currentValue: number,
  setter: (value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, label, String(currentValue));
  if (parsed === undefined) return;
  setter(parsed);
  ctx.ui.notify(
    `${label.replace("Concurrency slots for ", "")} concurrency set to ${parsed}`,
    "info",
  );
}

/**
 * Prompt to add a new concurrency limit for a named entity.
 * Calls the setter which handles save + sync internally.
 */
async function promptAddConcurrencyLimit(
  ctx: ExtensionCommandContext,
  label: string,
  setter: (key: string, value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, "Concurrency slots", "1");
  if (parsed === undefined) return;
  setter(label, parsed);
  ctx.ui.notify(`${label} concurrency set to ${parsed}`, "info");
}

/**
 * Show a select menu once, dispatch the chosen action.
 * Used by the per-agent action sub-menu (single-shot, not a loop).
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

/**
 * Loop a menu until the user presses Escape or selects "Back".
 * Rebuilds items/actions each iteration so the display stays fresh.
 * Appends blank spacer + "Back" automatically.
 * Used by model settings, concurrency settings, and running agents menus.
 */
async function runMenuLoop(
  ctx: ExtensionCommandContext,
  title: string,
  build: () => { items: string[]; actions: Array<() => Promise<void>> },
): Promise<void> {
  while (true) {
    const { items, actions } = build();
    items.push("");
    actions.push(async () => {});
    items.push("Back");
    actions.push(async () => {});

    const choice = await ctx.ui.select(title, items);
    if (choice === undefined || choice === "Back") return;
    const idx = items.indexOf(choice);
    if (idx >= 0 && idx < actions.length) {
      await actions[idx]();
    }
  }
}



// ============================================================================
// /agents command handler
// ============================================================================

export async function showModelSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  return runMenuLoop(ctx, "Model Settings", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // ── Session overrides section ──
    const hasSessionOverrides = store.sessionDefaultModel != null ||
      getAllTypes().some(type => store.sessionModelOverride(type) != null);

    const buildOverrideAction = (
      label: string,
      targetKey: string,
      currentValue: string,
      hasPermanentOverride: boolean = false,
    ) => async () => {
      const mode = await promptOverrideMode(ctx, hasPermanentOverride);
      if (mode === null) return;

      // Handle "clear" — remove all overrides (session + config) and save
      if (mode === "clear") {
        store.mutate.agent.clearModelOverride(targetKey);
        if (targetKey !== "default") {
          store.mutate.session.clearOverride(targetKey);
        } else {
          store.mutate.session.clearOverride("default");
        }
        ctx.ui.notify(`${label} overrides cleared`, "info");
        return;
      }

      const isSession = mode === "session";
      await applyModelOverride(
        ctx, modelOptions, label,
        currentValue,
        isSession
          ? (chosen) => {
              if (chosen === null) {
                store.mutate.session.clearOverride(targetKey);
              } else {
                store.mutate.session.setOverride(targetKey, chosen);
              }
            }
          : (chosen) => {
              store.mutate.agent.setModelOverride(targetKey, chosen);
            },
      );
    };

    // Global default — show session value if present
    const sessionDefault = store.sessionDefaultModel;
    const hasSessionGlobal = sessionDefault != null;
    const globalLabel = hasSessionGlobal
      ? `Global default model · ${sessionDefault} [session]`
      : store.agent.defaultModel
        ? `Global default model · ${store.agent.defaultModel}`
        : "Global default model · (inherits parent)";
    items.push(globalLabel);
    actions.push(buildOverrideAction(
      "Global default", "default",
      hasSessionGlobal
        ? store.sessionDefaultModel!
        : store.agent.defaultModel ?? "(inherits parent)",
    ));

    // Force background toggle
    const forceBgLabel = store.agent.forceBackground
      ? "Force background · ON"
      : "Force background · OFF";
    items.push(forceBgLabel);
    actions.push(async () => {
      store.mutate.agent.setForceBackground(!store.agent.forceBackground);
      ctx.ui.notify(
        `Force background ${store.agent.forceBackground ? "ON" : "OFF"}`,
        "info",
      );
    });

    // Cost display toggle — session or permanent (like model overrides)
    const showCost = store.agent.showCost;
    const hasSessionCost = store.hasSessionShowCost;
    items.push(`Cost display · ${showCost ? "ON" : "OFF"}${hasSessionCost ? " [session]" : ""}`);
    actions.push(async () => {
      const newValue = !showCost;
      const mode = await promptOverrideMode(ctx, hasSessionCost);
      if (mode === null) return;
      if (mode === "clear") {
        store.mutate.session.clearShowCost();
        ctx.ui.notify("Cost display session override cleared", "info");
        return;
      }
      if (mode === "session") {
        store.mutate.session.setShowCost(newValue);
      } else {
        store.mutate.agent.setShowCost(newValue);
      }
      ctx.ui.notify(`Cost display ${newValue ? "ON" : "OFF"}`, "info");
    });

    // Grace turns setting
    const graceTurns = store.agent.graceTurns;
    items.push(`Grace turns · ${graceTurns}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Grace turns (≥ 0)", String(graceTurns), 0, "≥ 0");
      if (parsed === undefined) return;
      store.mutate.agent.setGraceTurns(parsed);
      ctx.ui.notify(`Grace turns set to ${parsed}`, "info");
    });

    // Include AGENTS.md context files toggle
    const includeContextFiles = store.agent.includeContextFiles;
    items.push(`Include AGENTS.md · ${includeContextFiles ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.agent.setIncludeContextFiles(!includeContextFiles);
      ctx.ui.notify(`Include AGENTS.md ${store.agent.includeContextFiles ? "ON" : "OFF"}`, "info");
    });

    // System prompt mode setting
    const systemPromptMode = store.agent.systemPromptMode;
    items.push(`System prompt mode · ${systemPromptMode}`);
    actions.push(async () => {
      const choices = ["replace — generic header + env + agent's systemPrompt (current)", "inherit — parent's full system prompt (verbatim) + env + agent's systemPrompt", "custom — content of ~/.pi/agent/subagents-lite-prompt.md + env + agent's systemPrompt"];
      const choice = await ctx.ui.select("System prompt mode", choices);
      if (choice === undefined) return;
      let mode: "replace" | "inherit" | "custom";
      if (choice.startsWith("replace")) mode = "replace";
      else if (choice.startsWith("inherit")) mode = "inherit";
      else mode = "custom";
      store.mutate.agent.setSystemPromptMode(mode);
      ctx.ui.notify(`System prompt mode set to ${mode}`, "info");
    });

    // Offer to create custom prompt file if mode is custom but file doesn't exist
    if (systemPromptMode === "custom") {
      const customPromptPath = path.join(process.env.HOME || "", ".pi", "agent", "subagents-lite-prompt.md");
      if (!fs.existsSync(customPromptPath)) {
        items.push("Create prompt file · ~/.pi/agent/subagents-lite-prompt.md");
        actions.push(async () => {
          try {
            fs.mkdirSync(path.dirname(customPromptPath), { recursive: true });
            fs.writeFileSync(customPromptPath, "# Custom System Prompt\n\nAdd your custom system prompt here.\n", "utf-8");
            ctx.ui.notify(`Created prompt file: ${customPromptPath}`, "info");
          } catch (err: any) {
            ctx.ui.notify(`Failed to create prompt file: ${err.message}`, "error");
          }
        });
      }
    }

    items.push("");
    actions.push(async () => {});
    items.push("─── per-type overrides ───");
    actions.push(async () => {}); // separator

    // Per-type overrides — show only types with an explicit override (session or config)
    // All others inherit the global default; accessible via "Override another type..."
    const types = getAllTypes();
    const typeEntries = types.map((typeName) => {
      const cfg = getAgentConfig(typeName);
      const sessionOverride = store.sessionModelOverride(typeName);
      const configOverride = store.agentConfigSnapshot()[typeName];
      const hasSession = sessionOverride != null;
      const hasConfigOverride = configOverride != null && typeof configOverride === "string";
      const effectiveModel = store.modelFor(typeName, "(inherits parent)", cfg);
      return { typeName, cfg, sessionOverride, configOverride, hasSession, hasConfigOverride, effectiveModel };
    });

    const overridden = typeEntries.filter(e => e.hasSession || e.hasConfigOverride);
    const nonOverridden = typeEntries.filter(e => !e.hasSession && !e.hasConfigOverride);

    if (overridden.length === 0) {
      items.push("  (all inherit global default)");
      actions.push(async () => {}); // no-op
    } else {
      overridden.sort((a, b) => a.effectiveModel.localeCompare(b.effectiveModel));
      const padLen = Math.max(...types.map(t => t.length));
      for (const { typeName, cfg, sessionOverride, configOverride, hasSession, effectiveModel } of overridden) {
        const frontmatterHint = !hasSession && configOverride && cfg?.model ? `${cfg.model} → ` : "";
        const displayModel = hasSession ? `${sessionOverride} [session]` : effectiveModel;
        items.push(`${typeName.padEnd(padLen)}  ·  ${frontmatterHint}${displayModel}`);

        const currentValue = hasSession ? sessionOverride! : effectiveModel;
        actions.push(buildOverrideAction(typeName, typeName, currentValue, !!configOverride));
      }
    }

    // Add override for a type that currently inherits
    if (nonOverridden.length > 0) {
      items.push("Override another type...");
      actions.push(async () => {
        const typeNames = nonOverridden.map(e => e.typeName);
        const chosen = await ctx.ui.select("Select agent type", typeNames);
        if (chosen === undefined) return;
        const entry = nonOverridden.find(e => e.typeName === chosen)!;
        const action = buildOverrideAction(chosen, chosen, entry.effectiveModel, false);
        await action();
      });
    }

    // Clear session overrides
    if (hasSessionOverrides) {
      items.push("Clear session overrides");
      actions.push(async () => {
        store.mutate.session.clearAll();
        ctx.ui.notify("Session overrides cleared", "info");
      });
    }

    // Clear all overrides
    items.push("Clear all overrides");
    actions.push(async () => {
      const agentConfig = store.agentConfigSnapshot();
      const hasOverrides = Object.entries(agentConfig).some(
        ([k, v]) => !CONFIG_AGENT_NON_MODEL_KEYS.includes(k) && v != null,
      );
      if (!hasOverrides && store.agent.defaultModel === null) {
        ctx.ui.notify("No overrides to clear", "info");
        return;
      }
      store.mutate.agent.clearAllModelOverrides();
      ctx.ui.notify("All model overrides cleared", "info");
    });

    return { items, actions };
  });
}

/** Map menu choice to handler. Matches by number prefix or first word. */
function matchMenuChoice(
  choice: string,
  handlers: Record<string, () => Promise<void>>,
): (() => Promise<void>) | undefined {
  // Try number prefix first (e.g., "1." from "1. Running agents")
  const numMatch = choice.match(/^(\d+)/);
  if (numMatch) return handlers[numMatch[1]];
  // Fall back to first word
  const key = choice.split(" ")[0].toLowerCase();
  return handlers[key];
}



export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Model settings — Set global default and per-type model overrides",
    "2. Concurrency settings — Set per-model slot limits",
    "3. Widget settings — Configure widget display options",
    "",
    "Back",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showModelSettingsMenu(ctx, modelOptions),
    "2": () => showConcurrencySettingsMenu(ctx, modelOptions),
    "3": () => showWidgetSettingsMenu(ctx),
  };

  while (true) {
    const choice = await ctx.ui.select("Settings", menuItems);
    if (choice === undefined || choice === "Back") return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Running agents — List running/queued agents",
    "2. Spawn agent — Manually spawn a new agent",
    "3. Settings — Model, concurrency, and widget settings",
    "4. Debug — Agent types, briefing, diagnostics",
    "",
    "Press Escape to close",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showRunningAgentsMenu(ctx),
    "2": () => showSpawnAgentMenu(ctx, modelOptions),
    "3": () => showSettingsMenu(ctx, modelOptions),
    "4": () => showDebugMenu(ctx),
  };

  // Loop so sub-menus navigate back to root; only Escape at root closes
  while (true) {
    const choice = await ctx.ui.select("Subagents Management", menuItems);
    if (choice === undefined || choice === "Press Escape to close") return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}

async function showDebugMenu(ctx: ExtensionCommandContext): Promise<void> {
  const menuItems = [
    "1. Agent types — List available agent types and their configs",
    "2. Agent briefing — Send agent types/capabilities info to LLM (Optional, if having issues)",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showAgentTypes(ctx),
    "2": () => handleAgentBriefing(ctx),
  };

  while (true) {
    const choice = await ctx.ui.select("Debug", menuItems);
    if (choice === undefined) return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  return runMenuLoop(ctx, "Widget Settings", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // Force compact mode toggle
    const isForceCompact = store.agent.widgetCompact;
    items.push(`Force compact mode · ${isForceCompact ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.widget.setCompact(!isForceCompact);
      ctx.ui.notify(`Force compact mode ${store.agent.widgetCompact ? "ON" : "OFF"}`, "info");
    });

    // Max lines (full mode)
    const maxLines = store.agent.widgetMaxLines;
    items.push(`Max lines (full) · ${maxLines}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (full mode, ≥ 2)", String(maxLines), 2, "≥ 2");
      if (parsed === undefined) return;
      store.mutate.widget.setMaxLines(parsed);
      ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info");
    });

    // Max lines (compact mode)
    const maxLinesCompact = store.agent.widgetMaxLinesCompact;
    items.push(`Max lines (compact) · ${maxLinesCompact}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (compact mode, ≥ 1)", String(maxLinesCompact), 1, "≥ 1");
      if (parsed === undefined) return;
      store.mutate.widget.setMaxLinesCompact(parsed);
      ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info");
    });

    // Ctrl+o shortcut toggle
    const shortcutEnabled = store.agent.widgetShortcut;
    items.push(`Ctrl+o shortcut · ${shortcutEnabled ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.widget.setShortcut(!shortcutEnabled);
      ctx.ui.notify(`Ctrl+o shortcut ${store.agent.widgetShortcut ? "ON" : "OFF"}`, "info");
    });

    return { items, actions };
  });
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

    if (config.registeredTools) {
      lines.push(`**Tools:** ${config.registeredTools.join(", ")}`);
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
  lines.push("| `thinking` | Optional thinking mode override (e.g., `off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |");
  lines.push("| `run_in_background` | When `true`, result is auto-delivered — do NOT poll. Continue working while waiting. |");
  lines.push("| `worktree_path` | Optional path to a git worktree of the parent's repo. See below for details. |");
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, the result will arrive when ready");
  lines.push("");
  lines.push("## `worktree_path` Parameter\n");
  lines.push("Use `worktree_path` to run a subagent in a different git worktree of the parent's repository.");
  lines.push("");
  lines.push("- **Optional.** Omit to run the subagent in the parent's working directory (default behavior).");
  lines.push("- **Must be a path** inside a git worktree of the parent's repo, including the main checkout. Not a different repo, not a non-git directory.");
  lines.push("- **Relative paths** are resolved against the parent's working directory.");
  lines.push("- **On failure** the validator returns a specific reason (e.g., 'not a worktree of the parent's repository', 'path does not exist') — use this to self-correct.");
  lines.push("- **Agent type discovery:** The worktree's `.pi/agents/` directory is scanned for agent types when this param is set, so worktree-local types become available to that spawn.");
  getPiInstance().sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

/**
 * Build a sub-menu for a single per-provider or per-model entry:
 * "Edit limit" to change the value, or "Remove limit" to delete it.
 * Callers pass setter callbacks that handle save + sync internally.
 */
async function editOrRemoveConcurrencyEntry(
  ctx: ExtensionCommandContext,
  label: string,
  entityType: "provider" | "model",
  entityKey: string,
  currentValue: number,
  setEntry: (key: string, value: number) => void,
  removeEntry: () => void,
): Promise<void> {
  await runMenu(ctx, `${entityKey} concurrency`, [
    "Edit limit",
    "Remove limit",
  ], [
    async () => {
      await promptConcurrencyInput(
        ctx, entityKey, currentValue,
        (value) => setEntry(entityKey, value),
      );
    },
    async () => {
      removeEntry();
      ctx.ui.notify(
        `Removed per-${entityType} limit for ${entityKey}`,
        "info",
      );
    },
  ]);
}

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();

  return runMenuLoop(ctx, "Concurrency Settings", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // Global default
    items.push(`Default concurrency limit · ${store.concurrency.default}`);
    actions.push(async () => {
      await promptConcurrencyInput(
        ctx, "Default limit", store.concurrency.default,
        (value) => store.mutate.concurrency.setDefault(value),
      );
    });

    // Reset all to defaults
    items.push("Reset all to defaults");
    actions.push(async () => {
      store.mutate.concurrency.reset();
      ctx.ui.notify("Concurrency reset to defaults", "info");
    });

    // ── Per-provider limits ──
    const providerLimits = store.concurrency.providers;
    const configuredProviders = Object.keys(providerLimits);
    if (configuredProviders.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── per-provider limits ───");
      actions.push(async () => {}); // separator

      for (const provider of configuredProviders) {
        const limit = providerLimits[provider];
        items.push(`${provider}  ·  ${limit} slots`);
        actions.push(async () => {
          await editOrRemoveConcurrencyEntry(
            ctx,
            `Concurrency slots for ${provider}`,
            "provider",
            provider,
            limit,
            (key, value) => store.mutate.concurrency.setProvider(key, value),
            () => store.mutate.concurrency.removeProvider(provider),
          );
        });
      }
    }

    // Add per-provider limit
    items.push("Add per-provider limit...");
    actions.push(async () => {
      const provider = await ctx.ui.select("Select provider", providers);
      if (provider === undefined) return;
      await promptAddConcurrencyLimit(
        ctx, provider,
        (key, value) => store.mutate.concurrency.setProvider(key, value),
      );
    });

    // ── Per-model limits ──
    const models = store.concurrency.models;
    const modelKeys = Object.keys(models);
    if (modelKeys.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── per-model limits ───");
      actions.push(async () => {}); // separator

      for (const modelKey of modelKeys) {
        const limit = models[modelKey];
        items.push(`${modelKey}  ·  ${limit} slots`);
        actions.push(async () => {
          await editOrRemoveConcurrencyEntry(
            ctx,
            `Concurrency slots for ${modelKey}`,
            "model",
            modelKey,
            limit,
            (key, value) => store.mutate.concurrency.setModel(key, value),
            () => store.mutate.concurrency.removeModel(modelKey),
          );
        });
      }
    }

    // Add per-model limit
    items.push("Add per-model limit...");
    actions.push(async () => {
      const modelKey = await promptModelSelection(
        ctx, modelOptions, store.agent.defaultModel ?? "(inherits parent)",
      );
      if (modelKey === null) return;
      await promptAddConcurrencyLimit(
        ctx, modelKey.trim(),
        (key, value) => store.mutate.concurrency.setModel(key, value),
      );
    });

    return { items, actions };
  });
}

async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const records = getManager()?.listAgents() ?? [];
  if (records.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }

  return runMenuLoop(ctx, "Running Agents", () => {
    const records = getManager()?.listAgents() ?? [];
    const running = records.filter((r) => r.lifecycle.status === "running" || r.lifecycle.status === "queued");

    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    for (const record of records) {
      const elapsed = Math.round((Date.now() - record.lifecycle.startedAt) / 1000);
      const statusIcon = record.lifecycle.status === "running" ? "▶" :
        record.lifecycle.status === "completed" ? "✓" :
        record.lifecycle.status === "queued" ? "⏳" :
        record.lifecycle.status === "error" ? "✗" : "•";
      const headline = record.display.description
        ? (record.display.description.length > 50 ? record.display.description.slice(0, 47) + "..." : record.display.description)
        : "";
      const suffix = headline ? ` — ${headline}` : "";
      items.push(
        `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.display.type}  ${record.lifecycle.status}  ${elapsed}s${suffix}`,
      );

      actions.push(async () => {
        await showAgentActions(ctx, record);
      });
    }

    if (running.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── actions ───");
      actions.push(async () => {}); // separator

      items.push(`Stop ${running.length} running agent(s)`);
      actions.push(async () => {
        for (const record of running) {
          getManager()?.abort(record.id);
        }
        ctx.ui.notify(`Stopped ${running.length} agent(s)`, "info");
      });
    }

    return { items, actions };
  });
}

/**
 * Show a ResultViewer for an agent's result, error, or snapshot.
 * @param kind — "result", "error", or "snapshot" — used for the title suffix
 */
async function showResultViewer(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
  kind: "result" | "error" | "snapshot",
  text: string,
): Promise<void> {
  const titleSuffix = kind === "result"
    ? record.id.slice(0, SHORT_ID_LENGTH)
    : kind === "snapshot"
    ? `snapshot \u00b7 ${record.id.slice(0, SHORT_ID_LENGTH)}`
    : "Error";
  const stats: ResultViewerStats = {
    lifetimeUsage: record.stats.lifetimeUsage,
    turnCount: record.stats.turnCount,
    durationMs: (record.lifecycle.completedAt ?? Date.now()) - record.lifecycle.startedAt,
  };
  const refreshCallback =
    kind === "snapshot" && record.execution.session
      ? () => buildSnapshotMarkdown(record.execution.session!.messages)
      : undefined;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new ResultViewer(
        `${getDisplayName(record.display.type)} · ${titleSuffix}`,
        text,
        { onClose: () => done(), onRefresh: refreshCallback },
        theme,
        tui.terminal.rows,
        stats,
      ),
  );
}

/**
 * Send a steer message to a specific agent. Used by the per-agent action menu.
 */
async function steerAgentById(
  agentId: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const record = getManager()?.getRecord(agentId);
  if (!record) {
    ctx.ui.notify("Agent not found", "error");
    return;
  }

  const message = await ctx.ui.input(`Steer ${record.display.type}`);
  if (!message?.trim()) return;

  const sent = await getManager()!.steer(agentId, message.trim());
  if (sent) {
    ctx.ui.notify(`Steer sent to ${record.id.slice(0, SHORT_ID_LENGTH)}…`, "info");
  } else {
    ctx.ui.notify(`Steer failed for ${record.id.slice(0, SHORT_ID_LENGTH)}`, "error");
  }
}

/**
 * Sub-menu with actions for a single agent. Replaces the old showAgentDetail
 * notify popup — clicking an agent in the running agents menu opens actions.
 */
export async function showAgentActions(
  ctx: ExtensionCommandContext,
  record: AgentRecord,
): Promise<void> {
  const items: string[] = [];
  const actions: Array<() => Promise<void>> = [];

  const isRunning = record.lifecycle.status === "running" || record.lifecycle.status === "queued";
  const hasSession = !!record.execution.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  // View actions first
  if (record.lifecycle.status === "running" && hasSession) {
    items.push("View snapshot");
    actions.push(async () => {
      const messages = record.execution.session!.messages;
      const markdown = buildSnapshotMarkdown(messages);
      await showResultViewer(ctx, record, "snapshot", markdown);
    });
  }

  if (hasResult) {
    items.push("View result");
    actions.push(async () => {
      await showResultViewer(ctx, record, "result", record.result!);
    });
  }

  if (hasError) {
    items.push("View error");
    actions.push(async () => {
      await showResultViewer(ctx, record, "error", record.error!);
    });
  }

  // Then control actions
  if (isRunning) {
    items.push("Steer");
    actions.push(async () => {
      await steerAgentById(record.id, ctx);
    });

    items.push("Stop");
    actions.push(async () => {
      getManager()?.abort(record.id);
      ctx.ui.notify(`Stopped ${record.id.slice(0, SHORT_ID_LENGTH)}`, "info");
    });
  }

  if (items.length === 0) {
    ctx.ui.notify(`Agent ${record.id.slice(0, SHORT_ID_LENGTH)} — no actions available`, "info");
    return;
  }

  // Append blank spacer + "Back" as the last items
  items.push("");
  actions.push(async () => {});
  items.push("Back");
  actions.push(async () => {});

  await runMenu(ctx, `Agent ${record.id.slice(0, SHORT_ID_LENGTH)}`, items, actions);
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
    const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}
