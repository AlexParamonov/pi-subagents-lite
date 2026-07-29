/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 *
 * Structure: 4 top-level submenus — Layout, Display, Behavior, Stats.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

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
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      this.items = items;
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
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";

function setup() {
  mockModules.mockConfig.agent = {
    default: null, forceBackground: false,
    widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
    widgetShortcut: false,
    widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
    widgetShowModel: true, widgetShowThinking: true, widgetNavHint: true,
    statusBarFormat: "full",
    showTools: true, showTurns: true, showInput: true, showOutput: true,
    showContext: true, showCost: false, showTime: true,
    outputThinkingBufferSize: 0,
    finishedRetentionMinutes: 10,
    finishedEvictTurns: 4,
    modelDisplayStyle: "id",
  };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
  vi.clearAllMocks();
  settingsListCalls = [];
  inputInstances = [];
  (getAgentConfig as any).mockImplementation(() => undefined);
}

// ---- Submenu structure ----

describe("showWidgetSettingsMenu — submenu structure", () => {
  beforeEach(() => setup());

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows 4 top-level submenu items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items).toHaveLength(4);
  });

  it("has Layout, Display, Behavior, Stats submenus", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    const ids = items.map((i: any) => i.id);
    expect(ids).toContain("layout");
    expect(ids).toContain("display");
    expect(ids).toContain("behavior");
    expect(ids).toContain("stats");
  });

  it("each top-level item has a submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    for (const item of settingsListCalls[0].items) {
      expect(typeof item.submenu).toBe("function");
    }
  });

  it("each top-level item has label and description", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    for (const item of settingsListCalls[0].items) {
      expect(item.label).toBeDefined();
      expect(item.description).toBeDefined();
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });
});

// ---- Layout submenu ----

describe("showWidgetSettingsMenu — Layout submenu", () => {
  beforeEach(() => setup());

  it("opens with 5 items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    expect(settingsListCalls[1].items).toHaveLength(5);
  });

  it("contains compact, maxLines, maxLinesCompact, descLengthFull, descLengthCompact", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).toContain("compact");
    expect(ids).toContain("maxLines");
    expect(ids).toContain("maxLinesCompact");
    expect(ids).toContain("descLengthFull");
    expect(ids).toContain("descLengthCompact");
  });

  it("compact shows OFF by default", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const compact = settingsListCalls[1].items.find((i: any) => i.id === "compact");
    expect(compact.currentValue).toBe("OFF");
  });

  it("compact shows ON when enabled", async () => {
    mockModules.mockConfig.agent.widgetCompact = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const compact = settingsListCalls[1].items.find((i: any) => i.id === "compact");
    expect(compact.currentValue).toBe("ON");
  });

  it("toggles compact mode via onChange", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    settingsListCalls[1].onChange("compact", "ON");
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("maxLines shows current value and has submenu", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const maxLines = settingsListCalls[1].items.find((i: any) => i.id === "maxLines");
    expect(maxLines.currentValue).toBe("12");
    expect(typeof maxLines.submenu).toBe("function");
  });

  it("maxLines submenu accepts valid value", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const maxLines = settingsListCalls[1].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    maxLines.submenu("12", mockDone);
    expect(inputInstances[0].value).toBe("12");
    inputInstances[0].onSubmit!("10");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("10");
  });

  it("maxLines submenu rejects value below minimum", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const maxLines = settingsListCalls[1].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    maxLines.submenu("12", mockDone);
    inputInstances[0].onSubmit!("1");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(12);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("maxLinesCompact shows current value and has submenu", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxLinesCompact");
    expect(item.currentValue).toBe("6");
    expect(typeof item.submenu).toBe("function");
  });

  it("descLengthFull shows default 50", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthFull");
    expect(item.currentValue).toBe("50");
    expect(typeof item.submenu).toBe("function");
  });

  it("descLengthFull submenu accepts valid value", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthFull");
    const mockDone = vi.fn();
    item.submenu("50", mockDone);
    inputInstances[0].onSubmit!("80");
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(80);
    expect(mockDone).toHaveBeenCalledWith("80");
  });

  it("descLengthFull submenu rejects value below 5", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthFull");
    const mockDone = vi.fn();
    item.submenu("50", mockDone);
    inputInstances[0].onSubmit!("3");
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(50);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("descLengthCompact shows default 30", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthCompact");
    expect(item.currentValue).toBe("30");
    expect(typeof item.submenu).toBe("function");
  });

  it("descLengthCompact submenu accepts valid value", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthCompact");
    const mockDone = vi.fn();
    item.submenu("30", mockDone);
    inputInstances[0].onSubmit!("20");
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(20);
    expect(mockDone).toHaveBeenCalledWith("20");
  });

  it("descLengthCompact submenu rejects value below 5", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "descLengthCompact");
    const mockDone = vi.fn();
    item.submenu("30", mockDone);
    inputInstances[0].onSubmit!("4");
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("maxLinesCompact submenu rejects value below 1", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const layout = settingsListCalls[0].items.find((i: any) => i.id === "layout");
    layout.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    item.submenu("6", mockDone);
    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });
});

