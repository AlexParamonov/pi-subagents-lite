/**
 * menu-model-settings.test.ts — Tests for showModelSettingsMenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showModelSettingsMenu } from "../src/menu-model-settings.js";
import { getAgentConfig } from "../src/agent-types.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  for (const key of Object.keys(mockModules.mockSessionOverrides)) {
    if (key !== "default") delete mockModules.mockSessionOverrides[key];
  }
}

describe("showModelSettingsMenu — grace turns", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "", model: "openai/gpt-4o", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("displays 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 6");
  });

  it("displays configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 10");
  });

  it("prompts for number input with current value pre-filled", async () => {
    mockModules.mockConfig.agent.graceTurns = 8;
    const ctx = createMockCtx(["Grace turns · 8", undefined], ["12"]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.input).toHaveBeenCalledWith("Grace turns (≥ 0)", "8");
  });

  it("persists setting to 0", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx(["Grace turns · 5", undefined], ["0"]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockModules.mockConfig.agent.graceTurns).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Grace turns set to 0", "info");
  });

  it("rejects negative numbers with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 3;
    const ctx = createMockCtx(["Grace turns · 3", undefined], ["-1"]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
  });

  it("rejects non-numeric input with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx(["Grace turns · 5", undefined], ["abc"]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(5);
  });

  it("shows 'Grace turns' after 'Force background' and before separator", async () => {
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const forceBgIdx = items.findIndex((i: string) => i.startsWith("Force background"));
    const graceTurnsIdx = items.findIndex((i: string) => i.startsWith("Grace turns"));
    const separatorIdx = items.findIndex((i: string) => i === "─── per-type overrides ───");
    expect(forceBgIdx).toBeGreaterThanOrEqual(0);
    expect(graceTurnsIdx).toBeGreaterThan(forceBgIdx);
    expect(separatorIdx).toBeGreaterThan(graceTurnsIdx);
  });
});

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

describe("showModelSettingsMenu — include AGENTS.md toggle", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, includeContextFiles: true };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows 'Include AGENTS.md · ON' when includeContextFiles is true", async () => {
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · ON");
  });

  it("shows 'Include AGENTS.md · OFF' when includeContextFiles is false", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · OFF");
  });

  it("defaults to ON when includeContextFiles is not set", async () => {
    delete mockModules.mockConfig.agent.includeContextFiles;
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · ON");
  });

  it("toggles from ON to OFF and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = true;
    const selections = ["Include AGENTS.md · ON", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md OFF", "info");
  });

  it("toggles from OFF to ON and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const selections = ["Include AGENTS.md · OFF", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md ON", "info");
  });

  it("positions after 'Grace turns' and before 'System prompt mode'", async () => {
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const graceTurnsIdx = items.findIndex((i: string) => i.startsWith("Grace turns"));
    const contextIdx = items.findIndex((i: string) => i.startsWith("Include AGENTS.md"));
    const systemPromptIdx = items.findIndex((i: string) => i.startsWith("System prompt mode"));
    expect(graceTurnsIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeGreaterThan(graceTurnsIdx);
    expect(systemPromptIdx).toBeGreaterThan(contextIdx);
  });
});

describe("showModelSettingsMenu — Create prompt file", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, systemPromptMode: "custom" };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
    existsSyncSpy = vi.spyOn(fs, "existsSync");
    mkdirSyncSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
  });

  it("shows 'Create prompt file' when mode is custom and file does not exist", async () => {
    existsSyncSpy.mockReturnValue(false);
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const createItem = items.find((i: string) => i.startsWith("Create prompt file"));
    expect(createItem).toBeDefined();
    expect(createItem).toContain("~/.pi/agent/subagents-lite-prompt.md");
  });

  it("does NOT show 'Create prompt file' when mode is custom and file exists", async () => {
    existsSyncSpy.mockReturnValue(true);
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("does NOT show 'Create prompt file' when mode is not custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "replace";
    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("creates file and shows notification when 'Create prompt file' is selected", async () => {
    existsSyncSpy.mockReturnValue(false);
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(mkdirSyncSpy).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created prompt file"), "info");
  });

  it("shows error notification when file creation fails", async () => {
    existsSyncSpy.mockReturnValue(false);
    mkdirSyncSpy.mockImplementation(() => { throw new Error("permission denied"); });
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file"), "error");
  });
});
