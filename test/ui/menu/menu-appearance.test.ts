import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

let settingsLists: Array<any> = [];
let inputs: Array<any> = [];
vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: (id: string, value: string) => void;
    constructor(items: any[], _max: number, _theme: any, onChange: any) {
      this.items = items;
      this.onChange = onChange;
      settingsLists.push(this);
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    constructor() { inputs.push(this); }
    setValue(value: string) { this.value = value; }
    getValue() { return this.value; }
  },
}));

import { showAppearanceMenu } from "../../../src/ui/menu/menu-appearance.js";

describe("showAppearanceMenu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false, widgetCompact: false, widgetMaxLines: 12,
      widgetShowModelThinking: true,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    settingsLists = [];
    inputs = [];
    vi.clearAllMocks();
  });

  it("contains the common appearance controls", async () => {
    await showAppearanceMenu(createMockCtx());
    expect(settingsLists[0].items.map((item: any) => item.id)).toEqual([
      "compact", "maxLines", "showModelThinking", "statsPreset",
    ]);
    expect(settingsLists[0].items.find((item: any) => item.id === "statsPreset").currentValue).toBe("Standard");
  });

  it("toggles model and thinking visibility", async () => {
    await showAppearanceMenu(createMockCtx());
    settingsLists[0].onChange("showModelThinking", "OFF");
    expect(mockModules.mockConfig.agent.widgetShowModelThinking).toBe(false);
  });

  it("shows Custom for mixed stats and applies the Detailed preset", async () => {
    mockModules.mockConfig.agent.showTools = false;
    const ctx = createMockCtx();
    await showAppearanceMenu(ctx);
    expect(settingsLists[0].items.find((item: any) => item.id === "statsPreset").currentValue).toBe("Custom");
    settingsLists[0].onChange("statsPreset", "Detailed");
    expect(mockModules.mockConfig.agent).toMatchObject({
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: true, showTime: true,
    });
  });

  it("applies the Minimal preset as elapsed time only", async () => {
    await showAppearanceMenu(createMockCtx());
    settingsLists[0].onChange("statsPreset", "Minimal");
    expect(mockModules.mockConfig.agent).toMatchObject({
      showTools: false, showTurns: false, showInput: false, showOutput: false,
      showContext: false, showCost: false, showTime: true,
    });
  });

  it("applies the Standard preset", async () => {
    mockModules.mockConfig.agent.showCost = true;
    await showAppearanceMenu(createMockCtx());
    settingsLists[0].onChange("statsPreset", "Standard");
    expect(mockModules.mockConfig.agent).toMatchObject({
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    });
  });

  it("updates full-mode widget lines through its numeric submenu", async () => {
    const ctx = createMockCtx();
    await showAppearanceMenu(ctx);
    const maxLines = settingsLists[0].items.find((item: any) => item.id === "maxLines");
    const done = vi.fn();
    maxLines.submenu("12", done);
    inputs[0].onSubmit("18");
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(18);
    expect(done).toHaveBeenCalledWith("18");
  });
});
