/**
 * menu-system-prompt.test.ts — Tests for showSystemPromptMenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showSystemPromptMenu } from "../src/ui/menu/menu-system-prompt.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showSystemPromptMenu — system prompt mode", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'System prompt mode · replace' by default", async () => {
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("System prompt mode"))).toBe("System prompt mode · replace");
  });

  it("shows configured system prompt mode", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "inherit";
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("System prompt mode"))).toBe("System prompt mode · inherit");
  });

  it("sets system prompt mode", async () => {
    const ctx = createMockCtx(["System prompt mode · replace", "inherit", undefined]);
    await showSystemPromptMenu(ctx);
    expect(mockModules.mockConfig.agent.systemPromptMode).toBe("inherit");
    expect(ctx.ui.notify).toHaveBeenCalledWith("System prompt mode set to inherit", "info");
  });
});

describe("showSystemPromptMenu — Create prompt file", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAgentState();
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.clearAllMocks();
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
    await showSystemPromptMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const createItem = items.find((i: string) => i.startsWith("Create prompt file"));
    expect(createItem).toBeDefined();
    expect(createItem).toContain("~/.pi/agent/subagents-lite-prompt.md");
  });

  it("does NOT show 'Create prompt file' when mode is custom and file exists", async () => {
    existsSyncSpy.mockReturnValue(true);
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("does NOT show 'Create prompt file' when mode is not custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "replace";
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("creates file and shows notification when 'Create prompt file' is selected", async () => {
    existsSyncSpy.mockReturnValue(false);
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showSystemPromptMenu(ctx);
    expect(mkdirSyncSpy).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created prompt file"), "info");
  });

  it("shows error notification when file creation fails", async () => {
    existsSyncSpy.mockReturnValue(false);
    mkdirSyncSpy.mockImplementation(() => { throw new Error("permission denied"); });
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showSystemPromptMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file"), "error");
  });
});

describe("showSystemPromptMenu — Include AGENTS.md", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Include AGENTS.md · ON' when includeContextFiles is true", async () => {
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · ON");
  });

  it("shows 'Include AGENTS.md · OFF' when includeContextFiles is false", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx([undefined]);
    await showSystemPromptMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · OFF");
  });

  it("toggles from ON to OFF and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = true;
    const ctx = createMockCtx(["Include AGENTS.md · ON", undefined]);
    await showSystemPromptMenu(ctx);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md OFF", "info");
  });

  it("toggles from OFF to ON and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx(["Include AGENTS.md · OFF", undefined]);
    await showSystemPromptMenu(ctx);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md ON", "info");
  });
});
