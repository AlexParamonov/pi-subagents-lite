/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 *
 * Single flat SettingsList with 3 section headers (Layout, Display, Stats).
 * Behavior items (Finished agent retention, Ctrl+o shortcut) folded into Display.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { asCommandContext } from "../../pi-boundaries.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";
import type { SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";

// Capture constructor calls
let settingsListCalls: Array<{
  items: SettingItem[];
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
}> = [];
let wrapperCalls: Array<{ title: string }> = [];
let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: SettingItem[];
    constructor(
      items: SettingItem[],
      _maxVisible: number,
      _theme: SettingsListTheme,
      onChange: (id: string, newValue: string) => void,
      onCancel: () => void,
    ) {
      this.items = items;
      settingsListCalls.push({ items, onChange, onCancel });
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) {
      this.value = v;
    }
    getValue() {
      return this.value;
    }
    constructor() {
      inputInstances.push(this);
    }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(_list: Component, options: SettingsListWrapperOptions) {
      wrapperCalls.push({ title: options.title });
    }
  },
}));

// Import AFTER mock setup
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";

function resetState() {
  settingsListCalls = [];
  wrapperCalls = [];
  inputInstances = [];
}

function setupMockConfig() {
  mockModules.mockConfig.agent = {
    default: null,
    forceBackground: false,
    widgetMaxLines: 12,
    widgetMaxLinesCompact: 6,
    widgetCompact: false,
    showCompletionCards: true,
    widgetShortcut: false,
    widgetDescLengthFull: 50,
    widgetDescLengthCompact: 30,
    showTools: true,
    showTurns: true,
    showInput: true,
    showOutput: true,
    showContext: true,
    showCost: false,
    showTime: true,
    outputThinkingBufferSize: 0,
    finishedRetentionMinutes: 1,
    modelDisplayStyle: "name",
    statusBarFormat: "full",
    widgetShowModel: true,
    widgetShowThinking: true,
    widgetNavHint: true,
  };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

afterEach(() => resetConfig());

describe("showWidgetSettingsMenu — flat SettingsList", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    vi.mocked(getAgentConfig).mockImplementation(() => undefined);
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with 3 headers + 18 items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(settingsListCalls.length).toBe(1);
    const items = settingsListCalls[0].items;
    // 3 group headers + 2 separators (no separator before first header) + 18 setting items = 23 total
    expect(items.length).toBe(23);
  });

  it("has correct item order with Layout, Display, Stats sections", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      // Layout header (no separator before first section)
      "__sep__",
      "compact",
      "maxLines",
      "maxLinesCompact",
      // Display separator + header
      "__sep__",
      "__sep__",
      "showModel",
      "modelDisplayStyle",
      "showThinking",
      "modelThinkingPlacement",
      "statusBarFormat",
      "navHint",
      "finishedRetention",
      "shortcut",
      // Stats separator + header
      "__sep__",
      "__sep__",
      "showTools",
      "showTurns",
      "showInput",
      "showOutput",
      "showContext",
      "showCost",
      "showTime",
    ]);
  });

  it("wraps in SettingsListWrapper with title 'Widget'", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Widget" });
  });

  it("compact item shows correct value", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i) => i.id === "compact")!;
    expect(item.currentValue).toBe("OFF");
  });

  it("compact onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("compact", "ON");
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
  });

  it("maxLines has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i) => i.id === "maxLines")!;
    expect(item.currentValue).toBe("12");
    expect(typeof item.submenu).toBe("function");
  });

  it("showModel onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetShowModel = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("showModel", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowModel).toBe(false);
  });

  it("statusBarFormat onChange updates store", async () => {
    mockModules.mockConfig.agent.statusBarFormat = "full";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("statusBarFormat", "compact");
    expect(mockModules.mockConfig.agent.statusBarFormat).toBe("compact");
  });

  it("modelDisplayStyle onChange toggles between id/name", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "id";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("modelDisplayStyle", "Name");
    expect(mockModules.mockConfig.agent.modelDisplayStyle).toBe("name");
  });

  it("showThinking onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetShowThinking = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("showThinking", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowThinking).toBe(false);
  });

  it("navHint onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetNavHint = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("navHint", "OFF");
    expect(mockModules.mockConfig.agent.widgetNavHint).toBe(false);
  });

  it("shortcut onChange toggles store (now in Display section)", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("shortcut", "ON");
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
  });

  it("finishedRetention has submenu (now in Display section)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i) => i.id === "finishedRetention")!;
    expect(typeof item.submenu).toBe("function");
  });

  it("stat toggles update store", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const onChange = settingsListCalls[0].onChange;

    onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    onChange("showCost", "ON");
    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    onChange("showTime", "OFF");
    expect(mockModules.mockConfig.agent.showTime).toBe(false);
  });

  it("stat items show correct ON/OFF values", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items.find((i) => i.id === "showTools")!.currentValue).toBe("ON");
    expect(items.find((i) => i.id === "showCost")!.currentValue).toBe("OFF");
  });

  it("stat labels have no 'Show' prefix", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const labels = settingsListCalls[0].items.filter((i) => i.id !== "__sep__").map((i) => i.label);
    expect(labels).toEqual([
      "Force compact mode",
      "Max lines (full)",
      "Max lines (compact)",
      "Show model",
      "Model display",
      "Show thinking",
      "Model/thinking placement",
      "Status bar format",
      "Navigation hint",
      "Finished agent retention",
      "Ctrl+o shortcut",
      "Tools",
      "Turns",
      "Input tokens",
      "Output tokens",
      "Context %",
      "Cost",
      "Time",
    ]);
  });
});
