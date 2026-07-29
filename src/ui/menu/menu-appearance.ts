/**
 * menu-appearance.ts — High-level widget appearance settings.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

type StatsPreset = "Minimal" | "Standard" | "Detailed" | "Custom";

type StatFlags = {
  showTools: boolean;
  showTurns: boolean;
  showInput: boolean;
  showOutput: boolean;
  showContext: boolean;
  showCost: boolean;
  showTime: boolean;
};

const STAT_PRESETS: Record<Exclude<StatsPreset, "Custom">, StatFlags> = {
  Minimal: {
    showTools: false, showTurns: false, showInput: false,
    showOutput: false, showContext: false, showCost: false, showTime: true,
  },
  Standard: {
    showTools: true, showTurns: true, showInput: true,
    showOutput: true, showContext: true, showCost: false, showTime: true,
  },
  Detailed: {
    showTools: true, showTurns: true, showInput: true,
    showOutput: true, showContext: true, showCost: true, showTime: true,
  },
};

function currentStatsPreset(store: ReturnType<typeof getStore>): StatsPreset {
  const current: StatFlags = {
    showTools: store.agent.showTools,
    showTurns: store.agent.showTurns,
    showInput: store.agent.showInput,
    showOutput: store.agent.showOutput,
    showContext: store.agent.showContext,
    showCost: store.agent.showCost,
    showTime: store.agent.showTime,
  };
  return (Object.entries(STAT_PRESETS).find(([, preset]) =>
    Object.entries(preset).every(([key, value]) => current[key as keyof StatFlags] === value),
  )?.[0] as StatsPreset | undefined) ?? "Custom";
}

function applyStatsPreset(store: ReturnType<typeof getStore>, preset: Exclude<StatsPreset, "Custom">): void {
  const flags = STAT_PRESETS[preset];
  store.mutate.agent.setShowTools(flags.showTools);
  store.mutate.agent.setShowTurns(flags.showTurns);
  store.mutate.agent.setShowInput(flags.showInput);
  store.mutate.agent.setShowOutput(flags.showOutput);
  store.mutate.agent.setShowContext(flags.showContext);
  store.mutate.agent.setShowCost(flags.showCost);
  store.mutate.agent.setShowTime(flags.showTime);
}

export async function showAppearanceMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const items: SettingItem[] = [
    {
      id: "compact",
      label: "Force compact mode",
      currentValue: store.agent.widgetCompact ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Force compact widget mode regardless of ctrl+o state.",
    },
    {
      id: "maxLines",
      label: "Widget size: full mode lines",
      currentValue: String(store.agent.widgetMaxLines),
      submenu: createNumericSubmenu(ctx, { min: 2 }, (parsed) => {
        store.mutate.widget.setMaxLines(parsed);
        ctx.ui.notify(`Widget full-mode lines set to ${parsed}`, "info");
      }),
      description: "Maximum body lines in the full widget, excluding its heading.",
    },
    {
      id: "statsPreset",
      label: "Stats preset",
      currentValue: currentStatsPreset(store),
      values: ["Minimal", "Standard", "Detailed"],
      description: "Minimal shows elapsed time only; customize individual stats in Advanced.",
    },
  ];

  const onChange = (id: string, value: string) => {
    if (id === "compact") {
      store.mutate.widget.setCompact(value === "ON");
      ctx.ui.notify(`Force compact mode ${value}`, "info");
    } else if (id === "statsPreset" && value !== "Custom") {
      applyStatsPreset(store, value as Exclude<StatsPreset, "Custom">);
      ctx.ui.notify(`Stats preset set to ${value}`, "info");
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const list = new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(list, { title: "Appearance", theme, onCancel: () => done(undefined) });
  });
}