// ---- Display submenu ----

describe("showWidgetSettingsMenu — Display submenu", () => {
  beforeEach(() => setup());

  it("opens with 5 items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    expect(settingsListCalls[1].items).toHaveLength(5);
  });

  it("contains statusBarFormat, showModel, showThinking, navHint, modelDisplayStyle", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).toContain("statusBarFormat");
    expect(ids).toContain("showModel");
    expect(ids).toContain("showThinking");
    expect(ids).toContain("navHint");
    expect(ids).toContain("modelDisplayStyle");
  });

  it("statusBarFormat shows current value", async () => {
    mockModules.mockConfig.agent.statusBarFormat = "compact";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "statusBarFormat");
    expect(item.currentValue).toBe("compact");
  });

  it("toggles statusBarFormat via onChange", async () => {
    mockModules.mockConfig.agent.statusBarFormat = "full";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("statusBarFormat", "compact");
    expect(mockModules.mockConfig.agent.statusBarFormat).toBe("compact");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("showModel shows ON by default", async () => {
    mockModules.mockConfig.agent.widgetShowModel = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "showModel");
    expect(item.currentValue).toBe("ON");
  });

  it("toggles showModel via onChange", async () => {
    mockModules.mockConfig.agent.widgetShowModel = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("showModel", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowModel).toBe(false);
  });

  it("showThinking shows ON by default", async () => {
    mockModules.mockConfig.agent.widgetShowThinking = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "showThinking");
    expect(item.currentValue).toBe("ON");
  });

  it("toggles showThinking via onChange", async () => {
    mockModules.mockConfig.agent.widgetShowThinking = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("showThinking", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowThinking).toBe(false);
  });

  it("navHint shows ON by default", async () => {
    mockModules.mockConfig.agent.widgetNavHint = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "navHint");
    expect(item.currentValue).toBe("ON");
  });

  it("toggles navHint via onChange", async () => {
    mockModules.mockConfig.agent.widgetNavHint = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("navHint", "OFF");
    expect(mockModules.mockConfig.agent.widgetNavHint).toBe(false);
  });

  it("modelDisplayStyle shows ID by default", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "id";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "modelDisplayStyle");
    expect(item.currentValue).toBe("ID");
    expect(item.values).toEqual(["ID", "Name"]);
  });

  it("modelDisplayStyle shows Name when configured", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "name";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "modelDisplayStyle");
    expect(item.currentValue).toBe("Name");
  });

  it("toggles modelDisplayStyle to name", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "id";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("modelDisplayStyle", "Name");
    expect(mockModules.mockConfig.agent.modelDisplayStyle).toBe("name");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model display Name", "info");
  });

  it("toggles modelDisplayStyle to id", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "name";
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const display = settingsListCalls[0].items.find((i: any) => i.id === "display");
    display.submenu("", vi.fn());
    settingsListCalls[1].onChange("modelDisplayStyle", "ID");
    expect(mockModules.mockConfig.agent.modelDisplayStyle).toBe("id");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model display ID", "info");
  });
});

// ---- Behavior submenu ----

