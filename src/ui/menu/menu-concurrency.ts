/**
 * menu-concurrency.ts — Concurrency settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * Numeric input submenus for concurrency values.
 * Confirm submenu for reset all.
 *
 * Exports:
 *   - showConcurrencySettingsMenu: per-provider and per-model slot limits
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem } from "@earendil-works/pi-tui";
import {
  buildSettingsListTheme,
  buildSelectListTheme,
  buildModelOptions,
  createDelegatingComponent,
  createSearchableSelect,
} from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";
import type { SelectOption } from "../searchable-select.js";
import type { Theme } from "../types.js";

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  // Build menu items from current store state.
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme, modelOptions: string[], onRebuild?: () => void): SettingItem[] => {
    const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();
    const items: SettingItem[] = [];

    

    // Submenu factory: pick Edit (→ value input) or Remove for an existing limit.
    const editOrRemoveSubmenu = (
      currentLimit: number,
      onEdit: (parsed: number) => void,
      onRemove: () => void,
    ): SettingItem["submenu"] => (_currentValue, subDone) => {
      const list = new SelectList(
        [{ value: "edit", label: "Edit limit" }, { value: "remove", label: "Remove limit" }],
        5, buildSelectListTheme(theme),
      );
      const delegator = createDelegatingComponent(list);
      list.onSelect = (item) => {
        if (item.value === "edit") {
          delegator.setActive(createNumericSubmenu(ctx, { min: 1 }, onEdit)(String(currentLimit), subDone));
        } else {
          onRemove();
          subDone();
          onRebuild?.();
        }
      };
      list.onCancel = () => subDone();
      return delegator;
    };

    // Submenu factory: searchable-pick an option, then enter a numeric value.
    // Used for both per-provider and per-model limits; items differ by caller.
    const addPickThenValueSubmenu = (
      items: SelectOption[],
      onPick: (key: string, parsed: number) => void,
    ): SettingItem["submenu"] => (_currentValue, subDone) =>
      createSearchableSelect(
        items,
        {
          onSelect: (key) =>
            createNumericSubmenu(ctx, { min: 1 }, (parsed) => onPick(key, parsed))("1", subDone),
          onCancel: () => subDone(),
        },
        theme,
      );

    // Global default
    items.push({
      id: "defaultConcurrency",
      label: "Default concurrency limit",
      currentValue: String(store.concurrency.default),
      description: "Concurrent agent slots when no per-provider or per-model limit applies.",
      submenu: createNumericSubmenu(ctx, (parsed) => {
        store.mutate.concurrency.setDefault(parsed);
        ctx.ui.notify(`Default concurrency set to ${parsed}`, "info");
      }),
    });

    // Per-provider limits
    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({ id: "__sep__", label: "── Per-provider limits ──", currentValue: "────────" });
    const providerLimits = store.concurrency.providers;
    for (const provider of Object.keys(providerLimits)) {
      const limit = providerLimits[provider];
      items.push({
        id: `provider:${provider}`,
        label: provider,
        currentValue: `${limit} slots`,
        description: `Concurrent slots reserved for agents using the ${provider} provider.`,
        submenu: editOrRemoveSubmenu(
          limit,
          (parsed) => {
            store.mutate.concurrency.setProvider(provider, parsed);
            ctx.ui.notify(`${provider} concurrency set to ${parsed}`, "info");
          },
          () => {
            store.mutate.concurrency.removeProvider(provider);
            ctx.ui.notify(`Removed per-provider limit for ${provider}`, "info");
          },
        ),
      });
    }

    items.push({ id: "__sep__", label: "─────────────────────────", currentValue: "────────" });
    // Add per-provider limit (submenu: provider selection → numeric input)
    if (providers.length > 0) {
      items.push({
        id: "addProviderLimit",
        label: "Add per-provider limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single provider.",
        submenu: addPickThenValueSubmenu(providers.map((o) => ({ value: o, label: o })), (provider, parsed) => {
          store.mutate.concurrency.setProvider(provider, parsed);
          ctx.ui.notify(`${provider} concurrency set to ${parsed}`, "info");
        }),
      });
    }

    // Per-model limits
    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({ id: "__sep__", label: "── Per-model limits ──", currentValue: "────────" });
    const models = store.concurrency.models;
    for (const modelKey of Object.keys(models)) {
      const limit = models[modelKey];
      items.push({
        id: `model:${modelKey}`,
        label: modelKey,
        currentValue: `${limit} slots`,
        description: `Concurrent slots reserved for agents using the ${modelKey} model.`,
        submenu: editOrRemoveSubmenu(
          limit,
          (parsed) => {
            store.mutate.concurrency.setModel(modelKey, parsed);
            ctx.ui.notify(`${modelKey} concurrency set to ${parsed}`, "info");
          },
          () => {
            store.mutate.concurrency.removeModel(modelKey);
            ctx.ui.notify(`Removed per-model limit for ${modelKey}`, "info");
          },
        ),
      });
    }

    // Add per-model limit
    items.push({ id: "__sep__", label: "─────────────────────────", currentValue: "────────" });
    if (modelOptions.length > 0) {
      items.push({
        id: "addModelLimit",
        label: "Add per-model limit...",
        currentValue: "",
        description: "Cap how many agents run at once for a single model.",
        submenu: addPickThenValueSubmenu(buildModelOptions(modelOptions), (modelKey, parsed) => {
          store.mutate.concurrency.setModel(modelKey, parsed);
          ctx.ui.notify(`${modelKey} concurrency set to ${parsed}`, "info");
        }),
      });
    }

    // Reset all to defaults
    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({
      id: "resetAll",
      label: "Reset all to defaults",
      currentValue: "",
      description: "Restore the default limit and remove all per-provider and per-model limits.",
      submenu: createConfirmSubmenu({
        message: "Reset all concurrency limits to defaults?",
        theme,
        onConfirm: () => {
          store.mutate.concurrency.reset();
          ctx.ui.notify("Concurrency reset to defaults", "info");
        },
      }),
    });

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const triggerRebuild = () => rebuild?.(buildItems(getStore(), theme, modelOptions, triggerRebuild));
    const store = getStore();
    const items = buildItems(store, theme, modelOptions, triggerRebuild);
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), (_id, _v) => triggerRebuild(), () => done(undefined));
    return new SettingsListWrapper(settingsList, {
      title: "Concurrency Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => { rebuild = r; },
    });
  });
}
