/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: any;
}> = [];

let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, options });
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() {
      inputInstances.push(this as any);
    }
  },
}));

// Import AFTER mock setup
import { showWidgetSettingsMenu } from "../src/ui/menu/menu-widget-settings.js";

describe("showWidgetSettingsMenu — SettingsList integration", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with 5 main items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(settingsListCalls.length).toBe(1);
    expect(settingsListCalls[0].items.length).toBe(5);
  });

  it("main items have correct ids", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["compact", "maxLines", "maxLinesCompact", "shortcut", "usageStats"]);
  });

  it("shows 'Force compact mode' with current value", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const compact = settingsListCalls[0].items.find((i: any) => i.id === "compact");
    expect(compact.label).toBe("Force compact mode");
    expect(compact.currentValue).toBe("OFF");
    expect(compact.values).toEqual(["ON", "OFF"]);
  });

  it("shows 'Force compact mode · ON' when enabled", async () => {
    mockModules.mockConfig.agent.widgetCompact = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const compact = settingsListCalls[0].items.find((i: any) => i.id === "compact");
    expect(compact.currentValue).toBe("ON");
  });
});

describe("showWidgetSettingsMenu — toggle onChange", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("toggles compact mode via onChange", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("compact", "ON");
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Force compact mode ON", "info");
  });

  it("toggles shortcut via onChange", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("shortcut", "ON");
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Ctrl+o shortcut ON", "info");
  });
});

describe("showWidgetSettingsMenu — numeric submenu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("maxLines item has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    expect(maxLines.label).toBe("Max lines (full)");
    expect(maxLines.currentValue).toBe("12");
    expect(typeof maxLines.submenu).toBe("function");
  });

  it("maxLinesCompact item has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const maxLinesCompact = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    expect(maxLinesCompact.label).toBe("Max lines (compact)");
    expect(maxLinesCompact.currentValue).toBe("6");
    expect(typeof maxLinesCompact.submenu).toBe("function");
  });

  it("numeric submenu creates Input with initial value and handles submit", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    maxLines.submenu("12", mockDone);

    // Input was created with initial value
    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("12");

    // Simulate submit with valid value
    inputInstances[0].onSubmit!("10");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (full) set to 10", "info");
    expect(mockDone).toHaveBeenCalledWith("10");
  });

  it("numeric submenu rejects value below minimum", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    maxLines.submenu("12", mockDone);

    inputInstances[0].onSubmit!("1");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(12);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 2", "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("numeric submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    maxLines.submenu("12", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });

  it("compact max lines submenu rejects value below 1", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLinesCompact = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLinesCompact.submenu("6", mockDone);

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1", "error");
  });

  it("compact max lines submenu accepts valid value", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLinesCompact = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLinesCompact.submenu("6", mockDone);

    inputInstances[0].onSubmit!("4");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(4);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (compact) set to 4", "info");
    expect(mockDone).toHaveBeenCalledWith("4");
  });
});

describe("showWidgetSettingsMenu — Usage stats submenu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("usageStats item has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    expect(usageStats.label).toBe("Usage stats");
    expect(typeof usageStats.submenu).toBe("function");
  });

  it("usageStats submenu creates a nested SettingsList with 7 stat items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    expect(settingsListCalls.length).toBe(2);
    expect(settingsListCalls[1].items.length).toBe(7);
  });

  it("stat items have correct ids", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    const statIds = settingsListCalls[1].items.map((i: any) => i.id);
    expect(statIds).toEqual(["showTools", "showTurns", "showInput", "showOutput", "showContext", "showCost", "showTime"]);
  });

  it("stat items have correct ON/OFF values from store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showTurns = false;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    const statItems = settingsListCalls[1].items;
    expect(statItems.find((i: any) => i.id === "showTools").currentValue).toBe("ON");
    expect(statItems.find((i: any) => i.id === "showTurns").currentValue).toBe("OFF");
    expect(statItems.find((i: any) => i.id === "showCost").currentValue).toBe("OFF");
  });

  it("stat toggle onChange updates store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    settingsListCalls[1].onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show tools OFF", "info");
  });

  it("stat toggle onChange for all 7 stats", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    settingsListCalls[1].onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);

    settingsListCalls[1].onChange("showTurns", "OFF");
    expect(mockModules.mockConfig.agent.showTurns).toBe(false);

    settingsListCalls[1].onChange("showInput", "OFF");
    expect(mockModules.mockConfig.agent.showInput).toBe(false);

    settingsListCalls[1].onChange("showOutput", "OFF");
    expect(mockModules.mockConfig.agent.showOutput).toBe(false);

    settingsListCalls[1].onChange("showContext", "OFF");
    expect(mockModules.mockConfig.agent.showContext).toBe(false);

    settingsListCalls[1].onChange("showCost", "ON");
    expect(mockModules.mockConfig.agent.showCost).toBe(true);

    settingsListCalls[1].onChange("showTime", "OFF");
    expect(mockModules.mockConfig.agent.showTime).toBe(false);
  });
});

describe("showWidgetSettingsMenu — item order", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("items appear in correct order: compact, maxLines, maxLinesCompact, shortcut, usageStats", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["compact", "maxLines", "maxLinesCompact", "shortcut", "usageStats"]);
  });

  it("stat items in submenu appear in correct order", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const usageStats = settingsListCalls[0].items.find((i: any) => i.id === "usageStats");
    usageStats.submenu("", vi.fn());

    const statIds = settingsListCalls[1].items.map((i: any) => i.id);
    expect(statIds).toEqual(["showTools", "showTurns", "showInput", "showOutput", "showContext", "showCost", "showTime"]);
  });
});
