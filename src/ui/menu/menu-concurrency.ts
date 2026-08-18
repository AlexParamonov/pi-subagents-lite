/**
 * menu-concurrency.ts — Concurrency settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * All limits are target-level (session/global/project per ADR-0008): setting
 * picks a level then a numeric value; removing/clearing picks a level (or all
 * levels) via the shared target picker, which offers only levels that carry
 * the entry. Values show [session]/[project] tags when they come from those
 * layers.
 *
 * Exports:
 *   - showConcurrencySettingsMenu: per-provider and per-model slot limits
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  buildModelOptions,
  createSearchableSelect,
  extractConfiguredModels,
} from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  createTargetSelectSubmenu,
  createClearAllSubmenu,
  type AvailableLevels,
  type SetTarget,
  type TargetChoice,
} from "./submenus/target-select.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";
import type { RawConcurrency } from "../../config/config-store.js";
import type { SelectOption } from "../searchable-select.js";
import type { Theme } from "../types.js";

export async function showConcurrencySettingsMenu(ctx: ExtensionCommandContext, modelOptions: string[]): Promise<void> {
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme, modelOptions: string[]): SettingItem[] => {
    const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();
    const items: SettingItem[] = [];
    const projectOffered = store.projectTargetOffered;

    /** True when the layer carries this concurrency entry. */
    const layerHas = (layer: RawConcurrency, section: "default" | "providers" | "models", key?: string): boolean =>
      section === "default" ? layer.default !== undefined : key !== undefined && layer[section]?.[key] !== undefined;

    /** Which layers carry this concurrency entry, driving the remove/clear pickers. */
    const entryLevels = (section: "default" | "providers" | "models", key?: string): AvailableLevels => ({
      session: layerHas(store.sessionConcurrency, section, key),
      global: layerHas(store.globalConcurrency, section, key),
      project: layerHas(store.projectConcurrency, section, key),
    });

    /** " [session]" / " [project]" when the effective value comes from that layer. */
    const limitTag = (section: "default" | "providers" | "models", key?: string): string => {
      if (layerHas(store.sessionConcurrency, section, key)) return " [session]";
      if (layerHas(store.projectConcurrency, section, key)) return " [project]";
      return "";
    };

    // Submenu factory: pick a target level, then enter a numeric value.
    const targetThenValueSubmenu =
      (initial: string, onPick: (target: SetTarget, parsed: number) => void) =>
      (currentValue: string, done: (selectedValue?: string) => void) =>
        createTargetSelectSubmenu({
          theme,
          projectOffered,
          onPick: (target, pickDone) =>
            createNumericSubmenu(ctx, { min: 1 }, (parsed) => onPick(target as SetTarget, parsed))(initial, pickDone),
        })(currentValue, done);

    // Submenu factory: set at a target level (value input) or Clear via a
    // nested per-level picker — the model-settings flow.
    const limitSubmenu =
      (
        currentLimit: number,
        onSet: (target: SetTarget, parsed: number) => void,
        onRemove: (target: TargetChoice) => void,
        availableLevels: AvailableLevels,
      ): SettingItem["submenu"] =>
      (currentValue, done) => {
        // A fresh config's default row has an effective value but no raw key
        // anywhere, so Clear is offered only when a layer actually carries it.
        const items = buildLevelItems({
          offered: { session: true, global: true, project: projectOffered },
          includeClear: availableLevels.session || availableLevels.global || availableLevels.project,
        });
        return createLevelPickerSubmenu({
          theme,
          items,
          onPick: (id, subDone) => {
            if (id === "clear") {
              return createClearPickerSubmenu({
                theme,
                projectOffered,
                availableLevels,
                onClear: onRemove,
              })("", subDone);
            }
            const target = id as SetTarget;
            return createNumericSubmenu(ctx, { min: 1 }, (parsed) => onSet(target, parsed))(
              String(currentLimit),
              subDone,
            );
          },
        })(currentValue, done);
      };

    // Submenu factory: searchable-pick an option, then target → numeric value.
    // Used for both per-provider and per-model limits; items differ by caller.
    const addPickThenValueSubmenu =
      (
        items: SelectOption[],
        onPick: (key: string, target: SetTarget, parsed: number) => void,
      ): SettingItem["submenu"] =>
      (currentValue, done) =>
        createSearchableSelect(
          items,
          {
            onSelect: (key) =>
              targetThenValueSubmenu("1", (target, parsed) => onPick(key, target, parsed))(currentValue, done),
            onCancel: () => done(),
          },
          theme,
        );

    // Default limit
    items.push({
      id: "defaultConcurrency",
      label: "Default concurrency limit",
      currentValue: `${store.concurrency.default}${limitTag("default")}`,
      description: "Concurrent agent slots when no per-provider or per-model limit applies.",
      submenu: limitSubmenu(
        store.concurrency.default,
        (target, parsed) => {
          store.mutate.concurrency.setDefault(parsed, target);
          ctx.ui.notify(`Default concurrency set to ${parsed} (${target})`, "info");
        },
        (target) => {
          store.mutate.concurrency.removeDefault(target);
          ctx.ui.notify(`Removed default concurrency limit (${target})`, "info");
        },
        entryLevels("default"),
      ),
    });

    // Per-provider limits
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-provider limits")),
      currentValue: "",
    });
    const providerLimits = store.concurrency.providers;
    for (const provider of Object.keys(providerLimits)) {
      const limit = providerLimits[provider];
      items.push({
        id: `provider:${provider}`,
        label: provider,
        currentValue: `${limit} slots${limitTag("providers", provider)}`,
        description: `Concurrent slots reserved for agents using the ${provider} provider.`,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed, target);
            ctx.ui.notify(`${provider} concurrency set to ${parsed} (${target})`, "info");
          },
          (target) => {
            store.mutate.concurrency.removeProvider(provider, target);
            ctx.ui.notify(`Removed per-provider limit for ${provider} (${target})`, "info");
          },
          entryLevels("providers", provider),
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    if (providers.length > 0) {
      items.push({
        id: "addProviderLimit",
        label: "Add per-provider limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single provider.",
        submenu: addPickThenValueSubmenu(
          providers.map((o) => ({ value: o, label: o })),
          (provider, target, parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed, target);
            ctx.ui.notify(`${provider} concurrency set to ${parsed} (${target})`, "info");
          },
        ),
      });
    }

    // Per-model limits
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({
      id: SEPARATOR_ID,
      label: theme.bold(theme.fg("accent", "Per-model limits")),
      currentValue: "",
    });
    const models = store.concurrency.models;
    for (const modelKey of Object.keys(models)) {
      const limit = models[modelKey];
      items.push({
        id: `model:${modelKey}`,
        label: modelKey,
        currentValue: `${limit} slots${limitTag("models", modelKey)}`,
        description: `Concurrent slots reserved for agents using the ${modelKey} model.`,
        submenu: limitSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed, target);
            ctx.ui.notify(`${modelKey} concurrency set to ${parsed} (${target})`, "info");
          },
          (target) => {
            store.mutate.concurrency.removeModel(modelKey, target);
            ctx.ui.notify(`Removed per-model limit for ${modelKey} (${target})`, "info");
          },
          entryLevels("models", modelKey),
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    if (modelOptions.length > 0) {
      const configuredModels = extractConfiguredModels(store.agentConfigSnapshot());
      items.push({
        id: "addModelLimit",
        label: "Add per-model limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single model.",
        submenu: addPickThenValueSubmenu(
          buildModelOptions(modelOptions, undefined, configuredModels),
          (modelKey, target, parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed, target);
            ctx.ui.notify(`${modelKey} concurrency set to ${parsed} (${target})`, "info");
          },
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Clear-all per target: nested level picker, then confirm. Each level is
    // offered only when it has concurrency entries (project additionally
    // requires the project target to be offered); the entry itself is hidden
    // when no level is offered.
    const availableLevels: AvailableLevels = {
      session: store.hasSessionConcurrencySettings,
      global: store.hasGlobalConcurrencySettings,
      project: store.hasProjectConcurrencySettings && projectOffered,
    };
    if (availableLevels.session || availableLevels.global || availableLevels.project) {
      items.push({
        id: "resetAll",
        label: "Clear all concurrency limits...",
        currentValue: "",
        description: "Remove concurrency overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) => `Clear all concurrency limits at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.concurrency.clearAll(target);
            ctx.ui.notify(`Concurrency limits cleared (${target})`, "info");
          },
        }),
      });
    }

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const triggerRebuild = () => rebuild?.(buildItems(getStore(), theme, modelOptions));
    const store = getStore();
    const items = buildItems(store, theme, modelOptions);
    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (_id, _v) => triggerRebuild(),
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Concurrency Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
