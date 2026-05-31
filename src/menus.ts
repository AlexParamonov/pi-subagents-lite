/**
 * menus.ts — /agents command menu system.
 *
 * All menu-related functions extracted from index.ts.
 * Imports shared state (config, manager, piInstance) from index.ts.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getAllTypes } from "./agent-types.js";
import type { AgentRecord } from "./types.js";
import { SHORT_ID_LENGTH } from "./types.js";
import { ModelSelectorDialog, type ModelOption } from "./model-selector.js";
import { ResultViewer, type ResultViewerStats } from "./result-viewer.js";
import { getDisplayName } from "./ui/agent-widget.js";
import { buildSnapshotMarkdown } from "./context.js";

import { parseModelKey } from "./utils.js";
import {
  __config,
  sessionOverrides,
  manager,
  piInstance,
} from "./index.js";
import { resolveModel } from "./model-precedence.js";
import { saveConfigAtomic, DEFAULT_CONFIG } from "./config-io.js";

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
 * Persist concurrency config to disk and apply to the running manager.
 */
function applyConcurrencyConfig(): void {
  saveConfigAtomic(__config);
  manager?.setConcurrency(__config.concurrency);
}

/**
 * Parse a concurrency input: prompt, validate (integer ≥ 1), return parsed value or undefined.
 */
async function parseConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  initialValue: string,
): Promise<number | undefined> {
  const input = await ctx.ui.input(label, initialValue);
  if (input === undefined) return undefined;
  const parsed = parseInt(input.trim(), 10);
  if (isNaN(parsed) || parsed < 1) {
    ctx.ui.notify("Invalid value — must be a number ≥ 1", "error");
    return undefined;
  }
  return parsed;
}

/**
 * Prompt for a concurrency value, validate, save and apply.
 * Used for editing an existing concurrency limit.
 */
async function promptConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  currentValue: number,
  apply: (value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, label, String(currentValue));
  if (parsed === undefined) return;
  apply(parsed);
  applyConcurrencyConfig();
  ctx.ui.notify(
    `${label.replace("Concurrency slots for ", "")} concurrency set to ${parsed}`,
    "info",
  );
}

/**
 * Prompt to add a new concurrency limit for a named entity.
 */
async function promptAddConcurrencyLimit(
  ctx: ExtensionCommandContext,
  label: string,
  apply: (key: string, value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, "Concurrency slots", "1");
  if (parsed === undefined) return;
  apply(label, parsed);
  applyConcurrencyConfig();
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
        delete __config.agent[targetKey];
        if (targetKey !== "default") {
          delete sessionOverrides[targetKey];
        } else {
          sessionOverrides.default = null;
        }
        saveConfigAtomic(__config);
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
              __config.agent[targetKey] = chosen;
            },
      );
      if (!isSession) {
        saveConfigAtomic(__config);
      }
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
      __config.agent.forceBackground = !__config.agent.forceBackground;
      saveConfigAtomic(__config);
      ctx.ui.notify(
        `Force background ${__config.agent.forceBackground ? "ON" : "OFF"}`,
        "info",
      );
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
        ([k, v]) => k !== "default" && k !== "forceBackground" && v != null,
      );
      if (!hasOverrides && __config.agent.default === null) {
        ctx.ui.notify("No overrides to clear", "info");
        return;
      }
      __config.agent = { default: __config.agent.default, forceBackground: __config.agent.forceBackground };
      saveConfigAtomic(__config);
      ctx.ui.notify("All model overrides cleared", "info");
    });

    return { items, actions };
  });
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Model settings — Set global default and per-type model overrides",
    "2. Concurrency settings — Set per-model slot limits",
    "3. Running agents — List running/queued agents",
    "4. Debug — Agent types, briefing, diagnostics",
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
      await showDebugMenu(ctx);
    }
  }
}

