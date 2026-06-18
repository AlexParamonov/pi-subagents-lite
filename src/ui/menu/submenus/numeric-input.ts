/**
 * numeric-input-submenu.ts — Shared input submenu Components.
 *
 * - createNumericSubmenu: numeric input with validation
 * - createInputSubmenu: plain text input
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, type Component } from "@earendil-works/pi-tui";

import { validateNumeric } from "../helpers.js";

/**
 * Returns a `(initialValue, done) => submenu` function wired to
 * `ctx.ui.notify` for errors.
 *
 * If `required` is true, empty input errors.
 * If `required` is false (default), empty input calls `done()` to clear.
 *
 * Usage:
 *   createNumericSubmenu(ctx, onValid)
 *   createNumericSubmenu(ctx, { min, required? }, onValid, onEmpty?)
 */
export function createNumericSubmenu(
  ctx: ExtensionCommandContext,
  optionsOrCallback?: { min?: number; required?: boolean; default?: number } | ((parsed: number) => void),
  onValid?: (parsed: number) => void,
  onEmpty?: () => void,
): (initialValue: string, done: (selectedValue?: string) => void) => Component {
  const opts = typeof optionsOrCallback === "function"
    ? { onValid: optionsOrCallback }
    : { onValid, ...optionsOrCallback };
  const min = opts.min ?? 1;
  const required = opts.required ?? false;
  const fmtLabel = (n: number) => (n === 0 ? "\u2265 0" : `\u2265 ${n}`);
  const onError = (msg: string) => ctx.ui.notify(msg, "error");

  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue === "(not set)" ? "" : initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed || /^unlimited$/i.test(trimmed)) {
        if (required) {
          onError(`Invalid value \u2014 must be a number ${fmtLabel(min)}`);
          return;
        }
        if (opts.default != null) {
          opts.onValid?.(opts.default);
          done(String(opts.default));
        } else {
          onEmpty?.();
          done("(not set)");
        }
        return;
      }
      const parsed = validateNumeric(trimmed, min);
      if (parsed === undefined) {
        onError(`Invalid value \u2014 must be a number ${fmtLabel(min)}`);
        return;
      }
      opts.onValid?.(parsed);
      done(String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}

/**
 * Returns a `(initialValue, done) => Input` function for plain text submenus.
 *
 * If `required` is true, empty input shows an error and does not call `done`.
 * If `required` is false (default), empty input calls `done()` to clear.
 */
export function createInputSubmenu(
  ctx: ExtensionCommandContext,
  options?: { required?: boolean },
): (initialValue: string, done: (value?: string) => void) => Input {
  return (initialValue, done) => {
    const input = new Input();
    input.setValue(initialValue);
    input.onSubmit = (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        if (options?.required) {
          ctx.ui.notify("Cannot be empty", "error");
          return;
        }
        done();
        return;
      }
      done(trimmed);
    };
    input.onEscape = () => done();
    return input;
  };
}
