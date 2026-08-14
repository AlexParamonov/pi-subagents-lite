/**
 * model-select-submenu.ts — Target + model override submenu (ADR-0008).
 *
 * Step 1: SelectList with the target layer (session/global/project) or
 *         "Clear..." for a nested per-level clear.
 * Step 2 (set): SearchableSelectDialog for model selection.
 * Step 2 (clear): target-level picker (session/global/project/all levels).
 *
 * The submenu factory must be created inside ctx.ui.custom to capture the theme.
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { SearchableSelectDialog } from "../../../ui/searchable-select.js";
import { buildModelOptions, buildSelectListTheme, createDelegatingComponent } from "../helpers.js";
import { createTargetSelectSubmenu, type TargetChoice } from "./target-select.js";

export interface ModelSelectSubmenuOptions {
  modelOptions: string[];
  /** Whether to offer the nested "Clear..." flow. */
  showClear: boolean;
  /** Project target availability (untrusted/malformed projects hide the entry). */
  projectOffered: boolean;
  theme: Theme;
  /** Effective model for pre-selecting the current value in the picker. */
  currentModel?: string | null;
  onSet: (target: "session" | "global" | "project", model: string | null) => void;
  /** Clear the key at the picked layer; required when showClear is set. */
  onClear?: (target: TargetChoice) => void;
}

export function createModelSelectSubmenu(
  options: ModelSelectSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue, done) => {
    const modeItems = [
      { value: "session", label: "Set for this session (not saved)" },
      { value: "global", label: "Set globally (saves to config)" },
      ...(options.projectOffered ? [{ value: "project", label: "Set for this project" }] : []),
    ];
    if (options.showClear) modeItems.push({ value: "clear", label: "Clear..." });

    const modeList = new SelectList(modeItems, 6, buildSelectListTheme(options.theme));
    const delegator = createDelegatingComponent(modeList);

    const currentModel =
      options.currentModel == null || options.currentModel === "(inherits parent)" ? null : options.currentModel;

    modeList.onSelect = (item) => {
      if (item.value === "clear") {
        // "Clear..." is offered only when showClear is set, which callers pair with onClear.
        delegator.setActive(
          createTargetSelectSubmenu({
            theme: options.theme,
            projectOffered: options.projectOffered,
            includeAll: true,
            onPick: (target) => options.onClear?.(target),
          })("", done),
        );
        return;
      }
      const target = item.value as "session" | "global" | "project";
      delegator.setActive(
        new SearchableSelectDialog(
          buildModelOptions(options.modelOptions),
          currentModel,
          {
            onSelect: (modelValue) => {
              options.onSet(target, modelValue);
              done(modelValue);
            },
            onCancel: () => done(),
          },
          options.theme,
        ),
      );
    };
    modeList.onCancel = () => done();

    return delegator;
  };
}