describe("showWidgetSettingsMenu — Behavior submenu", () => {
  beforeEach(() => setup());

  it("opens with 4 items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    expect(settingsListCalls[1].items).toHaveLength(4);
  });

  it("contains shortcut, thinkingBuffer, finishedRetention, finishedEvictTurns", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).toContain("shortcut");
    expect(ids).toContain("thinkingBuffer");
    expect(ids).toContain("finishedRetention");
    expect(ids).toContain("finishedEvictTurns");
  });

  it("shortcut shows OFF by default", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "shortcut");
    expect(item.currentValue).toBe("OFF");
  });

  it("toggles shortcut via onChange", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    settingsListCalls[1].onChange("shortcut", "ON");
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("thinkingBuffer shows OFF when 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("OFF");
  });

  it("thinkingBuffer shows number when nonzero", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("200");
  });

  it("thinkingBuffer onChange updates store", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    settingsListCalls[1].onChange("thinkingBuffer", "500");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(500);
  });

  it("thinkingBuffer onChange OFF sets to 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    settingsListCalls[1].onChange("thinkingBuffer", "OFF");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(0);
  });

  it("finishedRetention shows current value", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 7;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "finishedRetention");
    expect(item.currentValue).toBe("7");
    expect(typeof item.submenu).toBe("function");
  });

  it("finishedRetention submenu accepts valid value", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 10;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "finishedRetention");
    const mockDone = vi.fn();
    item.submenu("10", mockDone);
    inputInstances[0].onSubmit!("15");
    expect(mockModules.mockConfig.agent.finishedRetentionMinutes).toBe(15);
    expect(mockDone).toHaveBeenCalledWith("15");
  });

  it("finishedRetention submenu rejects value below 1", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 10;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "finishedRetention");
    const mockDone = vi.fn();
    item.submenu("10", mockDone);
    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.finishedRetentionMinutes).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("finishedEvictTurns shows current value", async () => {
    mockModules.mockConfig.agent.finishedEvictTurns = 4;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "finishedEvictTurns");
    expect(item.currentValue).toBe("4");
    expect(typeof item.submenu).toBe("function");
  });

  it("finishedEvictTurns submenu accepts valid value", async () => {
    mockModules.mockConfig.agent.finishedEvictTurns = 4;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const behavior = settingsListCalls[0].items.find((i: any) => i.id === "behavior");
    behavior.submenu("", vi.fn());
    const item = settingsListCalls[1].items.find((i: any) => i.id === "finishedEvictTurns");
    const mockDone = vi.fn();
    item.submenu("4", mockDone);
    inputInstances[0].onSubmit!("8");
    expect(mockModules.mockConfig.agent.finishedEvictTurns).toBe(8);
    expect(mockDone).toHaveBeenCalledWith("8");
  });
});

// ---- Stats submenu ----

describe("showWidgetSettingsMenu — Stats submenu", () => {
  beforeEach(() => setup());

  it("opens with stat visibility toggles", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const stats = settingsListCalls[0].items.find((i: any) => i.id === "stats");
    stats.submenu("", vi.fn());
    const statItems = settingsListCalls[1].items;
    expect(statItems.length).toBeGreaterThan(0);
  });

  it("stat items have correct ON/OFF values from store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showTurns = false;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const stats = settingsListCalls[0].items.find((i: any) => i.id === "stats");
    stats.submenu("", vi.fn());
    const statItems = settingsListCalls[1].items;
    expect(statItems.find((i: any) => i.id === "showTools").currentValue).toBe("ON");
    expect(statItems.find((i: any) => i.id === "showTurns").currentValue).toBe("OFF");
    expect(statItems.find((i: any) => i.id === "showCost").currentValue).toBe("OFF");
  });

  it("stat toggle onChange updates store", async () => {
    mockModules.mockConfig.agent.showTools = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const stats = settingsListCalls[0].items.find((i: any) => i.id === "stats");
    stats.submenu("", vi.fn());
    settingsListCalls[1].onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("stat toggle onChange for all 7 stats", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const stats = settingsListCalls[0].items.find((i: any) => i.id === "stats");
    stats.submenu("", vi.fn());
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
