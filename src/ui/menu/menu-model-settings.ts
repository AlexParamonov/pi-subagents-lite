/**
 * menu-model-settings.ts — Model settings menu concern.
 *
 * Exports:
 *   - showModelSettingsMenu: model settings with global default, per-type overrides, cost display
 *
 * Private helpers (single-consumer, co-located):
 *   - promptOverrideMode: session vs permanent persistence choice
 *   - applyModelOverride: apply model selection with persistence
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../../types.js";
import { runMenuLoop, promptModelSelection } from "./menu-helpers.js";
import { getStore } from "../../shell.js";

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
