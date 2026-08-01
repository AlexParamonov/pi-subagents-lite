/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 *
 * Top-level: SelectList with 4 categories (Layout, Display, Behavior, Stats).
 * Each category dispatches to a SettingsList submenu.
 *
 * Pattern: capture constructor calls, verify structure, test onChange directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture constructor calls
let selectListCalls: any[] = [];
let settingsListCalls: any[] = [];
let wrapperCalls: Array<{ title: string }> = [];
let inputInstances: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any) {
      this.items = items;
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel });
    }
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[], maxVisible: number, theme: any) {
      this.items = items;
      selectListCalls.push({ items, maxVisible, theme });
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
      inputInstances.push(this as any);
    }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(_list: any, options: { title: string; theme: any; onCancel?: () => void }) {
      wrapperCalls.push({ title: options.title });
    }
  },
}));

// Import AFTER mock setup
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";

function resetState() {
  selectListCalls = [];
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
    finishedRetentionMinutes: 10,
    finishedEvictTurns: 4,
    modelDisplayStyle: "id",
    statusBarFormat: "full",
    widgetShowModel: true,
    widgetShowThinking: true,
    widgetNavHint: true,
  };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

/** Create a ctx that dispatches a specific category choice on first custom call. */
function createDispatchCtx(choice: string) {
  let callCount = 0;
  return {
    ui: {
      custom: vi.fn(async (factory: any) => {
        callCount++;
        if (callCount === 1) {
          // Top-level: return the category choice
          return choice;
        }
        // Submenu and loop-continue: invoke factory, return undefined
        factory(
          { terminal: { rows: 40 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t },
          null,
          () => {},
        );
        return undefined;
      }),
      notify: vi.fn(),
    },
    modelRegistry: { getAvailable: vi.fn(() => []) },
  };
}

describe("showWidgetSettingsMenu — SelectList top-level", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SelectList with 4 category items", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items).toHaveLength(4);
  });

  it("has correct category labels and values", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    const items = selectListCalls[0].items;
    expect(items.map((i: any) => i.label)).toEqual(["Layout", "Display", "Behavior", "Stats"]);
    expect(items.map((i: any) => i.value)).toEqual(["layout", "display", "behavior", "stats"]);
  });

  it("has descriptions for each category", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    for (const item of selectListCalls[0].items) {
      expect(typeof item.description).toBe("string");
    }
  });

  it("wraps in SettingsListWrapper with title 'Widget Settings'", async () => {
    const ctx = createMockCtx();
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Widget Settings" });
  });
});

describe("showWidgetSettingsMenu — Layout submenu", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("dispatches to Layout SettingsList with 5 items", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    expect(settingsListCalls.length).toBe(1);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["compact", "maxLines", "maxLinesCompact", "descLengthFull", "descLengthCompact"]);
  });

  it("compact item shows correct value", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "compact");
    expect(item.currentValue).toBe("OFF");
  });

  it("compact onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("compact", "ON");
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
  });

  it("maxLines has submenu function", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    expect(item.currentValue).toBe("12");
    expect(typeof item.submenu).toBe("function");
  });

  it("maxLines submenu creates Input with initial value", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    item.submenu("12", vi.fn());
    expect(inputInstances[0].value).toBe("12");
  });

  it("maxLines submenu accepts valid value", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const done = vi.fn();
    item.submenu("12", done);
    inputInstances[0].onSubmit!("10");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(done).toHaveBeenCalledWith("10");
  });

  it("maxLines submenu rejects value below minimum", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "maxLines");
    const done = vi.fn();
    item.submenu("12", done);
    inputInstances[0].onSubmit!("1");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(12);
    expect(done).not.toHaveBeenCalled();
  });

  it("has title 'Layout'", async () => {
    const ctx = createDispatchCtx("layout");
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Layout" });
  });
});

