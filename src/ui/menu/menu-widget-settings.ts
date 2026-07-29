/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Top-level: SelectList with 4 categories (Layout, Display, Behavior, Stats).
 * Each category dispatches to a SettingsList submenu.
 *
 * Exports:
 *   - showWidgetSettingsMenu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, SettingsList, type SelectItem, type SettingItem } from "@earendil-works/pi-tui";
import { buildSelectListTheme, buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

/** Stat visibility config — label and store accessors keyed by stat id. */
function buildStatConfig(store: ReturnType<typeof getStore>) {
  return new Map<string, { label: string; get: () => boolean; set: (v: boolean) => void }>([
    ["showTools", { label: "Tools", get: () => store.agent.showTools, set: (v) => store.mutate.agent.setShowTools(v) }],
    ["showTurns", { label: "Turns", get: () => store.agent.showTurns, set: (v) => store.mutate.agent.setShowTurns(v) }],
    ["showInput", { label: "Input tokens", get: () => store.agent.showInput, set: (v) => store.mutate.agent.setShowInput(v) }],
    ["showOutput", { label: "Output tokens", get: () => store.agent.showOutput, set: (v) => store.mutate.agent.setShowOutput(v) }],
    ["showContext", { label: "Context %", get: () => store.agent.showContext, set: (v) => store.mutate.agent.setShowContext(v) }],
    ["showCost", { label: "Cost", get: () => store.agent.showCost, set: (v) => store.mutate.agent.setShowCost(v) }],
    ["showTime", { label: "Time", get: () => store.agent.showTime, set: (v) => store.mutate.agent.setShowTime(v) }],
  ]);
}

/** Build SettingsList items for the Layout category. */
function buildLayoutItems(ctx: ExtensionCommandContext, store: ReturnType<typeof getStore>): SettingItem[] {
  return [
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
}

/** Build SettingsList items for the Display category. */
function buildDisplayItems(store: ReturnType<typeof getStore>): SettingItem[] {
  return [
    {
      id: "showModel",
      label: "Show model",
      currentValue: store.agent.widgetShowModel ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show the model name next to each agent in the widget.",
    },
    {
      id: "modelDisplayStyle",
      label: "Model display",
      currentValue: store.agent.modelDisplayStyle === "name" ? "Name" : "ID",
      values: ["ID", "Name"],
      description: "Show model short ID (e.g. '27b_mtp') or full name (e.g. 'Qwen3.6 27B FP8').",
    },
    {
      id: "showThinking",
      label: "Show thinking",
      currentValue: store.agent.widgetShowThinking ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show the thinking level next to each agent in the widget.",
    },
    { id: "__sep__", label: " ", currentValue: "" },
    {
      id: "statusBarFormat",
      label: "Status bar format",
      currentValue: store.agent.statusBarFormat,
      values: ["full", "compact"],
      description: "Status bar format: full (Agents: N active · M done) or compact (N MΣ).",
    },
    {
      id: "navHint",
      label: "Navigation hint",
      currentValue: store.agent.widgetNavHint ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show navigation tip (↓ to navigate) in the widget heading.",
    },
  ];
}

/** Build SettingsList items for the Behavior category. */
function buildBehaviorItems(ctx: ExtensionCommandContext, store: ReturnType<typeof getStore>): SettingItem[] {
  return [
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
    { id: "__sep__", label: " ", currentValue: "" },
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
  ];
}

/** Stat descriptions keyed by stat id. */
const STAT_DESCRIPTIONS: Record<string, string> = {
    showTools: "Show tool count 🛠︎  in the widget.",
    showTurns: "Show turn count ⟳  in the widget.",
    showInput: "Show input tokens ↑ in the widget.",
    showOutput: "Show output tokens ↓ in the widget.",
    showContext: "Show context-fill percent % in the widget.",
    showCost: "Show dollar cost $ in the widget.",
    showTime: "Show elapsed time in the widget.",
};

/** Build SettingsList items for the Stats category. */
function buildStatsItems(store: ReturnType<typeof getStore>, statConfig: Map<string, { label: string; get: () => boolean; set: (v: boolean) => void }>): SettingItem[] {
  const items: SettingItem[] = [...statConfig.entries()].map(([id, cfg]) => ({
    id,
    label: cfg.label,
    currentValue: cfg.get() ? "ON" : "OFF",
    values: ["ON", "OFF"],
    description: STAT_DESCRIPTIONS[id],
  }));
  items.push({ id: "__sep__", label: " ", currentValue: "" });
  items.push({
    id: "deltaInputTokens",
    label: "Delta input tokens",
    currentValue: store.agent.deltaInputTokens ? "ON" : "OFF",
    values: ["ON", "OFF"],
    description: "Estimate input token delta for vLLM (no cache reporting).",
  });
  return items;
}

/** Build the onChange handler for a category's SettingsList. */
function buildOnChange(ctx: ExtensionCommandContext, store: ReturnType<typeof getStore>) {
  const statConfig = buildStatConfig(store);
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
      case "descLengthFull":
      case "descLengthCompact":
        // Handled by numeric submenus, not onChange
        break;

      // Display
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

      // Stats (deltaInputTokens is not in statConfig)
      case "deltaInputTokens":
        store.mutate.agent.setDeltaInputTokens(newValue === "ON");
        ctx.ui.notify(`Delta input tokens ${newValue}`, "info");
        break;

      // Behavior
      case "shortcut":
        store.mutate.widget.setShortcut(newValue === "ON");
        ctx.ui.notify(`Ctrl+o shortcut ${newValue}`, "info");
        break;
      case "thinkingBuffer":
        store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
        ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
        break;
      case "finishedRetention":
      case "finishedEvictTurns":
        // Handled by numeric submenus, not onChange
        break;
    }
  };
}

/** Show a SettingsList submenu for a specific category. */
async function showCategorySubmenu(
  ctx: ExtensionCommandContext,
  title: string,
  buildItems: () => SettingItem[],
): Promise<void> {
  const store = getStore();
  const onChange = buildOnChange(ctx, store);

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items = buildItems();
    const settingsList = new SettingsList(items, 15, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title, theme, onCancel: () => done(undefined) });
  });
}

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const items: SelectItem[] = [
    { value: "layout", label: "Layout", description: "Compact mode, max lines, description length" },
    { value: "display", label: "Display", description: "Status bar, model/thinking visibility, navigation hint" },
    { value: "behavior", label: "Behavior", description: "Shortcuts, thinking buffer, finished agent retention" },
    { value: "stats", label: "Stats", description: "Toggle which usage stats appear in the widget" },
  ];

  while (true) {
    const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const list = new SelectList(items, 10, buildSelectListTheme(theme));
      list.onSelect = (item) => done(item.value);
      return new SettingsListWrapper(list, { title: "Widget Settings", theme, onCancel: () => done(undefined) });
    });
    if (choice === undefined) return;

    switch (choice) {
      case "layout":
        await showCategorySubmenu(ctx, "Layout", () => buildLayoutItems(ctx, store));
        break;
      case "display":
        await showCategorySubmenu(ctx, "Display", () => buildDisplayItems(store));
        break;
      case "behavior":
        await showCategorySubmenu(ctx, "Behavior", () => buildBehaviorItems(ctx, store));
        break;
      case "stats": {
        const statConfig = buildStatConfig(store);
        await showCategorySubmenu(ctx, "Stats", () => buildStatsItems(store, statConfig));
        break;
      }
    }
  }
}
