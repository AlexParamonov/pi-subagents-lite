/**
 * menu-model-settings.ts — Model settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * Model overrides use target-level submenus (session/global/project, plus
 * nested per-level clear) per ADR-0008. Values show [session]/[project] tags
 * when they come from those layers.
 *
 * Exports:
 *   - showModelSettingsMenu: model settings with global default, per-type overrides
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { Theme } from "../types.js";
import { SEPARATOR_ID, buildSettingsListTheme, createSearchableSelect } from "./helpers.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createClearAllSubmenu, type TargetChoice } from "./submenus/target-select.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

export async function showModelSettingsMenu(ctx: ExtensionCommandContext, modelOptions: string[]): Promise<void> {
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.projectTargetOffered;

    // Shared onSet for model override submenus: applies the model to the given
    // config key at the picked layer, with `label` used in notify messages.
    // The picker returns the literal "(inherits parent)" sentinel string (never
    // null); selecting it means "clear this key at the picked layer" so the
    // value falls through to the next layer (ADR-0008 delete semantics).
    const modelOverrideOnSelect =
      (key: string, label: string): ((target: "session" | "global" | "project", model: string | null) => void) =>
      (target, model) => {
        const inherits = model === null || model === "(inherits parent)";
        if (inherits) store.mutate.agent.clearModelOverride(key, target);
        else store.mutate.agent.setModelOverride(key, model, target);
        ctx.ui.notify(
          inherits ? `${label} inherits parent model` : `${label} model set to ${model} (${target})`,
          "info",
        );
      };

    // Shared onClear: deletes the key at the picked layer, falling through to
    // the next layer. "all" clears every layer.
    const clearOverrideOnSelect =
      (key: string, label: string): ((target: TargetChoice) => void) =>
      (target) => {
        store.mutate.agent.clearModelOverride(key, target);
        ctx.ui.notify(`${label} override cleared (${target})`, "info");
      };

    // Shared submenu factory: target + model picker for one config key.
    const modelSubmenuFor = (typeName: string, effectiveModel: string | null, showClear: boolean) =>
      createModelSelectSubmenu({
        modelOptions,
        showClear,
        projectOffered,
        theme,
        currentModel: effectiveModel,
        onSet: modelOverrideOnSelect(typeName, typeName),
        onClear: clearOverrideOnSelect(typeName, typeName),
      });

    // Global default model
    const sessionDefault = store.sessionDefaultModel;
    const effectiveDefault = store.agentConfigSnapshot().default;
    const hasProjectDefault = store.hasProjectModelKey("default");
    const hasGlobalDefault = store.hasGlobalModelKey("default");
    const globalDisplayValue =
      sessionDefault != null
        ? `${sessionDefault} [session]`
        : hasProjectDefault
          ? `${effectiveDefault ?? "(inherits parent)"} [project]`
          : (effectiveDefault ?? "(inherits parent)");

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: globalDisplayValue,
      description: "Model used when no per-type override or frontmatter model applies.",
      submenu: modelSubmenuFor(
        "default",
        effectiveDefault,
        sessionDefault != null || hasProjectDefault || hasGlobalDefault,
      ),
    });

    // Per-type overrides
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({ id: SEPARATOR_ID, label: "── Per-type overrides ──", currentValue: "────────" });
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

    const overridden = typeEntries.filter((e) => e.hasSession || e.hasConfigOverride);
    const nonOverridden = typeEntries.filter((e) => !e.hasSession && !e.hasConfigOverride);

    for (const { typeName, cfg, configOverride, hasSession, effectiveModel } of overridden) {
      const frontmatterHint = !hasSession && configOverride && cfg?.model ? `${cfg.model} → ` : "";
      // Tag by provenance of the shown value: a per-type session override or the
      // session default shadows any persisted key, so both display [session].
      const fromSession = hasSession || store.sessionDefaultModel != null;
      const tag = fromSession ? " [session]" : store.hasProjectModelKey(typeName) ? " [project]" : "";
      const displayModel = `${effectiveModel}${tag}`;
      const hasPerm = !!configOverride;

      items.push({
        id: `type:${typeName}`,
        label: typeName,
        currentValue: `${frontmatterHint}${displayModel}`,
        description: `Per-type model override for the ${typeName} agent type.`,
        submenu: modelSubmenuFor(typeName, effectiveModel, hasPerm || hasSession),
      });
    }

    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description: "Add a model override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map((e) => ({ value: e.typeName, label: e.typeName })),
            {
              onSelect: (typeName) => {
                const entry = nonOverridden.find((e) => e.typeName === typeName)!;
                return modelSubmenuFor(entry.typeName, entry.effectiveModel, false)(entry.effectiveModel, subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Clear-all per target: nested level picker, then confirm.
    items.push({
      id: "clearAll",
      label: "Clear all model overrides...",
      currentValue: "",
      description: "Discard model overrides at the chosen level (session, global, project, or all).",
      submenu: createClearAllSubmenu({
        theme,
        projectOffered,
        message: (target) => `Clear all model overrides at the ${target} level?`,
        onConfirm: (target) => {
          store.mutate.agent.clearAllModelOverrides(target);
          ctx.ui.notify(`Model overrides cleared (${target})`, "info");
        },
      }),
    });

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore();
    const items = buildItems(store, theme);

    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (_id, _v) => rebuild?.(buildItems(getStore(), theme)),
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Model Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
