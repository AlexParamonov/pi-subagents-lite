/**
 * menu-spawn-wizard.test.ts — Tests for showSpawnAgentMenu.
 *
 * Wizard approach: 3 sequential ctx.ui.custom calls.
 *   Step 1: SelectList for type selection
 *   Step 2: Input for prompt entry
 *   Step 3: SettingsList for options + spawn
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
}> = [];

// Capture Input instances created
let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];

// Capture SelectList instances created
let selectListInstances: Array<{
  items: any[];
  maxVisible: number;
  onSelect?: (item: any) => void;
  onCancel?: () => void;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any) {
      this.items = items;
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel });
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() {
      inputInstances.push(this as any);
    }
  },
  SelectList: class MockSelectList {
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    items: any[];
    maxVisible: number;
    constructor(items: any[], maxVisible: number, _theme?: any) {
      this.items = items;
      this.maxVisible = maxVisible;
      selectListInstances.push(this as any);
    }
  },
}));

// Import AFTER mock setup
import { showSpawnAgentMenu } from "../../../src/ui/menu/menu-spawn-wizard.js";

function setupMocks() {
  mockModules.mockConfig.agent = { default: null, forceBackground: false, graceTurns: 6 };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
  mockModules.mockManager.getRecord.mockReset();
  mockModules.mockPiExec.mockReset();
  vi.clearAllMocks();
  settingsListCalls = [];
  inputInstances = [];
  selectListInstances = [];
  (getAgentConfig as any).mockImplementation((name: string) => {
    if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinkingLevel: "medium" as const, maxTurns: 25, maxTokens: 10000, extensions: true, skills: true, systemPrompt: "" };
    if (name === "Explore") return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinkingLevel: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
    return undefined;
  });
}

/**
 * Create a mock ctx that returns step results sequentially.
 * stepResults: array of values returned from each ctx.ui.custom call.
 *   undefined = cancel at that step.
 */
function createMockWizardCtx(stepResults: (string | undefined)[]) {
  const ctx = createMockCtx();
  let callCount = 0;
  ctx.ui.custom = vi.fn(async (factory) => {
    const stepIndex = callCount++;
    // Call factory to create component (captured by pi-tui mocks)
    const theme = { fg: (c: string, t: string) => t, bold: (t: string) => t };
    factory(null, theme, null, () => {});
    return stepResults[stepIndex];
  });
  return ctx;
}

// Helper to complete all 3 wizard steps
async function completeWizard(ctx: ReturnType<typeof createMockCtx>) {
  await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
}

describe("showSpawnAgentMenu — wizard flow", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("makes 1 ctx.ui.custom call when type selection cancelled", async () => {
    const ctx = createMockWizardCtx([undefined]);
    await completeWizard(ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("makes 2 ctx.ui.custom calls when prompt cancelled", async () => {
    const ctx = createMockWizardCtx(["general-purpose", undefined]);
    await completeWizard(ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
  });

  it("makes 3 ctx.ui.custom calls for full wizard (type → prompt → options)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(3);
  });

  it("creates SettingsList for type selection (step 1) with search", async () => {
    const ctx = createMockWizardCtx([undefined]);
    await completeWizard(ctx);
    expect(settingsListCalls.length).toBe(1);
    expect(settingsListCalls[0].items.map((i: any) => i.id)).toEqual(["general-purpose", "Explore"]);
  });

  it("creates Input for prompt entry (step 2)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", undefined]);
    await completeWizard(ctx);
    expect(inputInstances.length).toBe(1);
  });

  it("creates SettingsList for options (step 3) plus type selector (step 1)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(settingsListCalls.length).toBe(2);
  });
});

describe("showSpawnAgentMenu — step 3 options items", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("options SettingsList has correct items (no type)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).not.toContain("agentType");
    expect(ids).toContain("prompt");
    expect(ids).toContain("description");
    expect(ids).toContain("thinkingLevel");
    expect(ids).toContain("maxTurns");
    expect(ids).toContain("maxTokens");
    expect(ids).toContain("graceTurns");
    expect(ids).toContain("background");
    expect(ids).toContain("model");
    expect(ids).toContain("spawn");
    expect(ids).toContain("__back__");
  });

  it("includes worktree item when in git repo", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { code: 0, stdout: "/test/.git", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") return { code: 0, stdout: "worktree /test\nbranch refs/heads/main", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).toContain("worktree");
  });

  it("does not include worktree item when not in git repo", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { code: 128, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).not.toContain("worktree");
  });
});

