/**
 * menu-helpers.ts — Shared helpers for menu modules.
 *
 * Exports only helpers used by 2+ menu concerns:
 *   - runMenuLoop: loops a menu until Escape/Back
 *   - runMenu: shows a single-shot menu and dispatches
 *   - promptModelSelection: shows ModelSelectorDialog
 *   - parseNumericInput: validates numeric input
 *   - matchMenuChoice: maps choice string to handler key
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ModelSelectorDialog, type ModelOption } from "../../models/model-selector.js";
import { parseModelKey } from "../../utils.js";

/**
 * Build ModelOption[] from raw "provider/model-id" strings.
 * Includes "(inherits parent)" as the first option.
 */
function buildModelOptions(rawOptions: string[]): ModelOption[] {
  const items: ModelOption[] = [
    { value: "(inherits parent)", label: "(inherits parent)", provider: "" },
  ];

  for (const opt of rawOptions) {
    const parsed = parseModelKey(opt);
    if (!parsed) continue;
    items.push({ value: opt, label: parsed.modelId, provider: parsed.provider });
  }
  return items;
}

/**
 * Show the ModelSelectorDialog and return the chosen model string, or null.
 */
export async function promptModelSelection(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
  currentValue: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) => {
      const opts = buildModelOptions(modelOptions);
      return new ModelSelectorDialog(opts, currentValue, {
        onSelect: (m) => done(m),
        onCancel: () => done(null),
      }, theme);
    }, // no overlay — renders inline below editor, matching pi's model selector look and feel
  );
}

/**
 * Prompt for numeric input, validate (integer ≥ min), return parsed value or undefined.
 * Returns undefined if the user cancels or the value is invalid.
 */
export async function parseNumericInput(
  ctx: ExtensionCommandContext,
  label: string,
  initialValue: string,
  min: number,
  minLabel: string,
): Promise<number | undefined> {
  const input = await ctx.ui.input(label, initialValue);
  if (input === undefined) return undefined;
  const parsed = parseInt(input.trim(), 10);
  if (isNaN(parsed) || parsed < min) {
    ctx.ui.notify(`Invalid value — must be a number ${minLabel}`, "error");
    return undefined;
  }
  return parsed;
}

/**
 * Show a select menu once, dispatch the chosen action.
 * Used by the per-agent action sub-menu (single-shot, not a loop).
 */
export async function runMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[],
  actions: Array<() => Promise<void>>,
): Promise<void> {
  const choice = await ctx.ui.select(title, items);
  if (choice === undefined) return;
  const idx = items.indexOf(choice);
  if (idx >= 0 && idx < actions.length) {
    await actions[idx]();
  }
}

/**
 * Loop a menu until the user presses Escape or selects "Back".
 * Rebuilds items/actions each iteration so the display stays fresh.
 * Appends blank spacer + "Back" automatically.
 * Used by model settings, concurrency settings, and running agents menus.
 */
export async function runMenuLoop(
  ctx: ExtensionCommandContext,
  title: string,
  build: () => { items: string[]; actions: Array<() => Promise<void>> },
): Promise<void> {
  while (true) {
    const { items, actions } = build();
    items.push("");
    actions.push(async () => {});
    items.push("Back");
    actions.push(async () => {});

    const choice = await ctx.ui.select(title, items);
    if (choice === undefined || choice === "Back") return;
    const idx = items.indexOf(choice);
    if (idx >= 0 && idx < actions.length) {
      await actions[idx]();
    }
  }
}

/** Map menu choice to handler. Matches by number prefix or first word. */
export function matchMenuChoice(
  choice: string,
  handlers: Record<string, () => Promise<void>>,
): (() => Promise<void>) | undefined {
  // Try number prefix first (e.g., "1." from "1. Running agents")
  const numMatch = choice.match(/^(\d+)/);
  if (numMatch) return handlers[numMatch[1]];
  // Fall back to first word
  const key = choice.split(" ")[0].toLowerCase();
  return handlers[key];
}
