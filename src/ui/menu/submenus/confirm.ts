/**
 * confirm-submenu.ts — Yes/no confirm dialog for destructive actions.
 *
 * Creates a submenu factory for SettingsList items that need a confirmation
 * dialog (clear overrides, reset concurrency, etc.).
 */

import { SelectList, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../types.js";
import { buildSelectListTheme } from "../helpers.js";

export interface ConfirmSubmenuOptions {
  /** Message shown to the user */
  message: string;
  /** Theme from pi-coding-agent (fg, bold, italic) */
  theme: Theme;
  /** Called when user confirms (selects Yes) */
  onConfirm: () => void;
}

/**
 * Creates a submenu factory function compatible with SettingsList's submenu callback.
 * Shows a Yes/No SelectList. Calls onConfirm on Yes, done() to close.
 */
export function createConfirmSubmenu(
  options: ConfirmSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (_currentValue: string, done: (selectedValue?: string) => void) => {
    const items = [
      { value: "Yes", label: "Yes", description: options.message },
      { value: "No", label: "No", description: options.message },
    ];

    const list = new SelectList(items, 5, buildSelectListTheme(options.theme));

    list.onSelect = (item) => {
      if (item.value === "Yes") {
        options.onConfirm();
        done("Yes");
      } else {
        done();
      }
    };
    list.onCancel = () => done();

    return list;
  };
}
