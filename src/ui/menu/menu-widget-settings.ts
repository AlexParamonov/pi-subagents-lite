/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Single flat SettingsList with 3 section headers (Layout, Display, Stats).
 * Behavior items (Finished agent retention, Ctrl+o shortcut) folded into Display.
 *
 * Exports:
 *   - showWidgetSettingsMenu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { SEPARATOR_ID, buildSettingsListTheme, headerItem } from "./helpers.js";
import type { Theme } from "../types.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";
import { MIN_FINISHED_RETENTION_MINUTES } from "../../config/config-io.js";

/** One stat visibility toggle: menu label, description, and store get/set accessors. */
type StatToggleConfig = { label: string; description: string; get: () => boolean; set: (v: boolean) => void };

/** Stat visibility config — label, description, and store accessors keyed by stat id. */
function buildStatConfig(store: ReturnType<typeof getStore>): Map<string, StatToggleConfig> {
  return new Map<string, StatToggleConfig>([
    [
      "showTools",
      {
        label: "Tools",
        description: "Show tool count 🛠︎  in the widget.",
        get: () => store.agent.showTools,
        set: (v) => store.mutate.agent.setShowTools(v),
      },
    ],
    [
      "showTurns",
      {
        label: "Turns",
        description: "Show turn count ⟳  in the widget.",
        get: () => store.agent.showTurns,
        set: (v) => store.mutate.agent.setShowTurns(v),
      },
    ],
    [
      "showInput",
      {
        label: "Input tokens",
        description: "Show input tokens ↑ in the widget.",
        get: () => store.agent.showInput,
        set: (v) => store.mutate.agent.setShowInput(v),
      },
    ],
    [
      "showOutput",
      {
        label: "Output tokens",
        description: "Show output tokens ↓ in the widget.",
        get: () => store.agent.showOutput,
        set: (v) => store.mutate.agent.setShowOutput(v),
      },
    ],
    [
      "showContext",
      {
        label: "Context %",
        description: "Show context-fill percent % in the widget.",
        get: () => store.agent.showContext,
        set: (v) => store.mutate.agent.setShowContext(v),
      },
    ],
    [
      "showCost",
      {
        label: "Cost",
        description: "Show dollar cost $ in the widget.",
        get: () => store.agent.showCost,
        set: (v) => store.mutate.agent.setShowCost(v),
      },
    ],
    [
      "showTime",
      {
        label: "Time",
        description: "Show elapsed time in the widget.",
        get: () => store.agent.showTime,
        set: (v) => store.mutate.agent.setShowTime(v),
      },
    ],
  ]);
}

/**
 * Build the flat item list with 3 section headers (Layout, Display, Stats).
 * Behavior items (finishedRetention, shortcut) are folded into Display.
 */
