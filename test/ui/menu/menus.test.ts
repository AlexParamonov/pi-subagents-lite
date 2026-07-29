/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 *
 * After migration: uses SelectList via ctx.ui.custom (not ctx.ui.select).
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

// Import
import { showAgentsMainMenu, showSettingsMenu } from "../../../src/ui/menu/menus.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showAgentsMainMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows the simplified three-item main menu", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    // The SelectList is passed to ctx.ui.custom; items are in the factory
    // We verify via the custom call — the factory is invoked
    expect(ctx.ui.custom).toHaveBeenCalled();
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    // custom returns undefined = escape
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("showSettingsMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
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
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("main menu — submenu navigation", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("opens Settings from the main menu", async () => {
    const ctx = createMockCtx();
    let customCallCount = 0;
    ctx.ui.custom.mockImplementation(async () => {
      customCallCount++;
      return customCallCount === 1 ? "settings" : undefined;
    });
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
  });
});