async function showDebugMenu(ctx: ExtensionCommandContext): Promise<void> {
  const menuItems = [
    "1. Agent types — List available agent types and their configs",
    "2. Agent briefing — Send agent types/capabilities info to LLM (Optional, if having issues)",
  ];

  while (true) {
    const choice = await ctx.ui.select("Debug", menuItems);
    if (choice === undefined) return;

    if (choice.startsWith("1.")) {
      await showAgentTypes(ctx);
    } else if (choice.startsWith("2.")) {
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
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, the result will arrive when ready");
  piInstance.sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

/**
 * Build a sub-menu for a single per-provider or per-model entry:
 * "Edit limit" to change the value, or "Remove limit" to delete it.
 */
async function editOrRemoveConcurrencyEntry(
  ctx: ExtensionCommandContext,
  label: string,
  entityType: "provider" | "model",
  entityKey: string,
  currentValue: number,
  applyUpdate: (value: number) => void,
  applyRemove: () => void,
): Promise<void> {
  await runMenu(ctx, `${entityKey} concurrency`, [
    "Edit limit",
    "Remove limit",
  ], [
    async () => {
      await promptConcurrencyInput(
        ctx, label, currentValue,
        applyUpdate,
      );
    },
    async () => {
      applyRemove();
      applyConcurrencyConfig();
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
        ctx, "Default concurrency limit", __config.concurrency.default,
        (value) => { __config.concurrency.default = value; },
      );
    });

    // Reset all to defaults
    items.push("Reset all to defaults");
    actions.push(async () => {
      __config.concurrency = { ...DEFAULT_CONFIG.concurrency };
      applyConcurrencyConfig();
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
            (value) => {
              const current = __config.concurrency.providers ?? {};
              __config.concurrency.providers = { ...current, [provider]: value };
            },
            () => {
              const providers = __config.concurrency.providers;
              if (providers) {
                delete providers[provider];
              }
            },
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
        (key, value) => {
          const current = __config.concurrency.providers ?? {};
          __config.concurrency.providers = { ...current, [key]: value };
        },
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
            (value) => {
              const current = __config.concurrency.models ?? {};
              __config.concurrency.models = { ...current, [modelKey]: value };
            },
            () => {
              const models = __config.concurrency.models;
              if (models) {
                delete models[modelKey];
              }
            },
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
        (key, value) => {
          const current = __config.concurrency.models ?? {};
          __config.concurrency.models = { ...current, [key]: value };
        },
      );
    });

    return { items, actions };
  });
}

async function showRunningAgentsMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const records = manager?.listAgents() ?? [];
  if (records.length === 0) {
    ctx.ui.notify("No agents have been spawned this session", "info");
    return;
  }

  return runMenuLoop(ctx, "Running Agents", () => {
    const records = manager?.listAgents() ?? [];
    const running = records.filter((r) => r.status === "running" || r.status === "queued");

    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];

    for (const record of records) {
      const elapsed = Math.round((Date.now() - record.startedAt) / 1000);
      const statusIcon = record.status === "running" ? "▶" :
        record.status === "completed" ? "✓" :
        record.status === "queued" ? "⏳" :
        record.status === "error" ? "✗" : "•";
      items.push(
        `${statusIcon} ${record.id.slice(0, SHORT_ID_LENGTH)}  ${record.type}  ${record.status}  ${elapsed}s`,
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
          manager?.abort(record.id);
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
    lifetimeUsage: record.lifetimeUsage,
    turnCount: record.turnCount,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
  };
  const refreshCallback =
    kind === "snapshot" && record.session
      ? () => buildSnapshotMarkdown(record.session!.messages)
      : undefined;

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new ResultViewer(
        `${getDisplayName(record.type)} · ${titleSuffix}`,
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
  const record = manager?.getRecord(agentId);
  if (!record) {
    ctx.ui.notify("Agent not found", "error");
    return;
  }

  const message = await ctx.ui.input(`Steer ${record.type}`);
  if (!message?.trim()) return;

  const sent = await manager.steer(agentId, message.trim());
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

  const isRunning = record.status === "running" || record.status === "queued";
  const hasSession = !!record.session;
  const hasResult = !!record.result && record.result.length > 0;
  const hasError = !!record.error && record.error.length > 0;

  // View actions first
  if (record.status === "running" && hasSession) {
    items.push("View snapshot");
    actions.push(async () => {
      const messages = record.session!.messages;
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
      manager?.abort(record.id);
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
    const disabled = cfg.enabled === false ? " [DISABLED]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
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
