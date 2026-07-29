/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
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

describe("showWidgetSettingsMenu — SettingsList integration", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
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


  it("shows all common appearance controls", async () => {
    mockModules.mockConfig.agent.widgetCompact = true;
    mockModules.mockConfig.agent.widgetShowModelThinking = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items.find((i: any) => i.id === "compact").currentValue).toBe("ON");
    expect(items.find((i: any) => i.id === "maxLines").currentValue).toBe("12");
    expect(items.find((i: any) => i.id === "showModelThinking").currentValue).toBe("OFF");
  });

  it("does not expose a navigation-hint toggle", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(settingsListCalls[0].items.find((i: any) => i.id === "navHint")).toBeUndefined();
  });

  it("shows local start time with its configured value", async () => {
    mockModules.mockConfig.agent.widgetShowStartTime = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const startTime = settingsListCalls[0].items.find((i: any) => i.id === "showStartTime");
    expect(startTime.currentValue).toBe("OFF");
  });
});

describe("showWidgetSettingsMenu — toggle onChange", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
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

  it("toggles compact mode and model/thinking visibility", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    mockModules.mockConfig.agent.widgetShowModelThinking = true;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("compact", "ON");
    settingsListCalls[0].onChange("showModelThinking", "OFF");
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(mockModules.mockConfig.agent.widgetShowModelThinking).toBe(false);
  });

  it("toggles shortcut via onChange", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("shortcut", "ON");
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("toggles local start time via onChange", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("showStartTime", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowStartTime).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show local start time OFF", "info");
  });
});

describe("showWidgetSettingsMenu — numeric submenu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
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

  it("full-mode max lines is editable here", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const mockDone = vi.fn();
    expect(maxLines.currentValue).toBe("12");
    maxLines.submenu("12", mockDone);
    inputInstances[0].onSubmit!("18");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(18);
    expect(mockDone).toHaveBeenCalledWith("18");
  });

  it("maxLinesCompact item has submenu function", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const maxLinesCompact = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    expect(maxLinesCompact.currentValue).toBe("6");
    expect(typeof maxLinesCompact.submenu).toBe("function");
  });

  it("compact-lines submenu creates Input and handles submit", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLines.submenu("6", mockDone);

    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("6");
    inputInstances[0].onSubmit!("10");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("10");
  });

  it("compact-lines submenu rejects zero", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLines.submenu("6", mockDone);

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("compact-lines submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLines = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLines.submenu("6", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });

  it("compact max lines submenu rejects values below 2", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const maxLinesCompact = settingsListCalls[0].items.find((i: any) => i.id === "maxLinesCompact");
    const mockDone = vi.fn();
    maxLinesCompact.submenu("6", mockDone);

    inputInstances[0].onSubmit!("1");
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("4");
  });

  it("descLengthFull shows default value 50", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const descLengthFull = settingsListCalls[0].items.find((i: any) => i.id === "descLengthFull");
    expect(descLengthFull.currentValue).toBe("50");
    expect(typeof descLengthFull.submenu).toBe("function");
  });

  it("descLengthFull submenu accepts valid value", async () => {
    mockModules.mockConfig.agent.widgetDescLengthFull = 50;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const descLengthFull = settingsListCalls[0].items.find((i: any) => i.id === "descLengthFull");
    const mockDone = vi.fn();
    descLengthFull.submenu("50", mockDone);

    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("50");

    inputInstances[0].onSubmit!("80");
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(80);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("80");
  });

  it("descLengthFull submenu rejects value below 5", async () => {
    mockModules.mockConfig.agent.widgetDescLengthFull = 50;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const descLengthFull = settingsListCalls[0].items.find((i: any) => i.id === "descLengthFull");
    const mockDone = vi.fn();
    descLengthFull.submenu("50", mockDone);

    inputInstances[0].onSubmit!("3");
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(50);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("descLengthCompact shows default value 30", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const descLengthCompact = settingsListCalls[0].items.find((i: any) => i.id === "descLengthCompact");
    expect(descLengthCompact.currentValue).toBe("30");
    expect(typeof descLengthCompact.submenu).toBe("function");
  });

  it("descLengthCompact submenu accepts valid value", async () => {
    mockModules.mockConfig.agent.widgetDescLengthCompact = 30;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const descLengthCompact = settingsListCalls[0].items.find((i: any) => i.id === "descLengthCompact");
    const mockDone = vi.fn();
    descLengthCompact.submenu("30", mockDone);

    inputInstances[0].onSubmit!("20");
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(20);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("20");
  });

  it("descLengthCompact submenu rejects value below 5", async () => {
    mockModules.mockConfig.agent.widgetDescLengthCompact = 30;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const descLengthCompact = settingsListCalls[0].items.find((i: any) => i.id === "descLengthCompact");
    const mockDone = vi.fn();
    descLengthCompact.submenu("30", mockDone);

    inputInstances[0].onSubmit!("4");
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe("showWidgetSettingsMenu — usage stats", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
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

  it("exposes all stat toggles directly with their current values", async () => {
    mockModules.mockConfig.agent.showTurns = false;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);

    const items = settingsListCalls[0].items;
    expect(items.find((i: any) => i.id === "usageStats")).toBeUndefined();
    expect(items.find((i: any) => i.id === "showTools").currentValue).toBe("ON");
    expect(items.find((i: any) => i.id === "showTurns").currentValue).toBe("OFF");
    expect(items.find((i: any) => i.id === "showCost").currentValue).toBe("OFF");
  });

  it("updates all seven stat toggles directly", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const onChange = settingsListCalls[0].onChange;

    onChange("showTools", "OFF");
    onChange("showTurns", "OFF");
    onChange("showInput", "OFF");
    onChange("showOutput", "OFF");
    onChange("showContext", "OFF");
    onChange("showCost", "ON");
    onChange("showTime", "OFF");

    expect(mockModules.mockConfig.agent).toMatchObject({
      showTools: false, showTurns: false, showInput: false, showOutput: false,
      showContext: false, showCost: true, showTime: false,
    });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(7);
  });
});