describe("showSpawnAgentMenu — description", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("description pre-filled from prompt (truncated if >50 chars)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "a".repeat(100), undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "description");
    expect(item.currentValue).toBe("a".repeat(50));
  });

  it("description pre-filled from prompt (full if <=50 chars)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "description");
    expect(item.currentValue).toBe("fix the bug");
  });

  it("description submenu creates Input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "description");
    const beforeCount = inputInstances.length;
    const mockDone = vi.fn();
    item.submenu("fix the bug", mockDone);
    expect(inputInstances.length).toBe(beforeCount + 1);
  });
});

describe("showSpawnAgentMenu — thinking level", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows agent config thinking level", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.label).toBe("Thinking level");
    expect(item.currentValue).toBe("medium");
    expect(item.values).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);
  });

  it("pre-populates thinking from config default when agent has no thinking", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.currentValue).toBe("high");
  });

  it("agent config thinking takes precedence over config default", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.currentValue).toBe("medium");
  });

  it("shows 'inherit' when no config default and no agent config", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.currentValue).toBe("inherit");
  });
});

describe("showSpawnAgentMenu — max turns submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows agent config max turns", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    expect(item.label).toBe("Max turns");
    expect(item.currentValue).toBe("25");
  });

  it("shows 'unlimited' when no config and no agent config", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    expect(item.currentValue).toBe("(not set)");
  });

  it("pre-populates from config default when agent has no maxTurns", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    expect(item.currentValue).toBe("50");
  });

  it("max turns submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    const mockDone = vi.fn();
    item.submenu("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("15");
    expect(mockDone).toHaveBeenCalledWith("15");
  });

  it("max turns submenu accepts 'unlimited'", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    const mockDone = vi.fn();
    item.submenu("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("unlimited");
    expect(mockDone).toHaveBeenCalledWith("(not set)");
  });

  it("max turns submenu rejects value < 1", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    const mockDone = vi.fn();
    item.submenu("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("0");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value \u2014 must be a number \u2265 1", "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu rejects invalid input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    const mockDone = vi.fn();
    item.submenu("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value \u2014 must be a number \u2265 1", "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe("showSpawnAgentMenu — max tokens submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows agent config max tokens", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTokens");
    expect(item.label).toBe("Max tokens");
    expect(item.currentValue).toBe("10000");
  });

  it("shows 'unlimited' when no agent config", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTokens");
    expect(item.currentValue).toBe("(not set)");
  });

  it("max tokens submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTokens");
    const mockDone = vi.fn();
    item.submenu("10000", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("5000");
    expect(mockDone).toHaveBeenCalledWith("5000");
  });

  it("max tokens submenu rejects invalid input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTokens");
    const mockDone = vi.fn();
    item.submenu("10000", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value \u2014 must be a number \u2265 1", "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe("showSpawnAgentMenu — grace turns submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows configured grace turns", async () => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, graceTurns: 8 };
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "graceTurns");
    expect(item.label).toBe("Grace turns");
    expect(item.currentValue).toBe("8");
  });

  it("grace turns submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    item.submenu("6", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("3");
    expect(mockDone).toHaveBeenCalledWith("3");
  });

  it("grace turns submenu rejects negative numbers", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    item.submenu("6", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value \u2014 must be a number \u2265 0", "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe("showSpawnAgentMenu — background toggle", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows 'OFF' when disabled", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "background");
    expect(item.label).toBe("Background");
    expect(item.currentValue).toBe("OFF");
    expect(item.values).toEqual(["ON", "OFF"]);
  });

  it("shows 'ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "background");
    expect(item.currentValue).toBe("ON");
  });
});

