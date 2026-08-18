/**
 * model-select-submenu.ts — Target + model override submenu (ADR-0008).
 *
 * Step 1: SettingsList level picker (session/global/project) or
 *         "Clear..." for a nested per-level clear.
 * Step 2 (set): SearchableSelectDialog for model selection.
 * Step 2 (clear): target-level picker (session/global/project/all levels).
 *
 * The submenu factory must be created inside ctx.ui.custom to capture the theme.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog } from "../../../ui/searchable-select.js";
import { buildModelOptions, extractConfiguredModels } from "../helpers.js";
import { getStore } from "../../../shell.js";
import {
  buildLevelItems,
  createClearPickerSubmenu,
  createLevelPickerSubmenu,
  type AvailableLevels,
  type TargetChoice,
} from "./target-select.js";

export interface ModelSelectSubmenuOptions {
  modelOptions: string[];
  /** Whether to offer the nested "Clear..." flow. */
  showClear: boolean;
  /** Project target availability (untrusted/malformed projects hide the entry). */
  projectOffered: boolean;
  theme: Theme;
  /** Effective model for pre-selecting the current value in the picker. */
  currentModel?: string | null;
  /** Opt-in availability for the nested clear picker; see target-select. */
  availableLevels?: AvailableLevels;
  onSet: (target: "session" | "global" | "project", model: string | null) => void;
  /** Clear the key at the picked layer; required when showClear is set. */
  onClear?: (target: TargetChoice) => void;
}

export function createModelSelectSubmenu(
  options: ModelSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  const currentModel =
    options.currentModel == null || options.currentModel === "(inherits parent)" ? null : options.currentModel;

  return createLevelPickerSubmenu({
    theme: options.theme,
    items: buildLevelItems({
      offered: { session: true, global: true, project: options.projectOffered },
      includeClear: options.showClear === true,
    }),
    onPick: (id, subDone) => {
      if (id === "clear") {
        // "Clear..." is offered only when showClear is set, which callers pair with onClear.
        return createClearPickerSubmenu({
          theme: options.theme,
          projectOffered: options.projectOffered,
          availableLevels: options.availableLevels,
          onClear: (target) => options.onClear?.(target),
        })("", subDone);
      }
      const target = id as "session" | "global" | "project";
      const store = getStore();
      const configuredModels = extractConfiguredModels(store.agentConfigSnapshot());
      return new SearchableSelectDialog(
        buildModelOptions(options.modelOptions, currentModel, configuredModels),
        currentModel,
        {
          onSelect: (modelValue) => {
            options.onSet(target, modelValue);
            subDone(modelValue);
          },
          onCancel: () => subDone(),
        },
        options.theme,
      );
    },
  });
}
