/**
 * menu-concurrency.ts — Concurrency settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * All limits are target-level (session/global/project per ADR-0008): setting
 * picks a level then a numeric value; removing/clearing picks a level (or all
 * levels) via the shared target picker. Values show [session]/[project] tags
 * when they come from those layers.
 *
 * Exports:
 *   - showConcurrencySettingsMenu: per-provider and per-model slot limits
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import {
  SEPARATOR_ID,
  buildSettingsListTheme,
  buildSelectListTheme,
  buildModelOptions,
  createDelegatingComponent,
  createSearchableSelect,
} from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import {
  createTargetSelectSubmenu,
  createClearAllSubmenu,
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

    // Submenu factory: Edit (→ target → value) or Remove (→ target) for an existing limit.
    const editOrRemoveSubmenu =
      (
        currentLimit: number,
        onEdit: (target: SetTarget, parsed: number) => void,
        onRemove: (target: TargetChoice) => void,
      ): SettingItem["submenu"] =>
      (currentValue, done) => {
        const list = new SelectList(
          [
            { value: "edit", label: "Edit limit" },
            { value: "remove", label: "Remove limit" },
          ],
          5,
          buildSelectListTheme(theme),
        );
        const delegator = createDelegatingComponent(list);
        list.onSelect = (item) => {
          if (item.value === "edit") {
            delegator.setActive(targetThenValueSubmenu(String(currentLimit), onEdit)(currentValue, done));
          } else {
            delegator.setActive(
              createTargetSelectSubmenu({
                theme,
                projectOffered,
                includeAll: true,
                onPick: onRemove,
              })(currentValue, done),
            );
          }
        };
        list.onCancel = () => done();
        return delegator;
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
      submenu: editOrRemoveSubmenu(
        store.concurrency.default,
        (target, parsed) => {
          store.mutate.concurrency.setDefault(parsed, target);
          ctx.ui.notify(`Default concurrency set to ${parsed} (${target})`, "info");
        },
        (target) => {
          store.mutate.concurrency.removeDefault(target);
          ctx.ui.notify(`Removed default concurrency limit (${target})`, "info");
        },
      ),
    });

    // Per-provider limits
    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    items.push({ id: SEPARATOR_ID, label: "── Per-provider limits ──", currentValue: "────────" });
    const providerLimits = store.concurrency.providers;
    for (const provider of Object.keys(providerLimits)) {
      const limit = providerLimits[provider];
      items.push({
        id: `provider:${provider}`,
        label: provider,
        currentValue: `${limit} slots${limitTag("providers", provider)}`,
        description: `Concurrent slots reserved for agents using the ${provider} provider.`,
        submenu: editOrRemoveSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed, target);
            ctx.ui.notify(`${provider} concurrency set to ${parsed} (${target})`, "info");
          },
          (target) => {
            store.mutate.concurrency.removeProvider(provider, target);
            ctx.ui.notify(`Removed per-provider limit for ${provider} (${target})`, "info");
          },
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
    items.push({ id: SEPARATOR_ID, label: "── Per-model limits ──", currentValue: "────────" });
    const models = store.concurrency.models;
    for (const modelKey of Object.keys(models)) {
      const limit = models[modelKey];
      items.push({
        id: `model:${modelKey}`,
        label: modelKey,
        currentValue: `${limit} slots${limitTag("models", modelKey)}`,
        description: `Concurrent slots reserved for agents using the ${modelKey} model.`,
        submenu: editOrRemoveSubmenu(
          limit,
          (target, parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed, target);
            ctx.ui.notify(`${modelKey} concurrency set to ${parsed} (${target})`, "info");
          },
          (target) => {
            store.mutate.concurrency.removeModel(modelKey, target);
            ctx.ui.notify(`Removed per-model limit for ${modelKey} (${target})`, "info");
          },
        ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    if (modelOptions.length > 0) {
      items.push({
        id: "addModelLimit",
        label: "Add per-model limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single model.",
        submenu: addPickThenValueSubmenu(buildModelOptions(modelOptions), (modelKey, target, parsed) => {
          store.mutate.concurrency.setModel(modelKey, parsed, target);
          ctx.ui.notify(`${modelKey} concurrency set to ${parsed} (${target})`, "info");
        }),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Clear-all per target: nested level picker, then confirm.
    items.push({
      id: "resetAll",
      label: "Clear all concurrency limits...",
      currentValue: "",
      description: "Remove concurrency overrides at the chosen level (session, global, project, or all).",
      submenu: createClearAllSubmenu({
        theme,
        projectOffered,
        message: (target) => `Clear all concurrency limits at the ${target} level?`,
        onConfirm: (target) => {
          store.mutate.concurrency.clearAll(target);
          ctx.ui.notify(`Concurrency limits cleared (${target})`, "info");
        },
      }),
    });

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
