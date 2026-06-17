/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 *
 * Uses ctx.ui.select with while(true) loop for dispatcher menus.
 * This pattern handles escape correctly and re-renders after each submenu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

// Import
import { showAgentsMainMenu, showSettingsMenu } from "../src/ui/menu/menus.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showAgentsMainMenu — ctx.ui.select dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.select (not ctx.ui.custom)", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("shows title 'Subagents Management'", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const selectCall = ctx.ui.select.mock.calls[0];
    expect(selectCall[0]).toBe("Subagents Management");
  });

  it("shows 4 menu items plus spacer and close hint", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const selectCall = ctx.ui.select.mock.calls[0];
    const items = selectCall[1];
    expect(items.length).toBe(6); // 4 items + spacer + close hint
    expect(items[0]).toContain("Running agents");
    expect(items[1]).toContain("Spawn agent");
    expect(items[2]).toContain("Settings");
    expect(items[3]).toContain("Debug");
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    ctx.ui.select.mockResolvedValue(undefined);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // select returned undefined = escape, function should complete
    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("Press Escape to close hint closes the menu", async () => {
    const ctx = createMockCtx();
    ctx.ui.select.mockResolvedValue("Press Escape to close");
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalled();
  });
});

describe("showSettingsMenu — ctx.ui.select dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.select (not ctx.ui.custom)", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("shows title 'Settings'", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const selectCall = ctx.ui.select.mock.calls[0];
    expect(selectCall[0]).toBe("Settings");
  });

  it("shows 5 menu items plus spacer and Back", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const selectCall = ctx.ui.select.mock.calls[0];
    const items = selectCall[1];
    expect(items.length).toBe(7); // 5 items + spacer + Back
    expect(items[0]).toContain("Model settings");
    expect(items[1]).toContain("Concurrency settings");
    expect(items[2]).toContain("Spawn options");
    expect(items[3]).toContain("System prompt");
    expect(items[4]).toContain("Widget settings");
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    ctx.ui.select.mockResolvedValue(undefined);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalled();
  });

  it("Back closes the menu", async () => {
    const ctx = createMockCtx();
    ctx.ui.select.mockResolvedValue("Back");
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalled();
  });
});

describe("main menu — debug submenu navigation", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("debug submenu is accessible from main menu", async () => {
    const ctx = createMockCtx();
    // First call: show main menu, select "Debug"
    ctx.ui.select.mockResolvedValueOnce("4. Debug — Agent types, briefing, diagnostics");
    // Second call: show debug menu, select "Agent types"
    ctx.ui.select.mockResolvedValueOnce("1. Agent types — List available agent types and their configs");
    // Third call: show agent types, escape
    ctx.ui.select.mockResolvedValueOnce(undefined);
    // Fourth call: back in debug menu, escape
    ctx.ui.select.mockResolvedValueOnce(undefined);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // Should have called select multiple times
    expect(ctx.ui.select).toHaveBeenCalled();
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Debug");
  });
});
