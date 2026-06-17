/**
 * menu-model-settings.test.ts — Tests for showModelSettingsMenu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showModelSettingsMenu } from "../src/ui/menu/menu-model-settings.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  for (const key of Object.keys(mockModules.mockSessionOverrides)) {
    if (key !== "default") delete mockModules.mockSessionOverrides[key];
  }
}



describe("showModelSettingsMenu — clear per-type override", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "", model: "openai/gpt-4o", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("shows 'Clear' option when type has a permanent override", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",
      "Clear",
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const saveModeCall = ctx.ui.select.mock.calls.find((call: any) => call[0] === "Save mode");
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).toContain("Clear");
  });

  it("does NOT show 'Clear' option when type has no permanent override", async () => {
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent["Explore"] = undefined;
    const selections = [
      "Explore          ·  openai/gpt-4o [session]",
      "Set for this session (not saved)",
      "anthropic/claude-sonnet-4-20250514",
      undefined,
    ];
    const ctx = createMockCtx(selections, [], ["anthropic/claude-sonnet-4-20250514"]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const saveModeCall = ctx.ui.select.mock.calls.find((call: any) => call[0] === "Save mode");
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).not.toContain("Clear");
  });

  it("removes permanent override and saves config when 'Clear' is selected", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",
      "Clear",
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
  });

  it("clears both session and permanent override", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const selections = [
      "Explore          ·  openai/gpt-4o [session]",
      "Clear",
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    expect(mockModules.mockSessionOverrides["Explore"]).toBeUndefined();
  });

  it("shows notification after clearing overrides", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",
      "Clear",
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Explore overrides cleared", "info");
  });

  it("does not show clear option for global default entry", async () => {
    const selections = [
      "Global default model · (inherits parent)",
      undefined,
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const saveModeCall = ctx.ui.select.mock.calls.find((call: any) => call[0] === "Save mode");
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).not.toContain("Clear");
  });

  it("shows 'Clear' for type with override even when session also active", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const selections = [
      "Explore          ·  openai/gpt-4o [session]",
      "Clear",
      undefined,
    ];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const clearCall = ctx.ui.select.mock.calls.find((call: any) => call[1]?.includes("Clear"));
    expect(clearCall).toBeDefined();
  });
});

describe("showModelSettingsMenu — cost display toggle", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, showCost: true };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows 'Cost display · ON' when showCost is true", async () => {
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Cost display"))).toBe("Cost display · ON");
  });

  it("shows 'Cost display · OFF' when showCost is false", async () => {
    mockModules.mockConfig.agent.showCost = false;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Cost display"))).toBe("Cost display · OFF");
  });

  it("toggles permanently when user chooses 'Set permanently'", async () => {
    mockModules.mockConfig.agent.showCost = true;
    const selections = ["Cost display · ON", "Set permanently", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mockModules.mockConfig.agent.showCost).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cost display OFF", "info");
  });

  it("toggles as session override when user chooses 'Set for this session'", async () => {
    mockModules.mockConfig.agent.showCost = true;
    const selections = ["Cost display · ON", "Set for this session", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    expect(mockModules.mockSessionShowCost).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cost display OFF", "info");
  });

  it("shows [session] indicator when session override is active", async () => {
    mockModules.mockConfig.agent.showCost = false;
    mockModules.mockSessionShowCost = true;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Cost display"))).toBe("Cost display · ON [session]");
  });

  it("offers 'Clear' option when session override is active", async () => {
    mockModules.mockConfig.agent.showCost = false;
    mockModules.mockSessionShowCost = true;
    const selections = ["Cost display · ON [session]", "Clear", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mockModules.mockSessionShowCost).toBeUndefined();
    expect(mockModules.mockConfig.agent.showCost).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cost display session override cleared", "info");
  });

  it("defaults to false when showCost is not set", async () => {
    delete mockModules.mockConfig.agent.showCost;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Cost display"))).toBe("Cost display · OFF");
  });
});




