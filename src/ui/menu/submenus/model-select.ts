/**
 * model-select-submenu.ts — 2-step model override submenu.
 *
 * Step 1: SelectList with override mode (session/permanent/clear)
 * Step 2 (if session/permanent): SearchableSelectDialog for model selection
 *
 * The submenu factory must be created inside ctx.ui.custom to capture the theme.
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog, type SelectOption } from "../../../ui/searchable-select.js";
import { buildModelOptions, buildSelectListTheme, createDelegatingComponent } from "../helpers.js";

export interface ModelSelectSubmenuOptions {
  modelOptions: string[];
  showClear: boolean;
  theme: Theme;
  onSelect: (mode: "session" | "permanent" | "clear", model: string | null) => void;
}

/**
 * Creates a submenu factory for SettingsList items that need the 2-step
 * model override flow (mode selection → model selection).
 */
export function createModelSelectSubmenu(
  options: ModelSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    let selectedMode: "session" | "permanent" = "session";

    const modeItems = [
      { value: "session", label: "Set for this session (not saved)" },
      { value: "permanent", label: "Set permanently (saved to config)" },
    ];
    if (options.showClear) {
      modeItems.push({ value: "clear", label: "Clear" });
    }

    const modeList = new SelectList(modeItems, 5, buildSelectListTheme(options.theme));

    const delegator = createDelegatingComponent(modeList);

    modeList.onSelect = (item) => {
      if (item.value === "clear") {
        options.onSelect("clear", null);
        done("clear");
        return;
      }
      selectedMode = item.value as "session" | "permanent";
      delegator.setActive(modelSelector);
    };
    modeList.onCancel = () => done();

    const modelOpts = buildModelOptions(options.modelOptions);
    const modelSelector = new SearchableSelectDialog(
      modelOpts,
      _currentValue === "(inherits parent)" ? null : _currentValue,
      {
        onSelect: (modelValue) => {
          options.onSelect(selectedMode, modelValue);
          done(modelValue);
        },
        onCancel: () => done(),
      },
      options.theme,
    );

    return delegator;
  };
}