describe("showWidgetSettingsMenu — Display submenu", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("dispatches to Display SettingsList with 6 items", async () => {
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["showModel", "modelDisplayStyle", "showThinking", "__sep__", "statusBarFormat", "navHint"]);
  });

  it("showModel onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetShowModel = true;
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("showModel", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowModel).toBe(false);
  });

  it("statusBarFormat onChange updates store", async () => {
    mockModules.mockConfig.agent.statusBarFormat = "full";
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("statusBarFormat", "compact");
    expect(mockModules.mockConfig.agent.statusBarFormat).toBe("compact");
  });

  it("modelDisplayStyle onChange toggles between id/name", async () => {
    mockModules.mockConfig.agent.modelDisplayStyle = "id";
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("modelDisplayStyle", "Name");
    expect(mockModules.mockConfig.agent.modelDisplayStyle).toBe("name");
  });

  it("showThinking onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetShowThinking = true;
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("showThinking", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowThinking).toBe(false);
  });

  it("navHint onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetNavHint = true;
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("navHint", "OFF");
    expect(mockModules.mockConfig.agent.widgetNavHint).toBe(false);
  });

  it("has title 'Display'", async () => {
    const ctx = createDispatchCtx("display");
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Display" });
  });
});

describe("showWidgetSettingsMenu — Behavior submenu", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("dispatches to Behavior SettingsList with 5 items", async () => {
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["finishedRetention", "finishedEvictTurns", "__sep__", "shortcut", "thinkingBuffer"]);
  });

  it("shortcut onChange toggles store", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("shortcut", "ON");
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
  });

  it("thinkingBuffer onChange updates numeric value", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 0;
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "500");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(500);
  });

  it("thinkingBuffer OFF sets to 0", async () => {
    mockModules.mockConfig.agent.outputThinkingBufferSize = 200;
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("thinkingBuffer", "OFF");
    expect(mockModules.mockConfig.agent.outputThinkingBufferSize).toBe(0);
  });

  it("finishedRetention has submenu", async () => {
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "finishedRetention");
    expect(typeof item.submenu).toBe("function");
  });

  it("finishedEvictTurns has submenu", async () => {
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "finishedEvictTurns");
    expect(typeof item.submenu).toBe("function");
  });

  it("has title 'Behavior'", async () => {
    const ctx = createDispatchCtx("behavior");
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Behavior" });
  });
});

describe("showWidgetSettingsMenu — Stats submenu", () => {
  beforeEach(() => {
    setupMockConfig();
    vi.clearAllMocks();
    resetState();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("dispatches to Stats SettingsList with 9 items", async () => {
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual([
      "showTools",
      "showTurns",
      "showInput",
      "showOutput",
      "showContext",
      "showCost",
      "showTime",
      "__sep__",
      "deltaInputTokens",
    ]);
  });

  it("stat toggles update store", async () => {
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    const onChange = settingsListCalls[0].onChange;

    onChange("showTools", "OFF");
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    onChange("showCost", "ON");
    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    onChange("showTime", "OFF");
    expect(mockModules.mockConfig.agent.showTime).toBe(false);
  });

  it("deltaInputTokens toggle updates store", async () => {
    mockModules.mockConfig.agent.deltaInputTokens = false;
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    settingsListCalls[0].onChange("deltaInputTokens", "ON");
    expect(mockModules.mockConfig.agent.deltaInputTokens).toBe(true);
  });

  it("stat items show correct ON/OFF values", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items.find((i: any) => i.id === "showTools").currentValue).toBe("ON");
    expect(items.find((i: any) => i.id === "showCost").currentValue).toBe("OFF");
  });

  it("has title 'Stats'", async () => {
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    expect(wrapperCalls).toContainEqual({ title: "Stats" });
  });
  it("stat labels have no 'Show' prefix", async () => {
    const ctx = createDispatchCtx("stats");
    await showWidgetSettingsMenu(ctx);
    const labels = settingsListCalls[0].items.filter((i: any) => i.id !== "__sep__").map((i: any) => i.label);
    expect(labels).toEqual([
      "Tools",
      "Turns",
      "Input tokens",
      "Output tokens",
      "Context %",
      "Cost",
      "Time",
      "Delta input tokens",
    ]);
  });
});
