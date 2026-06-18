/**
 * menu-helpers.ts — Shared helpers for menu modules.
 *
 * Exports:
 *   - promptModelSelection: shows ModelSelectorDialog (used by spawn-wizard)
 *   - buildSettingsListTheme: builds SettingsListTheme from pi-coding-agent Theme
 *   - buildSelectListTheme: builds SelectListTheme from pi-coding-agent Theme
 *   - validateNumeric: pure numeric validation (no UI)
 *   - createDelegatingComponent: swappable-component proxy for submenu transitions
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingsListTheme, SettingItem } from "@earendil-works/pi-tui";
import { ModelSelectorDialog, type ModelOption } from "../../models/model-selector.js";
import { parseModelKey } from "../../utils.js";

/**
 * Build ModelOption[] from raw "provider/model-id" strings.
 * Includes "(inherits parent)" as the first option.
 */
export function buildModelOptions(rawOptions: string[]): ModelOption[] {
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
 * Build a SettingsListTheme from a pi-coding-agent Theme.
 * Shared by widget settings and future SettingsList-based menus.
 */
export function buildSettingsListTheme(theme: { fg(color: string, text: string): string; bold(text: string): string }): SettingsListTheme {
  return {
    label: (text, selected) => selected ? theme.fg("accent", text) : text,
    value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text) => theme.fg("muted", text),
    // Use "→ " (2 chars) to match non-selected prefix "  " (2 spaces)
    // This prevents menu items from shifting left/right when cursor moves
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

/**
 * Pure numeric validation. Returns parsed integer ≥ min, or undefined.
 * Extracted from parseNumericInput for use in submenu Components.
 */
export function validateNumeric(value: string, min: number): number | undefined {
  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed) || parsed < min) return undefined;
  return parsed;
}

/**
 * Create a "Back" item that closes the whole SettingsList menu.
 *
 * SettingsList has no native action item: activating an item needs a submenu
 * or values. So Back is a submenu that immediately closes both the submenu
 * (subDone) and the parent menu (closeMenu). Returning undefined skips
 * rendering a submenu body.
 */
export function backSubmenuItem(closeMenu: () => void): SettingItem {
  return {
    id: "back",
    label: "Back",
    currentValue: "",
    submenu: (_v, subDone) => {
      subDone();
      closeMenu();
      return undefined as any;
    },
  };
}

/**
 * Create a Component that delegates to a swappable inner component.
 * Use in submenus that switch between SelectList → Input (or similar).
 */
export function createDelegatingComponent(initial: Component): Component & { setActive(c: Component): void } {
  let active = initial;
  return {
    invalidate() { active.invalidate?.(); },
    render(width: number) { return active.render(width); },
    handleInput(data: string) { active.handleInput?.(data); },
    setActive(c: Component) { active = c; },
  };
}

/**
 * Build a SelectListTheme from a pi-coding-agent Theme.
 * Produces identical visual style to buildSettingsListTheme:
 *   → cursor, accent colors, muted descriptions.
 */
export function buildSelectListTheme(theme: { fg(color: string, text: string): string; bold(text: string): string }): import("@earendil-works/pi-tui").SelectListTheme {
  return {
    selectedPrefix: () => theme.fg("accent", "→ "),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("dim", text),
  };
}

