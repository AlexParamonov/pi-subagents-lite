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
import { buildSettingsListTheme, buildSelectListTheme, createDelegatingComponent } from "./menu-helpers.js";
import { createNumericInputSubmenu } from "./menu-numeric-input-submenu.js";
import { createConfirmSubmenu } from "./menu-confirm-submenu.js";
import { SettingsListWrapper } from "./menu-settings-list-wrapper.js";
import { getStore } from "../../shell.js";

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore();
    const items: SettingItem[] = [];

    // Submenu factory for numeric input with validation ≥ 1.
    const numericSubmenu = (onValid: (parsed: number) => void) =>
      createNumericInputSubmenu({
        min: 1,
        minLabel: "≥ 1",
        onValid,
        onError: (msg) => ctx.ui.notify(msg, "error"),
      });

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
          delegator.setActive(numericSubmenu(onEdit)(String(currentLimit), subDone));
        } else {
          onRemove();
          subDone();
        }
      };
      list.onCancel = () => subDone();
      return delegator;
    };

    // Submenu factory: pick a key from `options`, then enter a value.
    const addLimitSubmenu = (
      options: string[],
      onPick: (key: string, parsed: number) => void,
    ): SettingItem["submenu"] => (_currentValue, subDone) => {
      const list = new SelectList(
        options.map((o) => ({ value: o, label: o })),
        10, buildSelectListTheme(theme),
      );
      const delegator = createDelegatingComponent(list);
      list.onSelect = (item) => {
        delegator.setActive(numericSubmenu((parsed) => onPick(item.value, parsed))("1", subDone));
      };
      list.onCancel = () => subDone();
      return delegator;
    };

    // Global default
    items.push({
      id: "defaultConcurrency",
      label: "Default concurrency limit",
      currentValue: String(store.concurrency.default),
      submenu: numericSubmenu((parsed) => {
        store.mutate.concurrency.setDefault(parsed);
        ctx.ui.notify(`Default concurrency set to ${parsed}`, "info");
      }),
    });

    // Per-provider limits
    const providerLimits = store.concurrency.providers;
    for (const provider of Object.keys(providerLimits)) {
      const limit = providerLimits[provider];
      items.push({
        id: `provider:${provider}`,
        label: provider,
        currentValue: `${limit} slots`,
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

    // Add per-provider limit (submenu: provider selection → numeric input)
    if (providers.length > 0) {
      items.push({
        id: "addProviderLimit",
        label: "Add per-provider limit...",
        currentValue: "",
        submenu: addLimitSubmenu(providers, (provider, parsed) => {
          store.mutate.concurrency.setProvider(provider, parsed);
          ctx.ui.notify(`${provider} concurrency set to ${parsed}`, "info");
        }),
      });
    }

    // Per-model limits
    const models = store.concurrency.models;
    for (const modelKey of Object.keys(models)) {
      const limit = models[modelKey];
      items.push({
        id: `model:${modelKey}`,
        label: modelKey,
        currentValue: `${limit} slots`,
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
    if (modelOptions.length > 0) {
      items.push({
        id: "addModelLimit",
        label: "Add per-model limit...",
        currentValue: "",
        submenu: addLimitSubmenu(modelOptions, (modelKey, parsed) => {
          store.mutate.concurrency.setModel(modelKey, parsed);
          ctx.ui.notify(`${modelKey} concurrency set to ${parsed}`, "info");
        }),
      });
    }

    // Reset all to defaults
    items.push({
      id: "resetAll",
      label: "Reset all to defaults",
      currentValue: "",
      submenu: createConfirmSubmenu({
        message: "Reset all concurrency limits to defaults?",
        theme,
        onConfirm: () => {
          store.mutate.concurrency.reset();
          ctx.ui.notify("Concurrency reset to defaults", "info");
        },
      }),
    });

    // No items use the `values` cycle path; all changes flow through submenus.
    const onChange = (_id: string, _newValue: string) => {};

    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Concurrency Settings", theme });
  });
}
