/**
 * menu-model-settings.ts — Model settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * Model overrides use 2-step submenu: override mode → model selection.
 * Cost display toggle removed (already in widget settings → usage stats).
 *
 * Exports:
 *   - showModelSettingsMenu: model settings with global default, per-type overrides
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { Theme } from "../types.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../../config/types.js";
import { buildSettingsListTheme, createSearchableSelect } from "./helpers.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

export async function showModelSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Build menu items from current store state.
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    
    // Shared onSelect for model override submenus: applies session/permanent/clear
    // mode to the given config key, with `label` used in notify messages.
    const modelOverrideOnSelect = (
      key: string,
      label: string,
    ): (mode: "session" | "permanent" | "clear", model: string | null) => void =>
      (mode, model) => {
        if (mode === "clear") {
          store.mutate.agent.clearModelOverride(key);
          store.mutate.session.clearOverride(key);
          ctx.ui.notify(`${label} overrides cleared`, "info");
          return;
        }
        const effective = model === "(inherits parent)" ? null : model;
        if (mode === "session") {
          if (effective === null) {
            store.mutate.session.clearOverride(key);
          } else {
            store.mutate.session.setOverride(key, effective);
          }
        } else {
          store.mutate.agent.setModelOverride(key, effective);
        }
        ctx.ui.notify(
          effective === null
            ? `${label} inherits parent model`
            : `${label} model set to ${effective}`,
          "info",
        );
      };

    // Global default model
    const sessionDefault = store.sessionDefaultModel;
    const hasSessionGlobal = sessionDefault != null;
    const globalDisplayValue = hasSessionGlobal
      ? `${sessionDefault} [session]`
      : store.agent.defaultModel
        ? store.agent.defaultModel
        : "(inherits parent)";

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: globalDisplayValue,
      description: "Model used when no per-type override or frontmatter model applies.",
      submenu: createModelSelectSubmenu({
        modelOptions,
        showClear: false,
        theme,
        onSelect: modelOverrideOnSelect("default", "Global default"),
      }),
    });

    // Per-type overrides
    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({ id: "__sep__", label: "── Per-type overrides ──", currentValue: "────────" });
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

    for (const { typeName, cfg, sessionOverride, configOverride, hasSession, effectiveModel } of overridden) {
      const frontmatterHint = !hasSession && configOverride && cfg?.model ? `${cfg.model} → ` : "";
      const displayModel = hasSession ? `${sessionOverride} [session]` : effectiveModel;
      const hasPerm = !!configOverride;

      items.push({
        id: `type:${typeName}`,
        label: typeName,
        currentValue: `${frontmatterHint}${displayModel}`,
        description: `Per-type model override for the ${typeName} agent type.`,
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: hasPerm,
          theme,
          onSelect: modelOverrideOnSelect(typeName, typeName),
        }),
      });
    }

    items.push({ id: "__sep__", label: "─────────────────────────", currentValue: "────────" });
    // Override another type...
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description: "Add a model override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map(e => ({ value: e.typeName, label: e.typeName })),
            {
              onSelect: (typeName) => {
                const entry = nonOverridden.find(e => e.typeName === typeName)!;
                // Delegate to createModelSelectSubmenu for the 2-step model flow
                const modelSubmenu = createModelSelectSubmenu({
                  modelOptions,
                  showClear: false,
                  theme,
                  onSelect: modelOverrideOnSelect(entry.typeName, entry.typeName),
                });
                return modelSubmenu(entry.effectiveModel, subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: "__sep__", label: " ", currentValue: "" });
    // Clear session overrides
    const hasSessionOverrides = store.sessionDefaultModel != null ||
      getAllTypes().some(type => store.sessionModelOverride(type) != null);
    if (hasSessionOverrides) {
      items.push({
        id: "clearSession",
        label: "Clear session overrides",
        currentValue: "",
        description: "Discard model overrides set only for this session.",
        submenu: createConfirmSubmenu({
          message: "Clear all session overrides?",
          theme,
          onConfirm: () => {
            store.mutate.session.clearAll();
            ctx.ui.notify("Session overrides cleared", "info");
          },
        }),
      });
    }

    // Clear all overrides
    items.push({
      id: "clearAll",
      label: "Clear all overrides",
      currentValue: "",
      description: "Discard all model overrides (config and session).",
      submenu: createConfirmSubmenu({
        message: "Clear all model overrides?",
        theme,
        onConfirm: () => {
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
        },
      }),
    });

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore();
    const items = buildItems(store, theme);

    
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), (_id, _v) => rebuild?.(buildItems(getStore(), theme)), () => done(undefined));
    return new SettingsListWrapper(settingsList, {
      title: "Model Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => { rebuild = r; },
    });
  });
}
