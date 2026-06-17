/**
 * menu-spawn-options.test.ts — Tests for showSpawnOptionsMenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showSpawnOptionsMenu } from "../src/menu-spawn-options.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showSpawnOptionsMenu — thinking level", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Thinking level · inherit' when no default is set", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Thinking level"))).toBe("Thinking level · inherit");
  });

  it("shows configured thinking level", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Thinking level"))).toBe("Thinking level · high");
  });

  it("sets thinking level to a specific value", async () => {
    const ctx = createMockCtx(["Thinking level · inherit", "medium", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultThinking).toBe("medium");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default thinking level set to medium", "info");
  });

  it("sets thinking level to inherit (undefined)", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx(["Thinking level · high", "inherit", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultThinking).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default thinking level set to inherit", "info");
  });

  it("shows thinking level select with all levels plus inherit", async () => {
    const ctx = createMockCtx(["Thinking level · inherit", undefined]);
    await showSpawnOptionsMenu(ctx);
    const thinkingCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Default thinking level");
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall[1]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);
  });
});

describe("showSpawnOptionsMenu — max turns", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Max turns · unlimited' when no default is set", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · unlimited");
  });

  it("shows configured max turns value", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · 50");
  });

  it("sets max turns to a specific value", async () => {
    const ctx = createMockCtx(["Max turns · unlimited", undefined], ["30"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default max turns set to 30", "info");
  });

  it("sets max turns to unlimited (undefined)", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx(["Max turns · 50", undefined], ["unlimited"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default max turns set to unlimited", "info");
  });

  it("rejects invalid max turns with error", async () => {
    const ctx = createMockCtx(["Max turns · unlimited", undefined], ["abc"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
  });

  it("rejects max turns < 1 with error", async () => {
    const ctx = createMockCtx(["Max turns · unlimited", undefined], ["0"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
  });
});

describe("showSpawnOptionsMenu — force background", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Force background · OFF' when disabled", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Force background"))).toBe("Force background · OFF");
  });

  it("shows 'Force background · ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Force background"))).toBe("Force background · ON");
  });

  it("toggles force background", async () => {
    mockModules.mockConfig.agent.forceBackground = false;
    const ctx = createMockCtx(["Force background · OFF", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.forceBackground).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Force background ON", "info");
  });
});

describe("showSpawnOptionsMenu — grace turns", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 6");
  });

  it("shows configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 10");
  });

  it("persists setting to 0", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx(["Grace turns · 5", undefined], ["0"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.graceTurns).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Grace turns set to 0", "info");
  });

  it("rejects negative numbers with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 3;
    const ctx = createMockCtx(["Grace turns · 3", undefined], ["-1"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
  });
});

describe("showSpawnOptionsMenu — system prompt mode", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'System prompt mode · replace' by default", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("System prompt mode"))).toBe("System prompt mode · replace");
  });

  it("shows configured system prompt mode", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "inherit";
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("System prompt mode"))).toBe("System prompt mode · inherit");
  });

  it("sets system prompt mode", async () => {
    const ctx = createMockCtx(["System prompt mode · replace", "inherit — parent's full system prompt (verbatim) + env + agent's systemPrompt", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.systemPromptMode).toBe("inherit");
    expect(ctx.ui.notify).toHaveBeenCalledWith("System prompt mode set to inherit", "info");
  });
});

describe("showSpawnOptionsMenu — Create prompt file", () => {
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
    await showSpawnOptionsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const createItem = items.find((i: string) => i.startsWith("Create prompt file"));
    expect(createItem).toBeDefined();
    expect(createItem).toContain("~/.pi/agent/subagents-lite-prompt.md");
  });

  it("does NOT show 'Create prompt file' when mode is custom and file exists", async () => {
    existsSyncSpy.mockReturnValue(true);
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("does NOT show 'Create prompt file' when mode is not custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "replace";
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Create prompt file"))).toBeUndefined();
  });

  it("creates file and shows notification when 'Create prompt file' is selected", async () => {
    existsSyncSpy.mockReturnValue(false);
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showSpawnOptionsMenu(ctx);
    expect(mkdirSyncSpy).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created prompt file"), "info");
  });

  it("shows error notification when file creation fails", async () => {
    existsSyncSpy.mockReturnValue(false);
    mkdirSyncSpy.mockImplementation(() => { throw new Error("permission denied"); });
    const selections = ["Create prompt file · ~/.pi/agent/subagents-lite-prompt.md", undefined];
    const ctx = createMockCtx(selections);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file"), "error");
  });
});

describe("showSpawnOptionsMenu — Include AGENTS.md", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Include AGENTS.md · ON' when includeContextFiles is true", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · ON");
  });

  it("shows 'Include AGENTS.md · OFF' when includeContextFiles is false", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Include AGENTS.md"))).toBe("Include AGENTS.md · OFF");
  });

  it("toggles from ON to OFF and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = true;
    const ctx = createMockCtx(["Include AGENTS.md · ON", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md OFF", "info");
  });

  it("toggles from OFF to ON and saves", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx(["Include AGENTS.md · OFF", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Include AGENTS.md ON", "info");
  });
});