function buildItems(
  ctx: ExtensionCommandContext,
  store: ReturnType<typeof getStore>,
  theme: Theme,
  statConfig: Map<string, StatToggleConfig>,
): SettingItem[] {
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
      label: "Max lines (full)",
      currentValue: String(store.agent.widgetMaxLines),
      submenu: createNumericSubmenu(ctx, { min: 2 }, (parsed) => {
        store.mutate.widget.setMaxLines(parsed);
        ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info");
      }),
      description: "Max body lines in full widget mode (excluding heading).",
    },
    {
      id: "maxLinesCompact",
      label: "Max lines (compact)",
      currentValue: String(store.agent.widgetMaxLinesCompact),
      submenu: createNumericSubmenu(ctx, (parsed) => {
        store.mutate.widget.setMaxLinesCompact(parsed);
        ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info");
      }),
      description: "Max body lines in compact widget mode.",
    },
    {
      id: "shortcut",
      label: "Ctrl+o shortcut",
      currentValue: store.agent.widgetShortcut ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description:
        "When ON, ctrl+o toggles compact mode; when OFF, compact is set manually. Takes effect on next reload.",
    },
    {
      id: "finishedRetention",
      label: "Hide finished agents in",
      currentValue: String(store.agent.finishedRetentionMinutes),
      submenu: createNumericSubmenu(ctx, { min: MIN_FINISHED_RETENTION_MINUTES }, (parsed) => {
        store.mutate.agent.setFinishedRetentionMinutes(parsed);
        ctx.ui.notify(`Finished agent retention set to ${parsed} min`, "info");
      }),
      description: "Removes finished agents from widget in X minutes (decimals OK, min 1 sec).",
    },
    {
      id: "navHint",
      label: "Navigation hint",
      currentValue: store.agent.widgetNavHint ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show navigation tip (↓ to navigate) in the widget heading.",
    },
    // --- Display ---
    { id: SEPARATOR_ID, label: " ", currentValue: "" },
    headerItem(theme, "Display"),
    {
      id: "showModel",
      label: "Show model",
      currentValue: store.agent.widgetShowModel ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show the model name next to each agent in the widget.",
    },
    {
      id: "showThinking",
      label: "Show thinking",
      currentValue: store.agent.widgetShowThinking ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show the thinking level next to each agent in the widget.",
    },
    {
      id: "modelDisplayStyle",
      label: "Model display",
      currentValue: store.agent.modelDisplayStyle === "name" ? "Name" : "ID",
      values: ["ID", "Name"],
      description: "Show model short ID (e.g. '27b_mtp') or full name (e.g. 'Qwen3.6 27B FP8').",
    },
    {
      id: "modelThinkingPlacement",
      label: "Model/thinking placement",
      currentValue: store.agent.modelThinkingPlacement === "header" ? "header" : "metadata",
      values: ["header", "metadata"],
      description: "Show model/thinking on header or metadata line in full mode.",
    },
    // --- Stats ---
    { id: SEPARATOR_ID, label: " ", currentValue: "" },
    headerItem(theme, "Stats"),
    ...[...statConfig.entries()].map(([id, cfg]) => ({
      id,
      label: cfg.label,
      currentValue: cfg.get() ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: cfg.description,
    })),
  ];
  return items;
}

function buildOnChange(
  ctx: ExtensionCommandContext,
  store: ReturnType<typeof getStore>,
  statConfig: Map<string, StatToggleConfig>,
) {
  return (id: string, newValue: string) => {
    // Stats toggles
    const stat = statConfig.get(id);
    if (stat) {
      stat.set(newValue === "ON");
      ctx.ui.notify(`${stat.label} ${newValue}`, "info");
      return;
    }

    switch (id) {
      // Layout
      case "compact":
        store.mutate.widget.setCompact(newValue === "ON");
        ctx.ui.notify(`Force compact mode ${newValue}`, "info");
        break;
      case "maxLines":
      case "maxLinesCompact":
        // Handled by numeric submenus, not onChange
        break;

      // Display

      case "showModel":
        store.mutate.widget.setShowModel(newValue === "ON");
        ctx.ui.notify(`Show model ${newValue}`, "info");
        break;
      case "showThinking":
        store.mutate.widget.setShowThinking(newValue === "ON");
        ctx.ui.notify(`Show thinking ${newValue}`, "info");
        break;
      case "navHint":
        store.mutate.widget.setNavHint(newValue === "ON");
        ctx.ui.notify(`Navigation hint ${newValue}`, "info");
        break;
      case "modelDisplayStyle":
        store.mutate.widget.setModelDisplayStyle(newValue === "Name" ? "name" : "id");
        ctx.ui.notify(`Model display ${newValue}`, "info");
        break;
      case "modelThinkingPlacement":
        store.mutate.widget.setModelThinkingPlacement(newValue === "header" ? "header" : "metadata");
        ctx.ui.notify(`Model/thinking placement: ${newValue}`, "info");
        break;

      // Behavior (now in Display section)
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
      case "finishedRetention":
        // Handled by the numeric submenu, not onChange
        break;
    }
  };
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const statConfig = buildStatConfig(store);
    const items = buildItems(ctx, store, theme, statConfig);
    const onChange = buildOnChange(ctx, store, statConfig);
    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (id, newValue) => {
        onChange(id, newValue);
        // Submenu-driven rows rebuild to refresh value; toggle
        // rows update in place via SettingsList.
        if (items.some((i) => i.id === id && i.submenu)) rebuild?.(buildItems(ctx, store, theme, statConfig));
      },
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Widget",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