describe("showSpawnAgentMenu — model", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows agent config model", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "model");
    expect(item.label).toBe("Model");
    expect(item.currentValue).toBe("anthropic/claude-sonnet-4-20250514");
    expect(typeof item.submenu).toBe("function");
  });

  it("shows '(inherits parent)' when no model in precedence chain", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name: "general-purpose", description: "", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    const origModel = mockModules.mockSessionCtx.model;
    mockModules.mockSessionCtx.model = undefined;
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "model");
    expect(item.currentValue).toBe("(inherits parent)");
    mockModules.mockSessionCtx.model = origModel;
  });
});

describe("showSpawnAgentMenu — worktree submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  function setupExecMock(options: { inGitRepo?: boolean; worktrees?: { path: string; branch?: string; detached?: boolean }[] } = {}) {
    const { inGitRepo = true, worktrees = [] } = options;
    function buildPorcelainOutput(wts: typeof worktrees): string {
      return wts.map(wt => {
        let block = `worktree ${wt.path}`;
        if (wt.branch) block += `\nbranch refs/heads/${wt.branch}`;
        else if (wt.detached) block += "\ndetached";
        return block;
      }).join("\n\n");
    }
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

  it("shows 'Inherits parent cwd' when in git repo", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    expect(item.currentValue).toBe("Inherits parent cwd");
  });

  it("worktree submenu creates SelectList with worktrees", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }, { path: "/test-feature", branch: "feature" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    const mockDone = vi.fn();
    item.submenu("Inherits parent cwd", mockDone);
    const wtSelectList = selectListInstances[selectListInstances.length - 1];
    const values = wtSelectList.items.map((i: any) => i.value);
    expect(values[0]).toBe("Inherits parent cwd");
    expect(values).toHaveLength(3);
  });

  it("shows 'detached' for detached HEAD worktrees", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-detached", detached: true }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    const mockDone = vi.fn();
    item.submenu("Inherits parent cwd", mockDone);
    const labels = selectListInstances[selectListInstances.length - 1].items.map((i: any) => i.label);
    expect(labels[1]).toContain("detached");
    expect(labels[1]).toContain("/test-detached");
  });

  it("selecting a worktree calls done with branch name", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }, { path: "/test-feature", branch: "feature" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    const mockDone = vi.fn();
    item.submenu("Inherits parent cwd", mockDone);
    selectListInstances[selectListInstances.length - 1].onSelect!({ value: "/test-feature" });
    expect(mockDone).toHaveBeenCalledWith("feature");
  });

  it("selecting 'Inherits parent cwd' returns that label", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    const mockDone = vi.fn();
    item.submenu("Inherits parent cwd", mockDone);
    selectListInstances[selectListInstances.length - 1].onSelect!({ value: "Inherits parent cwd" });
    expect(mockDone).toHaveBeenCalledWith("Inherits parent cwd");
  });
});

describe("showSpawnAgentMenu — spawn action", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("spawn item has submenu", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "spawn");
    expect(item.label).toBe("Spawn");
    expect(typeof item.submenu).toBe("function");
  });

  it("spawn submenu immediately calls done", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "spawn");
    const mockDone = vi.fn();
    item.submenu("", mockDone);
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnAgentMenu — item order", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("has expected setting items", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    expect(ids).toContain("spawn");
    expect(ids).toContain("model");
    expect(ids).toContain("background");
    expect(ids).toContain("thinkingLevel");
    expect(ids).toContain("prompt");
    expect(ids).toContain("__back__");
  });

  it("worktree appears after background when in git repo", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { code: 0, stdout: "/test/.git", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") return { code: 0, stdout: "worktree /test\nbranch refs/heads/main", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i: any) => i.id);
    const bgIdx = ids.indexOf("background");
    const wtIdx = ids.indexOf("worktree");
    expect(wtIdx).toBe(bgIdx + 1);
  });

  it("Back item calls done", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const backItem = settingsListCalls[1].items.find((i: any) => i.id === "__back__");
    expect(backItem).toBeDefined();
    expect(backItem.label).toBe("Back");
    const done = vi.fn();
    backItem.submenu("", done);
    expect(done).toHaveBeenCalled();
  });
});