describe("showWidgetSettingsMenu — thinking buffer", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
      outputThinkingBufferSize: 0,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("has thinkingBuffer item with ring values", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item).toBeDefined();
  });

  it("shows OFF when outputThinkingBufferSize is 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("OFF");
  });

  it("shows number when outputThinkingBufferSize is nonzero", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinkingBuffer");
    expect(item.currentValue).toBe("200");
  });

  it("onChange updates store with numeric value", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "500");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(500);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("onChange OFF sets value to 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "OFF");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(0);
  });
});

describe("showWidgetSettingsMenu — finished agent retention", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      widgetShortcut: false,
      widgetDescLengthFull: 50, widgetDescLengthCompact: 30,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
      finishedRetentionMinutes: 10,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows current retention minutes", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 7;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "finishedRetention");
    expect(item.currentValue).toBe("7");
    expect(typeof item.submenu).toBe("function");
  });

  it("submenu applies value, notifies, and closes with the value", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 10;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "finishedRetention");
    const mockDone = vi.fn();
    item.submenu("10", mockDone);

    expect(inputInstances[0].value).toBe("10");
    inputInstances[0].onSubmit!("15");

    expect(mockModules.mockConfig.agent.finishedRetentionMinutes).toBe(15);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("15"), "info");
    expect(mockDone).toHaveBeenCalledWith("15");
  });

  it("submenu rejects value below minimum 1", async () => {
    mockModules.mockConfig.agent.finishedRetentionMinutes = 10;
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "finishedRetention");
    const mockDone = vi.fn();
    item.submenu("10", mockDone);

    inputInstances[0].onSubmit!("0");

    expect(mockModules.mockConfig.agent.finishedRetentionMinutes).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});
