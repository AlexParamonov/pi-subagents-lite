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

  it("shows settings in correct order", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const compactIdx = items.findIndex((i: string) => i.startsWith("Force compact mode"));
    const maxLinesIdx = items.findIndex((i: string) => i.startsWith("Max lines (full)"));
    const maxLinesCompactIdx = items.findIndex((i: string) => i.startsWith("Max lines (compact)"));
    const shortcutIdx = items.findIndex((i: string) => i.startsWith("Ctrl+o shortcut"));
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(maxLinesIdx).toBeGreaterThan(compactIdx);
    expect(maxLinesCompactIdx).toBeGreaterThan(maxLinesIdx);
    expect(shortcutIdx).toBeGreaterThan(maxLinesCompactIdx);
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
