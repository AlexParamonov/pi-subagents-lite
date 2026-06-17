/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx, selectByName } from "./menu-test-helpers.js";
import { showAgentsMainMenu, showSettingsMenu } from "../src/ui/menu/menus.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
}

describe("showAgentsMainMenu — clear all overrides", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'No overrides to clear' when only forceBackground:false exists (no model overrides)", async () => {
    resetAgentState();
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No overrides to clear", "info");
    expect(mockModules.mockConfig.agent).toEqual({ default: null, forceBackground: false });
  });

  it("clears per-type overrides when they exist", async () => {
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("All model overrides cleared", "info");
    expect(mockModules.mockConfig.agent).toEqual({ default: null, forceBackground: false });
    expect(Object.keys(mockModules.mockConfig.agent).filter(k => k !== "default" && k !== "forceBackground")).toHaveLength(0);
  });

  it("preserves default and forceBackground when clearing", async () => {
    mockModules.mockConfig.agent.default = "openai/gpt-4o";
    mockModules.mockConfig.agent["general-purpose"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.agent.forceBackground = true;
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("All model overrides cleared", "info");
    expect(mockModules.mockConfig.agent).toEqual({ default: "openai/gpt-4o", forceBackground: true });
    expect(Object.keys(mockModules.mockConfig.agent).filter(k => k !== "default" && k !== "forceBackground")).toHaveLength(0);
  });

  it("preserves graceTurns when clearing all overrides", async () => {
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.graceTurns = 10;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(mockModules.mockConfig.agent.graceTurns).toBe(10);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("All model overrides cleared", "info");
  });

  it("preserves showCost when clearing all overrides", async () => {
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.showCost = false;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(mockModules.mockConfig.agent.showCost).toBe(false);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("All model overrides cleared", "info");
  });

  it("preserves widget settings when clearing all overrides", async () => {
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.widgetMaxLines = 10;
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 5;
    mockModules.mockConfig.agent.widgetCompact = true;
    mockModules.mockConfig.agent.widgetShortcut = true;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";
    const selections = [
      selectByName("settings"), selectByName("model"),
      "Clear all overrides", undefined, undefined, undefined,
    ];
    const ctx = createMockCtx(selections);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(5);
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("All model overrides cleared", "info");
  });
});

describe("showSettingsMenu", () => {
  beforeEach(() => { resetAgentState(); vi.clearAllMocks(); });

  it("shows Spawn options, Model settings, Concurrency settings, and Widget settings in sub-menu", async () => {
    const ctx = createMockCtx([undefined]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.includes("Spawn options"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Model settings"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Concurrency settings"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Widget settings"))).toBeDefined();
  });

  it("returns to main menu on Escape", async () => {
    const ctx = createMockCtx([undefined]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("returns to main menu when 'Back' is selected", async () => {
    const ctx = createMockCtx(["Back"]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("opens Model settings when selected", async () => {
    const ctx = createMockCtx([selectByName("model"), undefined]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Model Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });

  it("opens Concurrency settings when selected", async () => {
    const ctx = createMockCtx([selectByName("concurrency"), undefined]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Concurrency Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });

  it("opens Widget settings when selected", async () => {
    const ctx = createMockCtx([selectByName("widget"), undefined]);
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Widget Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });
});

describe("showAgentsMainMenu — settings sub-menu integration", () => {
  beforeEach(() => { resetAgentState(); vi.clearAllMocks(); });

  it("shows 4 items: Running agents, Spawn agent, Settings, Debug", async () => {
    const ctx = createMockCtx([undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.includes("Running agents"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Spawn agent"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Settings"))).toBeDefined();
    expect(items.find((i: string) => i.includes("Debug"))).toBeDefined();
    const runningIdx = items.findIndex((i: string) => i.includes("Running agents"));
    const spawnIdx = items.findIndex((i: string) => i.includes("Spawn agent"));
    const settingsIdx = items.findIndex((i: string) => i.includes("Settings"));
    const debugIdx = items.findIndex((i: string) => i.includes("Debug"));
    expect(spawnIdx).toBeGreaterThan(runningIdx);
    expect(settingsIdx).toBeGreaterThan(spawnIdx);
    expect(debugIdx).toBeGreaterThan(settingsIdx);
  });

  it("opens Settings sub-menu when selected", async () => {
    const ctx = createMockCtx([selectByName("settings"), undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Model settings", async () => {
    const ctx = createMockCtx([selectByName("settings"), selectByName("model"), undefined, undefined, undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Model Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Concurrency settings", async () => {
    const ctx = createMockCtx([selectByName("settings"), selectByName("concurrency"), undefined, undefined, undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Concurrency Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Widget settings", async () => {
    const ctx = createMockCtx([selectByName("settings"), selectByName("widget"), undefined, undefined, undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Widget Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });
});

describe("handleAgentBriefing — worktree_path content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("includes worktree_path in the parameters table", async () => {
    const mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    const ctx = createMockCtx([selectByName("debug"), "2", undefined, undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockSendUserMessage).toHaveBeenCalled();
    const sentMessage = mockSendUserMessage.mock.calls[0]?.[0];
    expect(sentMessage).toBeDefined();
    expect(sentMessage).toContain("worktree_path");
    expect(sentMessage).toContain("Optional path to a git worktree");
  });

  it("covers all five required briefing points", async () => {
    const mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    const ctx = createMockCtx([selectByName("debug"), "2", undefined, undefined]);
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const sentMessage = mockSendUserMessage.mock.calls[0]?.[0];
    expect(sentMessage).toContain("Optional");
    expect(sentMessage).toContain("git worktree of the parent");
    expect(sentMessage).toContain("Relative paths");
    expect(sentMessage).toContain("resolved against the parent");
    expect(sentMessage).toContain("specific reason");
    expect(sentMessage).toContain(".pi/agents/");
    expect(sentMessage).toContain("agent types");
  });
});
