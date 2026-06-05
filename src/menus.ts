/**
 * menus.ts — /agents command menu system.
 *
 * All menu-related functions extracted from index.ts.
 * Imports shared state (config, manager, piInstance) from state.ts.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getAllTypes, resolveType, discoverNewAgents } from "./agent-types.js";
import type { AgentRecord, ThinkingLevel } from "./types.js";
import { SHORT_ID_LENGTH, CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import type { SpawnOptions } from "./agent-manager.js";
import { ModelSelectorDialog, type ModelOption } from "./model-selector.js";
import { ResultViewer, type ResultViewerStats } from "./result-viewer.js";
import { getDisplayName } from "./format.js";
import { buildSnapshotMarkdown } from "./context.js";

import { parseModelKey, findModelInRegistry } from "./utils.js";
import {
  __config,
  sessionOverrides,
  piInstance,
  sessionCtx,
  agentActivity,
  getManager,
  getWidget,
} from "./state.js";
import { resolveModel } from "./model-precedence.js";
import { createActivityTracker, backgroundAgentIds } from "./tool-execution.js";
import {
  setModelOverride,
  setDefaultModel,
  clearModelOverride,
  clearAllModelOverrides,
  setForceBackground,
  setShowCost,
  setGraceTurns,
  setWidgetCompact,
  setWidgetMaxLines,
  setWidgetMaxLinesCompact,
  setWidgetShortcut,
  setAgent,
  setConcurrencyDefault,
  setConcurrencyProvider,
  setConcurrencyModel,
  removeConcurrencyProvider,
  removeConcurrencyModel,
  resetConcurrency,
} from "./config-mutator.js";

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
async function promptModelSelection(
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
async function parseNumericInput(
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
// Worktree picker helpers
// ============================================================================

/** Timeout for git worktree list command (ms). */
const WORKTREE_LIST_TIMEOUT_MS = 5000;

/** Max display length for a worktree path before truncation. */
const WORKTREE_PATH_TRUNCATE_LEN = 60;

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isDetached: boolean;
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Format (one block per worktree, separated by blank lines):
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or: (detached))
 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let path = "";
    let branch: string | null = null;
    let isDetached = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        isDetached = true;
      }
    }
    if (path) {
      entries.push({ path, branch, isDetached });
    }
  }
  return entries;
}

/** Truncate a path for display, keeping the tail. */
function truncatePath(p: string): string {
  if (p.length <= WORKTREE_PATH_TRUNCATE_LEN) return p;
  return "..." + p.slice(p.length - WORKTREE_PATH_TRUNCATE_LEN + 3);
}

/**
 * Fetch worktrees via `git worktree list --porcelain`.
 * Returns null if git is unavailable or the command fails.
 */
