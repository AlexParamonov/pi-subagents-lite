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

/** Stat visibility toggle definitions (shared between main and submenu). */
function buildStatToggleItems(store: ReturnType<typeof getStore>): SettingItem[] {
  const statToggles: Array<{ id: string; label: string; getter: () => boolean; setter: (v: boolean) => void }> = [
    { id: "showTools", label: "Show tools", getter: () => store.agent.showTools, setter: (v) => store.mutate.agent.setShowTools(v) },
    { id: "showTurns", label: "Show turns", getter: () => store.agent.showTurns, setter: (v) => store.mutate.agent.setShowTurns(v) },
    { id: "showInput", label: "Show input tokens", getter: () => store.agent.showInput, setter: (v) => store.mutate.agent.setShowInput(v) },
    { id: "showOutput", label: "Show output tokens", getter: () => store.agent.showOutput, setter: (v) => store.mutate.agent.setShowOutput(v) },
    { id: "showContext", label: "Show context %", getter: () => store.agent.showContext, setter: (v) => store.mutate.agent.setShowContext(v) },
    { id: "showCost", label: "Show cost", getter: () => store.agent.showCost, setter: (v) => store.mutate.agent.setShowCost(v) },
    { id: "showTime", label: "Show time", getter: () => store.agent.showTime, setter: (v) => store.mutate.agent.setShowTime(v) },
  ];

  return statToggles.map((t) => ({
    id: t.id,
    label: t.label,
    currentValue: t.getter() ? "ON" : "OFF",
    values: ["ON", "OFF"],
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
    switch (id) {
      case "compact":
        store.mutate.widget.setCompact(newValue === "ON");
        ctx.ui.notify(`Force compact mode ${newValue}`, "info");
        break;
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
      case "showTools":
        store.mutate.agent.setShowTools(newValue === "ON");
        ctx.ui.notify(`Show tools ${newValue}`, "info");
        break;
      case "showTurns":
        store.mutate.agent.setShowTurns(newValue === "ON");
        ctx.ui.notify(`Show turns ${newValue}`, "info");
        break;
      case "showInput":
        store.mutate.agent.setShowInput(newValue === "ON");
        ctx.ui.notify(`Show input tokens ${newValue}`, "info");
        break;
      case "showOutput":
        store.mutate.agent.setShowOutput(newValue === "ON");
        ctx.ui.notify(`Show output tokens ${newValue}`, "info");
        break;
      case "showContext":
        store.mutate.agent.setShowContext(newValue === "ON");
        ctx.ui.notify(`Show context % ${newValue}`, "info");
        break;
      case "showCost":
        store.mutate.agent.setShowCost(newValue === "ON");
        ctx.ui.notify(`Show cost ${newValue}`, "info");
        break;
      case "showTime":
        store.mutate.agent.setShowTime(newValue === "ON");
        ctx.ui.notify(`Show time ${newValue}`, "info");
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
