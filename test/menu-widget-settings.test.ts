/**
 * menu-widget-settings.test.ts — Tests for showWidgetSettingsMenu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showWidgetSettingsMenu } from "../src/ui/menu/menu-widget-settings.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

describe("showWidgetSettingsMenu — widget settings", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
    };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows widget settings menu items", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].length).toBeGreaterThan(0);
  });

  it("shows 'Force compact mode · OFF' when widgetCompact is false", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Force compact mode"))).toBe("Force compact mode · OFF");
  });

  it("shows 'Force compact mode · ON' when widgetCompact is true", async () => {
    mockModules.mockConfig.agent.widgetCompact = true;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Force compact mode"))).toBe("Force compact mode · ON");
  });

  it("toggles force compact mode and saves", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx(["Force compact mode · OFF", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Force compact mode ON", "info");
  });

  it("shows 'Max lines (full) · 12' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Max lines (full)"))).toBe("Max lines (full) · 12");
  });

  it("updates max lines and saves", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;
    const ctx = createMockCtx(["Max lines (full) · 12", undefined], ["10"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (full) set to 10", "info");
  });

  it("rejects max lines < 2", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;
    const ctx = createMockCtx(["Max lines (full) · 12", undefined], ["1"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(12);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 2", "error");
  });

  it("updates compact max lines and saves", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx(["Max lines (compact) · 6", undefined], ["4"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(4);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (compact) set to 4", "info");
  });

  it("rejects compact max lines < 1", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx(["Max lines (compact) · 6", undefined], ["0"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1", "error");
  });

  it("shows 'Description length (full) · 50' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Description length (full)"))).toBe("Description length (full) · 50");
  });

  it("updates description length (full) and saves", async () => {
    mockModules.mockConfig.agent.widgetDescLengthFull = 50;
    const ctx = createMockCtx(["Description length (full) · 50", undefined], ["80"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(80);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Description length (full) set to 80", "info");
  });

  it("rejects description length (full) < 5", async () => {
    mockModules.mockConfig.agent.widgetDescLengthFull = 50;
    const ctx = createMockCtx(["Description length (full) · 50", undefined], ["3"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetDescLengthFull).toBe(50);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 5", "error");
  });

  it("shows 'Description length (compact) · 30' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Description length (compact)"))).toBe("Description length (compact) · 30");
  });

  it("updates description length (compact) and saves", async () => {
    mockModules.mockConfig.agent.widgetDescLengthCompact = 30;
    const ctx = createMockCtx(["Description length (compact) · 30", undefined], ["20"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(20);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Description length (compact) set to 20", "info");
  });

  it("rejects description length (compact) < 5", async () => {
    mockModules.mockConfig.agent.widgetDescLengthCompact = 30;
    const ctx = createMockCtx(["Description length (compact) · 30", undefined], ["4"]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetDescLengthCompact).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 5", "error");
  });

  it("shows settings in correct order", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const compactIdx = items.findIndex((i: string) => i.startsWith("Force compact mode"));
    const maxLinesIdx = items.findIndex((i: string) => i.startsWith("Max lines (full)"));
    const descLengthFullIdx = items.findIndex((i: string) => i.startsWith("Description length (full)"));
    const maxLinesCompactIdx = items.findIndex((i: string) => i.startsWith("Max lines (compact)"));
    const descLengthCompactIdx = items.findIndex((i: string) => i.startsWith("Description length (compact)"));
    const shortcutIdx = items.findIndex((i: string) => i.startsWith("Ctrl+o shortcut"));
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(maxLinesIdx).toBeGreaterThan(compactIdx);
    expect(descLengthFullIdx).toBeGreaterThan(maxLinesIdx);
    expect(maxLinesCompactIdx).toBeGreaterThan(descLengthFullIdx);
    expect(descLengthCompactIdx).toBeGreaterThan(maxLinesCompactIdx);
    expect(shortcutIdx).toBeGreaterThan(descLengthCompactIdx);
  });
});

describe("showWidgetSettingsMenu — Ctrl+o shortcut toggle", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, widgetCompact: false, widgetShortcut: false };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows 'Ctrl+o shortcut · OFF' when widgetShortcut is false", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Ctrl+o shortcut"))).toBe("Ctrl+o shortcut · OFF");
  });

  it("shows 'Ctrl+o shortcut · ON' when widgetShortcut is true", async () => {
    mockModules.mockConfig.agent.widgetShortcut = true;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Ctrl+o shortcut"))).toBe("Ctrl+o shortcut · ON");
  });

  it("defaults to OFF when widgetShortcut is not set", async () => {
    delete mockModules.mockConfig.agent.widgetShortcut;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][1].find((i: string) => i.startsWith("Ctrl+o shortcut"))).toBe("Ctrl+o shortcut · OFF");
  });

  it("toggles shortcut from OFF to ON and saves", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const ctx = createMockCtx(["Ctrl+o shortcut · OFF", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Ctrl+o shortcut ON", "info");
  });

  it("toggles shortcut from ON to OFF and saves", async () => {
    mockModules.mockConfig.agent.widgetShortcut = true;
    const ctx = createMockCtx(["Ctrl+o shortcut · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Ctrl+o shortcut OFF", "info");
  });
});

describe("showWidgetSettingsMenu — stat visibility toggles", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null, forceBackground: false,
      widgetMaxLines: 12, widgetMaxLinesCompact: 6, widgetCompact: false,
      showTools: true, showTurns: true, showInput: true, showOutput: true,
      showContext: true, showCost: false, showTime: true,
    };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows all 7 stat toggle items", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.some((i: string) => i.startsWith("Show tools" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show turns" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show input tokens" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show output tokens" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show context %" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show cost" ))).toBe(true);
    expect(items.some((i: string) => i.startsWith("Show time" ))).toBe(true);
  });

  it("shows correct ON/OFF state for each toggle", async () => {
    mockModules.mockConfig.agent.showTools = true;
    mockModules.mockConfig.agent.showTurns = false;
    mockModules.mockConfig.agent.showInput = true;
    mockModules.mockConfig.agent.showOutput = false;
    mockModules.mockConfig.agent.showContext = true;
    mockModules.mockConfig.agent.showCost = false;
    mockModules.mockConfig.agent.showTime = true;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Show tools" ))).toContain("ON");
    expect(items.find((i: string) => i.startsWith("Show turns" ))).toContain("OFF");
    expect(items.find((i: string) => i.startsWith("Show input tokens" ))).toContain("ON");
    expect(items.find((i: string) => i.startsWith("Show output tokens" ))).toContain("OFF");
    expect(items.find((i: string) => i.startsWith("Show context %" ))).toContain("ON");
    expect(items.find((i: string) => i.startsWith("Show cost" ))).toContain("OFF");
    expect(items.find((i: string) => i.startsWith("Show time" ))).toContain("ON");
  });

  it("toggles showTools and saves", async () => {
    mockModules.mockConfig.agent.showTools = true;
    const ctx = createMockCtx(["Show tools · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showTools).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show tools OFF", "info");
  });

  it("toggles showTurns and saves", async () => {
    mockModules.mockConfig.agent.showTurns = false;
    const ctx = createMockCtx(["Show turns · OFF", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showTurns).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show turns ON", "info");
  });

  it("toggles showInput and saves", async () => {
    mockModules.mockConfig.agent.showInput = true;
    const ctx = createMockCtx(["Show input tokens · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showInput).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show input tokens OFF", "info");
  });

  it("toggles showOutput and saves", async () => {
    mockModules.mockConfig.agent.showOutput = true;
    const ctx = createMockCtx(["Show output tokens · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showOutput).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show output tokens OFF", "info");
  });

  it("toggles showContext and saves", async () => {
    mockModules.mockConfig.agent.showContext = true;
    const ctx = createMockCtx(["Show context % · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showContext).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show context % OFF", "info");
  });

  it("toggles showCost and saves", async () => {
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx(["Show cost · OFF", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show cost ON", "info");
  });

  it("toggles showTime and saves", async () => {
    mockModules.mockConfig.agent.showTime = true;
    const ctx = createMockCtx(["Show time · ON", undefined]);
    await showWidgetSettingsMenu(ctx);
    expect(mockModules.mockConfig.agent.showTime).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Show time OFF", "info");
  });

  it("stat toggles appear after existing settings", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const shortcutIdx = items.findIndex((i: string) => i.startsWith("Ctrl+o shortcut" ));
    const toolsIdx = items.findIndex((i: string) => i.startsWith("Show tools" ));
    const timeIdx = items.findIndex((i: string) => i.startsWith("Show time" ));
    expect(shortcutIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(timeIdx);
  });
});
