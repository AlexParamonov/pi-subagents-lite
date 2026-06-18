/**
 * menu-numeric-input-submenu.ts — Shared numeric input submenu Component.
 *
 * Creates a submenu factory for SettingsList items that need numeric input
 * with validation. Returns an Input component that validates on submit.
 */

import { Input, type Component } from "@earendil-works/pi-tui";

import { validateNumeric } from "./menu-helpers.js";

export interface NumericInputSubmenuOptions {
  /** Minimum allowed value (inclusive) */
  min: number;
  /** Label for error message, e.g. "≥ 1" */
  minLabel: string;
  /** Called with parsed value on valid submit */
  onValid: (parsed: number) => void;
  /** Called with error message on invalid submit */
  onError: (message: string) => void;
}

/**
 * Creates a submenu factory function compatible with SettingsList's submenu callback.
 * Usage: submenu: createNumericInputSubmenu({ min, minLabel, onValid, onError })
 */
export function createNumericInputSubmenu(
  options: NumericInputSubmenuOptions,
): (currentValue: string, done: (selectedValue?: string) => void) => Component {
  return (currentValue: string, done: (selectedValue?: string) => void) => {
    const input = new Input();
    input.setValue(currentValue);
    input.onSubmit = (value) => {
      const parsed = validateNumeric(value, options.min);
      if (parsed === undefined) {
        options.onError(`Invalid value — must be a number ${options.minLabel}`);
        return;
      }
      options.onValid(parsed);
      done(String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}