async function listWorktrees(cwd: string): Promise<WorktreeEntry[] | null> {
  try {
    const result = await piInstance.exec(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd, timeout: WORKTREE_LIST_TIMEOUT_MS },
    );
    if (result.code !== 0) return null;
    return parseWorktreeList(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Check whether a directory is inside a git repository.
 * Uses `git rev-parse --git-common-dir` — the same strategy as the worktree validator.
 */
async function isInGitRepo(cwd: string): Promise<boolean> {
  try {
    const result = await piInstance.exec(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd, timeout: WORKTREE_LIST_TIMEOUT_MS },
    );
    return result.code === 0 && result.stdout.trim() !== "";
  } catch {
    return false;
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

    // ── Session overrides section ──
    const hasSessionOverrides = Object.entries(sessionOverrides).some(
      ([, v]) => v != null,
    );

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
        clearModelOverride(targetKey);
        if (targetKey !== "default") {
          delete sessionOverrides[targetKey];
        } else {
          sessionOverrides.default = null;
        }
        ctx.ui.notify(`${label} overrides cleared`, "info");
        return;
      }

      const isSession = mode === "session";
      await applyModelOverride(
        ctx, modelOptions, label,
        currentValue,
        isSession
          ? (chosen) => { sessionOverrides[targetKey] = chosen; }
          : (chosen) => {
              setModelOverride(targetKey, chosen);
            },
      );
    };

    // Global default — show session value if present
    const hasSessionGlobal = sessionOverrides.default != null;
    const globalLabel = hasSessionGlobal
      ? `Global default model · ${sessionOverrides.default} [session]`
      : __config.agent.default
        ? `Global default model · ${__config.agent.default}`
        : "Global default model · (inherits parent)";
    items.push(globalLabel);
    actions.push(buildOverrideAction(
      "Global default", "default",
      hasSessionGlobal
        ? sessionOverrides.default!
        : __config.agent.default ?? "(inherits parent)",
    ));

    // Force background toggle
    const forceBgLabel = __config.agent.forceBackground
      ? "Force background · ON"
      : "Force background · OFF";
    items.push(forceBgLabel);
    actions.push(async () => {
      setForceBackground(!__config.agent.forceBackground);
      ctx.ui.notify(
        `Force background ${__config.agent.forceBackground ? "ON" : "OFF"}`,
        "info",
      );
    });

    // Cost display toggle
    const showCost = __config.agent.showCost === true; // default false
    items.push(`Cost display · ${showCost ? "ON" : "OFF"}`);
    actions.push(async () => {
      setShowCost(!showCost);
      ctx.ui.notify(`Cost display ${showCost ? "OFF" : "ON"}`, "info");
    });

    // Grace turns setting
    const graceTurns = __config.agent.graceTurns ?? 6;
    items.push(`Grace turns · ${graceTurns}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Grace turns (≥ 0)", String(graceTurns), 0, "≥ 0");
      if (parsed === undefined) return;
      setGraceTurns(parsed);
      ctx.ui.notify(`Grace turns set to ${parsed}`, "info");
    });

    items.push("");
    actions.push(async () => {});
    items.push("─── per-type overrides ───");
    actions.push(async () => {}); // separator

    // Per-type overrides — show only types with an explicit override (session or config)
    // All others inherit the global default; accessible via "Override another type..."
    const types = getAllTypes();
    const typeEntries = types.map((typeName) => {
      const cfg = getAgentConfig(typeName);
      const sessionOverride = sessionOverrides[typeName];
      const configOverride = __config.agent[typeName];
      const hasSession = sessionOverride != null;
      const hasConfigOverride = configOverride != null && typeof configOverride === "string";
      const effectiveModel = resolveModel({
        subagentType: typeName,
        agentConfig: cfg,
        config: __config,
        parentModelId: "(inherits parent)",
        sessionOverrides,
      });
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
        sessionOverrides.default = null;
        for (const key of Object.keys(sessionOverrides)) {
          if (key !== "default") {
            delete sessionOverrides[key];
          }
        }
        ctx.ui.notify("Session overrides cleared", "info");
      });
    }

    // Clear all overrides
    items.push("Clear all overrides");
    actions.push(async () => {
      const hasOverrides = Object.entries(__config.agent).some(
        ([k, v]) => !CONFIG_AGENT_NON_MODEL_KEYS.includes(k) && v != null,
      );
      if (!hasOverrides && __config.agent.default === null) {
        ctx.ui.notify("No overrides to clear", "info");
        return;
      }
      clearAllModelOverrides();
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

// ============================================================================
// Spawn agent menu
// ============================================================================

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Show the spawn agent flow: type selection → prompt → options sub-menu → spawn.
 * Escape at any step aborts the flow and returns to the main menu.
 */
export async function showSpawnAgentMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Step 1: Type selection loop (unknown type → error → retry)
  let selectedType: string;
  while (true) {
    const types = getAvailableTypes();
    if (types.length === 0) {
      ctx.ui.notify("No agent types available", "error");
      return;
    }
    const type = await ctx.ui.select("Select agent type", types);
    if (type === undefined) return; // Escape → main menu

    const config = getAgentConfig(type);
    if (!config) {
      ctx.ui.notify(`Unknown agent type: ${type}`, "error");
      continue; // Loop back to type selection
    }
    selectedType = type;
    break;
  }

  const agentConfig = getAgentConfig(selectedType)!;

  // Step 2: Prompt entry loop (empty prompt → error → retry)
  let prompt: string;
  while (true) {
    const input = await ctx.ui.input("Agent prompt");
    if (input === undefined) return; // Escape → main menu

    if (!input.trim()) {
      ctx.ui.notify("Prompt cannot be empty", "error");
      continue; // Loop back to prompt input
    }
    prompt = input.trim();
    break;
  }

  // Step 3: Options sub-menu with spawn action
  const autoDescription = prompt.length > 50 ? prompt.slice(0, 50) : prompt;
  let description = autoDescription;

  // Check if parent's cwd is inside a git repo (for worktree picker visibility)
  const parentCwd = sessionCtx?.cwd ?? "";
  const inGitRepo = parentCwd ? await isInGitRepo(parentCwd) : false;

  // Worktree picker state
  let currentWorktreePath: string | undefined;
  let currentWorktreeLabel = "Inherits parent cwd";

  // Pre-fill model from precedence chain
  const parentModelId = sessionCtx?.model
    ? `${sessionCtx.model.provider}/${sessionCtx.model.id}`
    : "";
  const effectiveModelStr = resolveModel({
    subagentType: selectedType,
    agentConfig,
    config: __config,
    parentModelId,
    sessionOverrides,
  });
  let currentModelStr = effectiveModelStr || ""; // "" means inherit parent
  let currentThinking: ThinkingLevel | undefined = agentConfig.thinking;
  let currentMaxTurns: number | undefined = agentConfig.maxTurns;
  let currentGraceTurns: number | undefined = __config.agent.graceTurns ?? 6;
  let currentBackground: boolean = __config.agent.forceBackground ?? false;

  while (true) {
    const displayModel = currentModelStr || "(inherits parent)";
    const displayThinking = currentThinking ?? "inherit";
    const displayMaxTurns = currentMaxTurns != null ? String(currentMaxTurns) : "unlimited";
    const displayGraceTurns = String(currentGraceTurns ?? 6);
    const displayBackground = currentBackground ? "ON" : "OFF";

    const items = [
      "Spawn",
      "",
      `Model · ${displayModel}`,
      `Background · ${displayBackground}`,
      `Thinking · ${displayThinking}`,
      `Max turns · ${displayMaxTurns}`,
      `Grace turns · ${displayGraceTurns}`,
      `Description · ${description}`,
    ];

    if (inGitRepo) {
      items.push(`Worktree · ${currentWorktreeLabel}`);
    };

    const choice = await ctx.ui.select("Spawn Options", items);
    if (choice === undefined) return; // Escape → main menu

    if (choice === "Spawn") {
      // Resolve model string to Model object
      let model: ReturnType<typeof findModelInRegistry> = undefined;
      let modelKey: string | undefined;

      if (currentModelStr) {
        const registry = sessionCtx?.modelRegistry ?? ctx.modelRegistry;
        model = findModelInRegistry(currentModelStr, registry, undefined);
        if (!model) {
          ctx.ui.notify(`Model not found: ${currentModelStr}`, "error");
          continue; // Return to options sub-menu
        }
        modelKey = `${model.provider}/${model.id}`;
      }

      // Discover worktree-local agent types before spawn
      if (currentWorktreePath) {
        await discoverNewAgents(`${currentWorktreePath}/.pi/agents`);
      }
      // Resolve type (may have been discovered from worktree)
      const resolvedType = resolveType(selectedType) ?? selectedType;

      const spawnOptions: SpawnOptions = {
        description,
        model,
        maxTurns: currentMaxTurns,
        thinkingLevel: currentThinking,
        isBackground: currentBackground,
        modelKey,
        invocation: {
          modelName: model?.id,
          thinking: currentThinking,
          maxTurns: currentMaxTurns,
          runInBackground: currentBackground,
        },
        graceTurns: currentGraceTurns,
        worktreePath: currentWorktreePath,
        worktreeLabel: currentWorktreePath ? currentWorktreeLabel : undefined,
      };

      const { state: activityState, callbacks } = createActivityTracker(currentMaxTurns);

      let agentId: string;
      try {
        agentId = getManager().spawn(piInstance, sessionCtx, resolvedType, prompt, {
          ...spawnOptions,
          ...callbacks,
        });
      } catch (err) {
        ctx.ui.notify(
          `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return; // Return to main menu
      }

      // Wire activity tracking for widget
      agentActivity.set(agentId, activityState);
      // Set UI context so widget can render (same as tool_execution_start handler)
      const widget = getWidget();
      if (widget) {
        widget.setUICtx(ctx.ui as unknown as import("./ui/agent-widget.js").UICtx);
        widget.ensureTimer();
        widget.update();
      }

      if (currentBackground) {
        backgroundAgentIds.add(agentId);
        return; // Background: return to main menu immediately
      }

      // Foreground: block until completion
      const fgRecord = getManager().getRecord(agentId);
      if (fgRecord?.execution?.promise) {
        await fgRecord.execution.promise;
      }

      agentActivity.delete(agentId);
      getWidget()?.markFinished(agentId);
      getWidget()?.update();

      return; // Return to main menu
    }

    // Handle option changes
    if (choice.startsWith("Description")) {
      const input = await ctx.ui.input("Description", description);
      if (input !== undefined && input.trim()) {
        description = input.trim();
      }
    } else if (choice.startsWith("Model")) {
      const chosen = await promptModelSelection(
        ctx, modelOptions, currentModelStr || "(inherits parent)",
      );
      if (chosen !== null) {
        currentModelStr = chosen === "(inherits parent)" ? "" : chosen;
      }
    } else if (choice.startsWith("Thinking")) {
      const allLevels = [...THINKING_LEVELS, "inherit"];
      const chosen = await ctx.ui.select("Thinking level", allLevels);
      if (chosen !== undefined) {
        currentThinking = chosen === "inherit" ? undefined : (chosen as ThinkingLevel);
      }
    } else if (choice.startsWith("Max turns")) {
      const initial = currentMaxTurns != null ? String(currentMaxTurns) : "unlimited";
      const input = await ctx.ui.input("Max turns (number or 'unlimited')", initial);
      if (input !== undefined) {
        const trimmed = input.trim().toLowerCase();
        if (trimmed === "unlimited" || trimmed === "") {
          currentMaxTurns = undefined;
        } else {
          const parsed = parseInt(trimmed, 10);
          if (isNaN(parsed) || parsed < 1) {
            ctx.ui.notify("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
          } else {
            currentMaxTurns = parsed;
          }
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const parsed = await parseNumericInput(ctx, "Grace turns (≥ 0)", String(currentGraceTurns ?? 6), 0, "≥ 0");
      if (parsed !== undefined) currentGraceTurns = parsed;
    } else if (choice.startsWith("Background")) {
      currentBackground = !currentBackground;
    } else if (choice.startsWith("Worktree") && inGitRepo) {
      // Open worktree picker
      const worktrees = await listWorktrees(parentCwd);
      if (!worktrees || worktrees.length === 0) {
        ctx.ui.notify(
          "No worktrees found or git worktree list unavailable",
          "error",
        );
        continue; // Return to options sub-menu
      }

      const pickerItems = [
        "Inherits parent cwd",
        ...worktrees.map(wt => {
          const branchLabel = wt.isDetached ? "detached" : (wt.branch ?? "detached");
          const truncPath = truncatePath(wt.path);
          return `${branchLabel}  ·  ${truncPath}`;
        }),
      ];

      const picked = await ctx.ui.select("Select worktree", pickerItems);
      if (picked === undefined) continue; // Escape → return to options sub-menu

      if (picked === "Inherits parent cwd") {
        currentWorktreePath = undefined;
        currentWorktreeLabel = "Inherits parent cwd";
      } else {
        // Find the matching worktree by index (offset by "Inherits parent cwd")
        const idx = pickerItems.indexOf(picked) - 1;
        if (idx >= 0 && idx < worktrees.length) {
          const wt = worktrees[idx];
          currentWorktreePath = wt.path;
          currentWorktreeLabel = wt.branch ?? "detached";
        }
      }
    }
  }
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

    // Force compact mode toggle
    const isForceCompact = __config.agent.widgetCompact === true;
    items.push(`Force compact mode · ${isForceCompact ? "ON" : "OFF"}`);
    actions.push(async () => {
      setWidgetCompact(!isForceCompact);
      ctx.ui.notify(`Force compact mode ${__config.agent.widgetCompact ? "ON" : "OFF"}`, "info");
    });

    // Max lines (full mode)
    const maxLines = __config.agent.widgetMaxLines ?? 12;
    items.push(`Max lines (full) · ${maxLines}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (full mode, ≥ 2)", String(maxLines), 2, "≥ 2");
      if (parsed === undefined) return;
      setWidgetMaxLines(parsed);
      ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info");
    });

    // Max lines (compact mode)
    const maxLinesCompact = __config.agent.widgetMaxLinesCompact ?? Math.floor(maxLines / 2);
    items.push(`Max lines (compact) · ${maxLinesCompact}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (compact mode, ≥ 1)", String(maxLinesCompact), 1, "≥ 1");
      if (parsed === undefined) return;
      setWidgetMaxLinesCompact(parsed);
      ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info");
    });

    // Ctrl+o shortcut toggle
    const shortcutEnabled = __config.agent.widgetShortcut === true;
    items.push(`Ctrl+o shortcut · ${shortcutEnabled ? "ON" : "OFF"}`);
    actions.push(async () => {
      setWidgetShortcut(!shortcutEnabled);
      ctx.ui.notify(`Ctrl+o shortcut ${__config.agent.widgetShortcut ? "ON" : "OFF"}`, "info");
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
  piInstance.sendUserMessage(lines.join("\n"));
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

    // Global default
    items.push(`Default concurrency limit · ${__config.concurrency.default}`);
    actions.push(async () => {
      await promptConcurrencyInput(
        ctx, "Default limit", __config.concurrency.default,
        (value) => setConcurrencyDefault(value),
      );
    });

    // Reset all to defaults
    items.push("Reset all to defaults");
    actions.push(async () => {
      resetConcurrency();
      ctx.ui.notify("Concurrency reset to defaults", "info");
    });

    // ── Per-provider limits ──
    const providerLimits = __config.concurrency.providers ?? {};
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
            (key, value) => setConcurrencyProvider(key, value),
            () => removeConcurrencyProvider(provider),
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
        (key, value) => setConcurrencyProvider(key, value),
      );
    });

    // ── Per-model limits ──
    const models = __config.concurrency.models ?? {};
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
            (key, value) => setConcurrencyModel(key, value),
            () => removeConcurrencyModel(modelKey),
          );
        });
      }
    }

    // Add per-model limit
    items.push("Add per-model limit...");
    actions.push(async () => {
      const modelKey = await promptModelSelection(
        ctx, modelOptions, __config.agent.default ?? "(inherits parent)",
      );
      if (modelKey === null) return;
      await promptAddConcurrencyLimit(
        ctx, modelKey.trim(),
        (key, value) => setConcurrencyModel(key, value),
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

  const sent = await getManager().steer(agentId, message.trim());
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
