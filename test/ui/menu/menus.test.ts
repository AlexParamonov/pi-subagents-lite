/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 *
 * After migration: uses SelectList via ctx.ui.custom (not ctx.ui.select).
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture SelectList constructor calls from pi-tui
let selectListCalls: Array<{
  items: any[];
  maxVisible: number;
  onSelect?: (item: any) => void;
  onCancel?: () => void;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    constructor(items: any[], _maxVisible: number, _theme: any, _onChange: any, _onCancel: any) {
      this.items = items;
    }
  },
  SelectList: class MockSelectList {
    items: any[];
    maxVisible: number;
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[], maxVisible: number, _theme: any) {
      this.items = items;
      this.maxVisible = maxVisible;
      selectListCalls.push(this as any);
    }
  },
  Input: class MockInput {},
}));

// Import
import { showAgentsMainMenu, showSettingsMenu } from "../../../src/ui/menu/menus.js";

afterEach(() => resetConfig());

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showAgentsMainMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows 4 items: Running agents, Spawn agent, Settings, Debug", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items.map((i: any) => i.value)).toEqual(["running", "spawn", "settings", "debug"]);
    expect(selectListCalls[0].items.map((i: any) => i.label)).toEqual([
      "Running agents",
      "Spawn agent",
      "Settings",
      "Debug",
    ]);
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    // custom returns undefined = escape
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // undefined terminates the loop: no re-invocation after the first menu
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });
});

describe("showSettingsMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // undefined terminates the loop: no re-invocation after the first menu
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });
});

describe("main menu — submenu navigation", () => {
  beforeEach(() => {
    resetAgentState();
    selectListCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore")
        return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "General-purpose agent",
          extensions: false,
          skills: false,
          systemPrompt: "",
        };
      return undefined;
    });
  });

  it("debug submenu is accessible from main menu", async () => {
    const ctx = createMockCtx();
    // First custom call: main menu, returns 'debug'
    // Second custom call: debug menu (via showDebugMenu), returns undefined
    // Third custom call: back to main menu, returns undefined
    let customCallCount = 0;
    ctx.ui.custom.mockImplementation(async (factory: any) => {
      customCallCount++;
      // Build the menu component so its SelectList is captured
      factory(null, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, null, () => {});
      if (customCallCount === 1) return "debug"; // main menu → select debug
      return undefined; // debug menu and main menu escape
    });
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // Dispatch ran (2nd call = debug menu) and the loop re-invoked after it (3rd call)
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
    // The debug dispatch rendered the debug SelectList with its two items
    const debugItems = selectListCalls[1].items.map((i: any) => i.value);
    expect(debugItems).toEqual(["agent-types", "agent-briefing"]);
  });
});
