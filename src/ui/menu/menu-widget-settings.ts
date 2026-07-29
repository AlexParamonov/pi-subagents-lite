/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Structure:
 *   One flat list containing all widget appearance, sizing, behavior, and stat controls.
 *
 * Exports:
 *   - showWidgetSettingsMenu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

/** Stat visibility config — label and store accessors keyed by stat id. */
function buildStatConfig(store: ReturnType<typeof getStore>) {
  return new Map<string, { label: string; get: () => boolean; set: (v: boolean) => void }>([
    ["showTools", { label: "Show tools", get: () => store.agent.showTools, set: (v) => store.mutate.agent.setShowTools(v) }],
    ["showTurns", { label: "Show turns", get: () => store.agent.showTurns, set: (v) => store.mutate.agent.setShowTurns(v) }],
    ["showInput", { label: "Show input tokens", get: () => store.agent.showInput, set: (v) => store.mutate.agent.setShowInput(v) }],
    ["showOutput", { label: "Show output tokens", get: () => store.agent.showOutput, set: (v) => store.mutate.agent.setShowOutput(v) }],
    ["showContext", { label: "Show context %", get: () => store.agent.showContext, set: (v) => store.mutate.agent.setShowContext(v) }],
    ["showCost", { label: "Show cost", get: () => store.agent.showCost, set: (v) => store.mutate.agent.setShowCost(v) }],
    ["showTime", { label: "Show time", get: () => store.agent.showTime, set: (v) => store.mutate.agent.setShowTime(v) }],
  ]);
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const statConfig = buildStatConfig(store);

  const onChange = (id: string, newValue: string) => {
    const stat = statConfig.get(id);
    if (stat) {
      stat.set(newValue === "ON");
      ctx.ui.notify(`${stat.label} ${newValue}`, "info");
      return;
    }

    switch (id) {
      case "compact":
        store.mutate.widget.setCompact(newValue === "ON");
        ctx.ui.notify(`Force compact mode ${newValue}`, "info");
        break;
      case "showModelThinking":
        store.mutate.widget.setShowModelThinking(newValue === "ON");
        ctx.ui.notify(`Show model & thinking ${newValue}`, "info");
        break;
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
      case "thinkingBuffer":
        store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
        ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
        break;
      case "showStartTime":
        store.mutate.widget.setShowStartTime(newValue === "ON");
        ctx.ui.notify(`Show local start time ${newValue}`, "info");
        break;
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const statDescriptions: Record<string, string> = {
      showTools: "Show tool count (⚙︎) in the widget.",
      showTurns: "Show turn count (⟳ ) in the widget.",
      showInput: "Show input tokens (↑) in the widget.",
      showOutput: "Show output tokens (↓) in the widget.",
      showContext: "Show context-fill percent (%) in the widget.",
      showCost: "Show dollar cost ($) in the widget.",
      showTime: "Show elapsed time in the widget.",
    };
    const statItems: SettingItem[] = [...statConfig.entries()].map(([id, cfg]) => ({
      id,
      label: cfg.label,
      currentValue: cfg.get() ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: statDescriptions[id],
    }));

    const items: SettingItem[] = [
      {
        id: "compact",
        label: "Force compact mode",
        currentValue: store.agent.widgetCompact ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Force compact widget mode regardless of ctrl+o state.",
      },
      {
        id: "shortcut",
        label: "Ctrl+o shortcut",
        currentValue: store.agent.widgetShortcut ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "When ON, ctrl+o toggles compact mode; when OFF, compact is set manually.",
      },
      {
        id: "maxLines",
        label: "Max lines (full)",
        currentValue: String(store.agent.widgetMaxLines),
        submenu: createNumericSubmenu(ctx, { min: 2 }, (parsed) => {
          store.mutate.widget.setMaxLines(parsed);
          ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info");
        }),
        description: "Maximum body lines in the full widget, excluding its heading.",
      },
      {
        id: "maxLinesCompact",
        label: "Max lines (compact)",
        currentValue: String(store.agent.widgetMaxLinesCompact),
        submenu: createNumericSubmenu(ctx, { min: 2 }, (parsed) => {
          store.mutate.widget.setMaxLinesCompact(parsed);
          ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info");
        }),
        description: "Max total lines in compact widget mode, including the heading.",
      },
      {
        id: "descLengthFull",
        label: "Description length (full)",
        currentValue: String(store.agent.widgetDescLengthFull),
        submenu: createNumericSubmenu(ctx, { min: 5 }, (parsed) => {
          store.mutate.widget.setDescLengthFull(parsed);
          ctx.ui.notify(`Description length (full) set to ${parsed}`, "info");
        }),
        description: "Max description length shown in full widget mode.",
      },
      {
        id: "descLengthCompact",
        label: "Description length (compact)",
        currentValue: String(store.agent.widgetDescLengthCompact),
        submenu: createNumericSubmenu(ctx, { min: 5 }, (parsed) => {
          store.mutate.widget.setDescLengthCompact(parsed);
          ctx.ui.notify(`Description length (compact) set to ${parsed}`, "info");
        }),
        description: "Max description length shown in compact widget mode.",
      },
      {
        id: "showModelThinking",
        label: "Show model & thinking",
        currentValue: store.agent.widgetShowModelThinking ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Show each agent's model and thinking level in the widget.",
      },
      {
        id: "showStartTime",
        label: "Show local start time",
        currentValue: store.agent.widgetShowStartTime ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Show local HH:MM start time after each agent status symbol.",
      },
      { id: "__sep__", label: "Usage stats", currentValue: "" },
      ...statItems,
      { id: "__sep__", label: "Behavior", currentValue: "" },
      {
        id: "finishedRetention",
        label: "Finished agent retention",
        currentValue: String(store.agent.finishedRetentionMinutes),
        submenu: createNumericSubmenu(ctx, { min: 1 }, (parsed) => {
          store.mutate.agent.setFinishedRetentionMinutes(parsed);
          ctx.ui.notify(`Finished agent retention set to ${parsed} min`, "info");
        }),
        description: "Minutes to keep finished agents visible in the widget before cleanup.",
      },
      {
        id: "thinkingBuffer",
        label: "Log file thinking buffer",
        currentValue: store.agent.outputThinkingBufferSize === 0 ? "OFF" : String(store.agent.outputThinkingBufferSize),
        values: ["OFF", "80", "200", "500", "1000"],
        description: "Controls log file thinking buffering in chars. OFF = only at turn end, 80 = flush after 80 chars.",
      },
    ];

    const settingsList = new SettingsList(items, 16, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Widget Settings", theme, onCancel: () => done(undefined) });
  });
}
