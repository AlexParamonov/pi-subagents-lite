/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Structure:
 *   Main list: compact, maxLines, maxLinesCompact, shortcut, usageStats
 *   Usage stats submenu: 7 stat visibility toggles
 *
 * Exports:
 *   - showWidgetSettingsMenu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, Input, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme, validateNumeric } from "./menu-helpers.js";
import { getStore } from "../../shell.js";

/** Stat toggle with store setter — used for data-driven onChange. */
interface StatToggleItem extends SettingItem {
  set: (value: boolean) => void;
}

/** Stat visibility toggle definitions (shared between main and submenu). */
function buildStatToggleItems(store: ReturnType<typeof getStore>): StatToggleItem[] {
  const defs: Array<{ id: string; label: string; get: () => boolean; set: (v: boolean) => void }> = [
    { id: "showTools", label: "Show tools", get: () => store.agent.showTools, set: (v) => store.mutate.agent.setShowTools(v) },
    { id: "showTurns", label: "Show turns", get: () => store.agent.showTurns, set: (v) => store.mutate.agent.setShowTurns(v) },
    { id: "showInput", label: "Show input tokens", get: () => store.agent.showInput, set: (v) => store.mutate.agent.setShowInput(v) },
    { id: "showOutput", label: "Show output tokens", get: () => store.agent.showOutput, set: (v) => store.mutate.agent.setShowOutput(v) },
    { id: "showContext", label: "Show context %", get: () => store.agent.showContext, set: (v) => store.mutate.agent.setShowContext(v) },
    { id: "showCost", label: "Show cost", get: () => store.agent.showCost, set: (v) => store.mutate.agent.setShowCost(v) },
    { id: "showTime", label: "Show time", get: () => store.agent.showTime, set: (v) => store.mutate.agent.setShowTime(v) },
  ];

  return defs.map((d) => ({
    id: d.id,
    label: d.label,
    currentValue: d.get() ? "ON" : "OFF",
    values: ["ON", "OFF"],
    set: d.set,
  }));
}

/** Create a submenu for numeric input using pi-tui Input. */
function createNumericSubmenu(
  initialValue: string,
  min: number,
  onValid: (parsed: number) => void,
  minLabel: string,
  ctx: ExtensionCommandContext,
): (currentValue: string, done: (selectedValue?: string) => void) => InstanceType<typeof Input> {
  return (currentValue, done) => {
    const input = new Input();
    input.setValue(currentValue);
    input.onSubmit = (value) => {
      const parsed = validateNumeric(value, min);
      if (parsed === undefined) {
        ctx.ui.notify(`Invalid value — must be a number ${minLabel}`, "error");
        return;
      }
      onValid(parsed);
      done(String(parsed));
    };
    input.onEscape = () => done();
    return input;
  };
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const statItems = buildStatToggleItems(store);

  const onChange = (id: string, newValue: string) => {
    // Stat toggles are data-driven via their set() closures
    const stat = statItems.find((s) => s.id === id);
    if (stat) {
      stat.set(newValue === "ON");
      ctx.ui.notify(`${stat.label} ${newValue}`, "info");
      return;
    }

    // Non-stat items (compact, shortcut) handled directly
    switch (id) {
      case "compact":
        store.mutate.widget.setCompact(newValue === "ON");
        ctx.ui.notify(`Force compact mode ${newValue}`, "info");
        break;
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
    }
  };

  const maxLinesSubmenu = createNumericSubmenu(
    String(store.agent.widgetMaxLines), 2,
    (parsed) => { store.mutate.widget.setMaxLines(parsed); ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info"); },
    "≥ 2", ctx,
  );

  const maxLinesCompactSubmenu = createNumericSubmenu(
    String(store.agent.widgetMaxLinesCompact), 1,
    (parsed) => { store.mutate.widget.setMaxLinesCompact(parsed); ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info"); },
    "≥ 1", ctx,
  );

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "compact",
        label: "Force compact mode",
        currentValue: store.agent.widgetCompact ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      {
        id: "maxLines",
        label: "Max lines (full)",
        currentValue: String(store.agent.widgetMaxLines),
        submenu: maxLinesSubmenu,
      },
      {
        id: "maxLinesCompact",
        label: "Max lines (compact)",
        currentValue: String(store.agent.widgetMaxLinesCompact),
        submenu: maxLinesCompactSubmenu,
      },
      {
        id: "shortcut",
        label: "Ctrl+o shortcut",
        currentValue: store.agent.widgetShortcut ? "ON" : "OFF",
        values: ["ON", "OFF"],
      },
      {
        id: "usageStats",
        label: "Usage stats",
        currentValue: "",
        submenu: (_currentValue, done2) =>
          new SettingsList(statItems, 7, buildSettingsListTheme(theme), onChange, () => done2()),
      },
    ];

    return new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, () => done(undefined));
  });
}
