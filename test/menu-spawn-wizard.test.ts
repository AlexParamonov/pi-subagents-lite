/**
 * menu-spawn-wizard.test.ts — Tests for showSpawnAgentMenu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showSpawnAgentMenu } from "../src/spawn-wizard.js";
import { getAgentConfig } from "../src/agent-types.js";

describe("showSpawnAgentMenu — type selection", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      if (name === "Explore") return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinking: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("shows types from getAvailableTypes()", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Select agent type");
    expect(ctx.ui.select.mock.calls[0][1]).toEqual(["general-purpose", "Explore"]);
  });

  it("returns to main menu on Escape at type selection", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });

  it("shows error for unknown type and loops back", async () => {
    const ctx = createMockCtx(["unknown-type", undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Unknown agent type: unknown-type", "error");
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
  });
});

describe("showSpawnAgentMenu — prompt entry", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
  });

  it("shows prompt input after type selection", async () => {
    const ctx = createMockCtx(["general-purpose", undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.input).toHaveBeenCalledWith("Agent prompt");
  });

  it("shows error for empty prompt and loops back", async () => {
    const ctx = createMockCtx(["general-purpose", undefined], ["", undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Prompt cannot be empty", "error");
    expect(ctx.ui.input).toHaveBeenCalledTimes(2);
  });

  it("returns to main menu on Escape at prompt", async () => {
    const ctx = createMockCtx(["general-purpose", undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("rejects whitespace-only prompt", async () => {
    const ctx = createMockCtx(["general-purpose", undefined], ["   ", undefined]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Prompt cannot be empty", "error");
  });
});

describe("showSpawnAgentMenu — options sub-menu", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, graceTurns: 8 };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      if (name === "Explore") return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinking: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it("shows pre-filled options from agent config and global config", async () => {
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall).toBeDefined();
    const items: string[] = optionsCall[1];
    expect(items.find((i: string) => i.startsWith("Description"))).toBe("Description · Do something");
    expect(items.find((i: string) => i.startsWith("Model"))).toBe("Model · anthropic/claude-sonnet-4-20250514");
    expect(items.find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · medium");
    expect(items.find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · 25");
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 8");
    expect(items.find((i: string) => i.startsWith("Background"))).toBe("Background · OFF");
  });

  it("pre-populates thinking from config default when agent has no thinking", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · high");
  });

  it("pre-populates max turns from config default when agent has no maxTurns", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · 50");
  });

  it("agent config thinking takes precedence over config default", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    // agent config (medium) takes precedence over config default (high)
    expect(optionsCall[1].find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · medium");
  });

  it("shows 'inherit' for thinking when no config default and no agent config", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · inherit");
  });

  it("shows 'unlimited' for max turns when no config default and no agent config", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · unlimited");
  });

  it("auto-generates description from first 50 chars of prompt", async () => {
    const longPrompt = "A".repeat(60);
    const ctx = createMockCtx(["general-purpose", undefined], [longPrompt]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Description"))).toBe(`Description · ${"A".repeat(50)}`);
  });

  it("allows overriding description", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Description · Do something", undefined],
      ["Do something", "Custom description"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.input).toHaveBeenCalledWith("Description", "Do something");
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Description"))).toBe("Description · Custom description");
    }
  });

  it("allows changing model via model selector", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", undefined],
      ["Do something"],
      ["openai/gpt-4o"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Model"))).toBe("Model · openai/gpt-4o");
    }
  });

  it("allows changing thinking level", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Thinking · medium", "high", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const thinkingCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Thinking level");
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall[1]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · high");
    }
  });

  it("allows setting thinking to inherit", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Thinking · medium", "inherit", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Thinking"))).toBe("Thinking · inherit");
    }
  });

  it("allows changing max turns", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "15"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · 15");
    }
  });

  it("allows setting max turns to unlimited", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "unlimited"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Max turns"))).toBe("Max turns · unlimited");
    }
  });

  it("rejects invalid max turns with error", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "abc"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
  });

  it("allows changing grace turns", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Grace turns · 8", undefined],
      ["Do something", "3"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 3");
    }
  });

  it("rejects invalid grace turns with error", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Grace turns · 8", undefined],
      ["Do something", "-1"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
  });

  it("toggles background ON/OFF", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Background · OFF", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    if (optionsCalls[1]) {
      expect(optionsCalls[1][1].find((i: string) => i.startsWith("Background"))).toBe("Background · ON");
    }
  });

  it("returns to main menu on Escape at options", async () => {
    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockModules.mockManager.spawn).not.toHaveBeenCalled();
  });

  it("shows '(inherits parent)' when no model in precedence chain", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    const origModel = mockModules.mockSessionCtx.model;
    mockModules.mockSessionCtx.model = undefined;
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Model"))).toBe("Model · (inherits parent)");
    mockModules.mockSessionCtx.model = origModel;
  });
});

describe("showSpawnAgentMenu — spawn action", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, graceTurns: 6 };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
  });

  it("calls getManager().spawn() with correct arguments", async () => {
    const ctx = createMockCtx(["general-purpose", "Spawn"], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1);
    const [pi, sCtx, type, prompt, options] = mockModules.mockManager.spawn.mock.calls[0];
    expect(type).toBe("general-purpose");
    expect(prompt).toBe("Do something");
    expect(options.description).toBe("Do something");
    expect(options.isBackground).toBe(false);
    expect(options.graceTurns).toBe(6);
    expect(options.thinkingLevel).toBe("medium");
    expect(options.maxTurns).toBe(25);
    expect(options.invocation).toBeDefined();
    expect(options.invocation.thinking).toBe("medium");
    expect(options.invocation.maxTurns).toBe(25);
  });

  it("registers activity in coordinator live view for background spawn", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Background · OFF", "Spawn"],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.isBackground).toBe(true);
  });

  it("blocks until completion for foreground spawn", async () => {
    let resolvePromise!: (value: string) => void;
    const promise = new Promise<string>((r) => { resolvePromise = r; });
    mockModules.mockManager.getRecord.mockReturnValue({ execution: { promise } });
    const ctx = createMockCtx(["general-purpose", "Spawn"], ["Do something"]);
    const spawnPromise = showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    resolvePromise("result");
    await spawnPromise;
  });

  it("shows error when model not found in registry and returns to options", async () => {
    const origFind = mockModules.mockSessionCtx.modelRegistry.find;
    mockModules.mockSessionCtx.modelRegistry.find = vi.fn(() => undefined);
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", "Spawn", undefined],
      ["Do something"],
      ["unknown/unknown"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model not found: unknown/unknown", "error");
    expect(mockModules.mockManager.spawn).not.toHaveBeenCalled();
    mockModules.mockSessionCtx.modelRegistry.find = origFind;
  });

  it("shows error when manager spawn throws and returns to main menu", async () => {
    mockModules.mockManager.spawn.mockImplementation(() => { throw new Error("Spawn failed: internal error"); });
    const ctx = createMockCtx(["general-purpose", "Spawn"], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Spawn failed: Spawn failed: internal error", "error");
  });

  it("resolves selected model string to Model object via findModelInRegistry", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", "Spawn"],
      ["Do something"],
      ["openai/gpt-4o"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.model).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(options.modelKey).toBe("openai/gpt-4o");
    expect(options.invocation.modelName).toBe("gpt-4o");
  });

  it("passes custom description to spawn options", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Description · Do something", "Spawn"],
      ["Do something", "Custom label"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.description).toBe("Custom label");
  });
});

describe("showSpawnAgentMenu — worktree picker", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    mockModules.mockPiExec.mockReset();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
  });

  function buildPorcelainOutput(worktrees: { path: string; branch?: string; detached?: boolean }[]): string {
    return worktrees.map(wt => {
      let block = `worktree ${wt.path}`;
      if (wt.branch) block += `\nbranch refs/heads/${wt.branch}`;
      else if (wt.detached) block += "\ndetached";
      return block;
    }).join("\n\n");
  }

  function setupExecMock(options: { inGitRepo?: boolean; worktrees?: { path: string; branch?: string; detached?: boolean }[] } = {}) {
    const { inGitRepo = true, worktrees = [] } = options;
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return inGitRepo ? { code: 0, stdout: "/test/.git", stderr: "" } : { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
        if (!inGitRepo) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        return { code: 0, stdout: buildPorcelainOutput(worktrees), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unknown command" };
    });
  }

  it("shows 'Worktree · Inherits parent cwd' in options when in a git repo", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Worktree"))).toBe("Worktree · Inherits parent cwd");
  });

  it("does not show 'Worktree' row when not in a git repo", async () => {
    setupExecMock({ inGitRepo: false });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Worktree"))).toBeUndefined();
  });

  it("opens worktree picker with 'Inherits parent cwd' first and worktrees from git", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }, { path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(["general-purpose", "Worktree · Inherits parent cwd", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    expect(pickerCall[1][0]).toBe("Inherits parent cwd");
    expect(pickerCall[1]).toHaveLength(3);
  });

  it("shows branch name and path in picker rows", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }, { path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(["general-purpose", "Worktree · Inherits parent cwd", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    expect(pickerCall[1][1]).toContain("main");
    expect(pickerCall[1][1]).toContain("/test");
    expect(pickerCall[1][2]).toContain("feature");
    expect(pickerCall[1][2]).toContain("/test-feature");
  });

  it("shows 'detached' for detached HEAD worktrees", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-detached", detached: true }] });
    const ctx = createMockCtx(["general-purpose", "Worktree · Inherits parent cwd", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    expect(pickerCall[1][1]).toContain("detached");
    expect(pickerCall[1][1]).toContain("/test-detached");
  });

  it("updates worktree row to selected branch after picking a worktree", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }, { path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "feature  ·  /test-feature", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls[optionsCalls.length - 1][1].find((i: string) => i.startsWith("Worktree"))).toBe("Worktree · feature");
  });

  it("updates worktree row to 'Inherits parent cwd' when that option is picked", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "Inherits parent cwd", undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls[optionsCalls.length - 1][1].find((i: string) => i.startsWith("Worktree"))).toBe("Worktree · Inherits parent cwd");
  });

  it("returns to options on Escape from picker without committing change", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined, undefined],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls.length).toBe(2);
    expect(optionsCalls[1][1].find((i: string) => i.startsWith("Worktree"))).toBe("Worktree · Inherits parent cwd");
  });

  it("shows notification and returns to options when git worktree list fails", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { code: 0, stdout: "/test/.git", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list") return { code: 128, stdout: "", stderr: "fatal: git unavailable" };
      return { code: 1, stdout: "", stderr: "unknown" };
    });
    const ctx = createMockCtx(["general-purpose", "Worktree · Inherits parent cwd", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("worktree"), "error");
  });

  it("forwards worktreePath in spawn options when a worktree is picked", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "feature  ·  /test-feature", "Spawn"],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.worktreePath).toBe("/test-feature");
    expect(options.worktreeLabel).toBe("feature");
  });

  it("does not forward worktreePath when 'Inherits parent cwd' is selected", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "Inherits parent cwd", "Spawn"],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.worktreePath).toBeUndefined();
    expect(options.worktreeLabel).toBeUndefined();
  });

  it("calls discoverNewAgents with worktree path before spawn", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "feature  ·  /test-feature", "Spawn"],
      ["Do something"],
    );
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const { discoverNewAgents } = await import("../src/agent-types.js");
    expect(discoverNewAgents).toHaveBeenCalledWith("/test-feature/.pi/agents");
  });

  it("does not call discoverNewAgents when no worktree is picked", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockCtx(["general-purpose", "Spawn"], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const { discoverNewAgents } = await import("../src/agent-types.js");
    expect(discoverNewAgents).not.toHaveBeenCalled();
  });

  it("does not show 'Worktree' row when git repo check throws", async () => {
    mockModules.mockPiExec.mockRejectedValue(new Error("ENOENT"));
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall[1].find((i: string) => i.startsWith("Worktree"))).toBeUndefined();
  });

  it("positions 'Worktree' row after 'Description' in the options menu", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);
    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    const items: string[] = optionsCall[1];
    const descIdx = items.findIndex((i: string) => i.startsWith("Description"));
    const worktreeIdx = items.findIndex((i: string) => i.startsWith("Worktree"));
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(worktreeIdx).toBeGreaterThan(descIdx);
  });
});
