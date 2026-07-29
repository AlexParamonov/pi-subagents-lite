/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Structure: 4 top-level submenus — Layout, Display, Behavior, Stats.
 * Each submenu is a SettingsList with its own onChange handler.
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
    ["deltaInputTokens", { label: "Delta input tokens", get: () => store.agent.deltaInputTokens, set: (v) => store.mutate.agent.setDeltaInputTokens(v) }],
    ["showOutput", { label: "Show output tokens", get: () => store.agent.showOutput, set: (v) => store.mutate.agent.setShowOutput(v) }],
    ["showContext", { label: "Show context %", get: () => store.agent.showContext, set: (v) => store.mutate.agent.setShowContext(v) }],
    ["showCost", { label: "Show cost", get: () => store.agent.showCost, set: (v) => store.mutate.agent.setShowCost(v) }],
    ["showTime", { label: "Show time", get: () => store.agent.showTime, set: (v) => store.mutate.agent.setShowTime(v) }],
  ]);
}

/** Build the stat toggle onChange handler for the Stats submenu. */
function buildStatOnChange(ctx: ExtensionCommandContext, statConfig: ReturnType<typeof buildStatConfig>) {
  return (id: string, newValue: string) => {
    const stat = statConfig.get(id);
    if (stat) {
      stat.set(newValue === "ON");
      ctx.ui.notify(`${stat.label} ${newValue}`, "info");
    }
  };
}

/** Build the stat items for the Stats submenu. */
function buildStatItems(statConfig: ReturnType<typeof buildStatConfig>): SettingItem[] {
  const statDescriptions: Record<string, string> = {
    showTools: "Show tool count (\u{1F6E0}\uFE0E ) in the widget.",
    showTurns: "Show turn count (\u27F3 ) in the widget.",
    showInput: "Show input tokens (\u2191) in the widget.",
    deltaInputTokens: "Estimate input token delta for vLLM (no cache reporting).",
    showOutput: "Show output tokens (\u2193) in the widget.",
    showContext: "Show context-fill percent (%) in the widget.",
    showCost: "Show dollar cost ($) in the widget.",
    showTime: "Show elapsed time in the widget.",
  };
  return [...statConfig.entries()].map(([id, cfg]) => ({
    id,
    label: cfg.label,
    currentValue: cfg.get() ? "ON" : "OFF",
    values: ["ON", "OFF"],
    description: statDescriptions[id],
  }));
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const statConfig = buildStatConfig(store);
  const statItems = buildStatItems(statConfig);
  const statOnChange = buildStatOnChange(ctx, statConfig);

  // ---- Layout submenu onChange ----
  const layoutOnChange = (id: string, newValue: string) => {
    switch (id) {
      case "compact":
        store.mutate.widget.setCompact(newValue === "ON");
        ctx.ui.notify(`Force compact mode ${newValue}`, "info");
        break;
    }
  };

  // ---- Layout submenu items ----
  const layoutItems: SettingItem[] = [
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
  ];

  // ---- Display submenu onChange ----
  const displayOnChange = (id: string, newValue: string) => {
    switch (id) {
      case "statusBarFormat":
        store.mutate.widget.setStatusBarFormat(newValue as "full" | "compact");
        ctx.ui.notify(`Status bar format: ${newValue}`, "info");
        break;
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
    }
  };

  // ---- Display submenu items ----
  const displayItems: SettingItem[] = [
    {
      id: "statusBarFormat",
      label: "Status bar format",
      currentValue: store.agent.statusBarFormat,
      values: ["full", "compact"],
      description: "Status bar format: full (Agents: N active \u00b7 M done) or compact (N M\u03A3).",
    },
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
      id: "navHint",
      label: "Navigation hint",
      currentValue: store.agent.widgetNavHint ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show navigation tip (\u2193 to navigate) in the widget heading.",
    },
    {
      id: "modelDisplayStyle",
      label: "Model display",
      currentValue: store.agent.modelDisplayStyle === "name" ? "Name" : "ID",
      values: ["ID", "Name"],
      description: "Show model short ID (e.g. '27b_mtp') or full name (e.g. 'Qwen3.6 27B FP8').",
    },
  ];

  // ---- Behavior submenu onChange ----
  const behaviorOnChange = (id: string, newValue: string) => {
    switch (id) {
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
      case "thinkingBuffer":
        store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
        ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
        break;
    }
  };

  // ---- Behavior submenu items ----
  const behaviorItems: SettingItem[] = [
    {
      id: "shortcut",
      label: "Ctrl+o shortcut",
      currentValue: store.agent.widgetShortcut ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "When ON, ctrl+o toggles compact mode; when OFF, compact is set manually.",
    },
    {
      id: "thinkingBuffer",
      label: "Log file thinking buffer",
      currentValue: store.agent.outputThinkingBufferSize === 0 ? "OFF" : String(store.agent.outputThinkingBufferSize),
      values: ["OFF", "80", "200", "500", "1000"],
      description: "Controls log file thinking buffering in chars. OFF = only at turn end, 80 = flush after 80 chars.",
    },
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
      id: "finishedEvictTurns",
      label: "Finished agent evict turns",
      currentValue: String(store.agent.finishedEvictTurns),
      submenu: createNumericSubmenu(ctx, { min: 0 }, (parsed) => {
        store.mutate.agent.setFinishedEvictTurns(parsed);
        ctx.ui.notify(`Finished agent evict turns set to ${parsed}`, "info");
      }),
      description: "Turns to keep finished agents visible. 0 = disabled (only timer applies). Error agents linger +2 extra turns.",
    },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    // ---- Top-level menu items (4 submenus) ----
    const items: SettingItem[] = [
      {
        id: "layout",
        label: "Layout",
        currentValue: "",
        submenu: (_cv: string, d: (v?: string) => void) =>
          new SettingsList(layoutItems, 7, buildSettingsListTheme(theme), layoutOnChange, () => d()),
        description: "Compact mode, max lines, description length",
      },
      {
        id: "display",
        label: "Display",
        currentValue: "",
        submenu: (_cv: string, d: (v?: string) => void) =>
          new SettingsList(displayItems, 7, buildSettingsListTheme(theme), displayOnChange, () => d()),
        description: "Status bar, model, thinking, navigation, model display",
      },
      {
        id: "behavior",
        label: "Behavior",
        currentValue: "",
        submenu: (_cv: string, d: (v?: string) => void) =>
          new SettingsList(behaviorItems, 7, buildSettingsListTheme(theme), behaviorOnChange, () => d()),
        description: "Shortcut, thinking buffer, agent retention and eviction",
      },
      {
        id: "stats",
        label: "Usage stats",
        currentValue: "",
        submenu: (_cv: string, d: (v?: string) => void) =>
          new SettingsList(statItems, 7, buildSettingsListTheme(theme), statOnChange, () => d()),
        description: "Toggle which usage stats appear in the widget",
      },
    ];
    const settingsList = new SettingsList(items, 4, buildSettingsListTheme(theme), () => {}, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Widget Settings", theme, onCancel: () => done(undefined) });
  });
}
