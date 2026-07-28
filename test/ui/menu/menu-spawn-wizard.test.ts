/**
 * menu-spawn-wizard.test.ts — Tests for showSpawnAgentMenu.
 *
 * Wizard approach: 3 sequential ctx.ui.custom calls.
 *   Step 1: SelectList for type selection
 *   Step 2: Input for prompt entry
 *   Step 3: SettingsList for options + spawn
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules, selectDialogInstances, resetSelectDialogInstances } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig, getAvailableTypes, resolveAgentCatalog } from "../../../src/agents/agent-types.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  instance: any;
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
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, instance: this });
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
  mockModules.mockSessionOverrides = { default: null };
  mockModules.mockSessionThinkingOverrides = {};
  mockModules.mockConfig.thinkingOverrides = {};
  mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
  mockModules.mockManager.getRecord.mockReset();
  mockModules.mockPiExec.mockReset();
  vi.clearAllMocks();
  settingsListCalls = [];
  inputInstances = [];
  selectListInstances = [];
  resetSelectDialogInstances();
  (getAgentConfig as any).mockImplementation((name: string) => {
    if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinkingLevel: "medium" as const, maxTurns: 25, maxTokens: 10000, extensions: true, skills: true, systemPrompt: "" };
    if (name === "Explore") return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinkingLevel: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
    return undefined;
  });
  (getAvailableTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  (resolveAgentCatalog as any).mockReset().mockImplementation(async () => new Map([
    ["general-purpose", (getAgentConfig as any)("general-purpose")],
    ["Explore", (getAgentConfig as any)("Explore")],
  ]));
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

  it("shows the Agent MD thinking level when it is the effective setting", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.currentValue).toBe("medium");
  });

  it("uses the persisted per-agent thinking override before Agent MD", async () => {
    mockModules.mockConfig.thinkingOverrides["general-purpose"] = "xhigh";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    // The current model has no xhigh mapping, so the displayed value is the
    // nearest supported level rather than the persisted request.
    expect(item.currentValue).toBe("high");
  });

  it("uses the session per-agent thinking override before a persisted override", async () => {
    mockModules.mockConfig.thinkingOverrides["general-purpose"] = "xhigh";
    mockModules.mockSessionThinkingOverrides["general-purpose"] = "minimal";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "thinkingLevel");
    expect(item.currentValue).toBe("minimal");
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

describe("showSpawnAgentMenu — model-aware thinking", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("rebuilds the thinking list when the selected model changes", async () => {
    const noReasoning = { provider: "openai", id: "gpt-4o", reasoning: false };
    mockModules.mockSessionCtx.modelRegistry.find.mockImplementation((provider: string, modelId: string) => {
      if (`${provider}/${modelId}` === "openai/gpt-4o") return noReasoning;
      return { provider, id: modelId, reasoning: true };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    const modelItem = settingsListCalls[1].items.find((i: any) => i.id === "model");
    modelItem.submenu("", vi.fn());
    selectListInstances.at(-1)!.onSelect!({ value: "session" });
    selectDialogInstances.at(-1)!.callbacks.onSelect("openai/gpt-4o");

    let rebuiltThinking = settingsListCalls[1].instance.items.find((i: any) => i.id === "thinkingLevel");
    expect(rebuiltThinking.currentValue).toBe("off");
    expect(rebuiltThinking.values).toEqual(["inherit", "off"]);

    const rebuiltModel = settingsListCalls[1].instance.items.find((i: any) => i.id === "model");
    rebuiltModel.submenu("", vi.fn());
    selectListInstances.at(-1)!.onSelect!({ value: "session" });
    selectDialogInstances.at(-1)!.callbacks.onSelect("anthropic/claude-sonnet-4-20250514");

    rebuiltThinking = settingsListCalls[1].instance.items.find((i: any) => i.id === "thinkingLevel");
    expect(rebuiltThinking.currentValue).toBe("medium");
    expect(rebuiltThinking.values).toContain("medium");
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu rejects invalid input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "maxTurns");
    const mockDone = vi.fn();
    item.submenu("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
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

  it("shows the Agent MD model when it is the effective setting", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "model");
    expect(item.currentValue).toBe("anthropic/claude-sonnet-4-20250514");
    expect(typeof item.submenu).toBe("function");
  });

  it("uses the session per-agent model override before Agent MD", async () => {
    mockModules.mockConfig.agent["general-purpose"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["general-purpose"] = "openai/gpt-4o";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "model");
    expect(item.currentValue).toBe("openai/gpt-4o");
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
    const wtSelector = selectDialogInstances[selectDialogInstances.length - 1];
    const values = wtSelector.items.map((i: any) => i.value);
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
    const labels = selectDialogInstances[selectDialogInstances.length - 1].items.map((i: any) => i.label);
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
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    expect(mockDone).toHaveBeenCalledWith("feature");
  });

  it("refreshes model-aware options from a local worktree definition without leaking it", async () => {
    mockModules.mockSessionCtx.modelRegistry.find.mockImplementation((provider: string, id: string) => ({
      provider, id, reasoning: true,
    }));
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    (resolveAgentCatalog as any).mockImplementation(async (dir?: string) => new Map([
      ["general-purpose", dir ? {
        name: "general-purpose", description: "Worktree override",
        model: "openai/gpt-4o", thinkingLevel: "high",
        maxTurns: 7, maxTokens: 500, systemPrompt: "",
      } : (getAgentConfig as any)("general-purpose")],
      ["Explore", (getAgentConfig as any)("Explore")],
    ]));
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    const worktree = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    worktree.submenu("Inherits parent cwd", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    await vi.waitFor(() => expect((resolveAgentCatalog as any)).toHaveBeenCalledTimes(1));

    let items = settingsListCalls[1].instance.items;
    expect(items.find((i: any) => i.id === "model").currentValue).toBe("openai/gpt-4o");
    expect(items.find((i: any) => i.id === "thinkingLevel").currentValue).toBe("high");
    expect(items.find((i: any) => i.id === "thinkingLevel").values).toContain("high");
    expect(items.find((i: any) => i.id === "maxTurns").currentValue).toBe("7");
    expect(items.find((i: any) => i.id === "maxTokens").currentValue).toBe("500");

    // Switching back uses the original parent config rather than the overlay.
    items.find((i: any) => i.id === "worktree").submenu("feature", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("Inherits parent cwd");
    await vi.waitFor(() => expect(settingsListCalls[1].instance.items.find((i: any) => i.id === "model").currentValue).toBe("anthropic/claude-sonnet-4-20250514"));

    settingsListCalls[1].instance.items.find((i: any) => i.id === "spawn").submenu("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1));
    expect(mockModules.mockManager.spawn.mock.calls[0][4]).toMatchObject({
      thinkingLevel: "medium", maxTurns: 25, maxTokens: 10000,
    });
  });

  it("replaces worktree-only types when switching catalogs and snapshots the valid selection", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/wt-a", branch: "a" }, { path: "/wt-b", branch: "b" }] });
    (resolveAgentCatalog as any).mockImplementation(async (dir?: string) => new Map(
      (dir?.startsWith("/wt-a") ? ["general-purpose", "a-only"]
        : dir?.startsWith("/wt-b") ? ["general-purpose", "b-only"]
          : ["general-purpose", "Explore"])
        .map(name => [name, name === "general-purpose" ? (getAgentConfig as any)(name) : {
          name, description: name, model: "openai/gpt-4o", maxTurns: 3, systemPrompt: "",
        }]),
    ));
    const ctx = createMockWizardCtx(["general-purpose", "review", undefined]);
    await completeWizard(ctx);

    const selectWorktree = async (path: string) => {
      const item = settingsListCalls[1].instance.items.find((i: any) => i.id === "worktree");
      item.submenu(item.currentValue, vi.fn());
      selectDialogInstances.at(-1)!.callbacks.onSelect(path);
      await vi.waitFor(() => expect(resolveAgentCatalog).toHaveBeenCalledWith(`${path}/.pi/agents`, expect.anything()));
    };
    await selectWorktree("/wt-a");
    let type = settingsListCalls[1].instance.items.find((i: any) => i.id === "type");
    type.submenu("general-purpose", vi.fn());
    selectDialogInstances.at(-1)!.callbacks.onSelect("a-only");

    await selectWorktree("/wt-b");
    type = settingsListCalls[1].instance.items.find((i: any) => i.id === "type");
    expect(type.currentValue).toBe("general-purpose");
    type.submenu(type.currentValue, vi.fn());
    expect(selectDialogInstances.at(-1)!.items.map((item: any) => item.value)).toEqual(["general-purpose", "b-only"]);

    settingsListCalls[1].instance.items.find((i: any) => i.id === "spawn").submenu("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1));
    expect(mockModules.mockManager.spawn.mock.calls[0][4]).toMatchObject({
      worktreePath: "/wt-b",
      agentConfig: expect.objectContaining({ name: "general-purpose" }),
    });
    expect(mockModules.mockManager.spawn.mock.calls[0][2]).toBe("general-purpose");

    const parentWorktree = settingsListCalls[1].instance.items.find((i: any) => i.id === "worktree");
    parentWorktree.submenu(parentWorktree.currentValue, vi.fn());
    selectDialogInstances.at(-1)!.callbacks.onSelect("Inherits parent cwd");
    await vi.waitFor(() => expect(settingsListCalls[1].instance.items.find((i: any) => i.id === "type").currentValue).toBe("general-purpose"));
    type = settingsListCalls[1].instance.items.find((i: any) => i.id === "type");
    type.submenu(type.currentValue, vi.fn());
    expect(selectDialogInstances.at(-1)!.items.map((item: any) => item.value)).toEqual(["general-purpose", "Explore"]);
  });

  it("does not load worktree agent Markdown when the project is untrusted", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    ctx.isProjectTrusted = vi.fn(() => false);
    await completeWizard(ctx);

    const worktree = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    worktree.submenu("Inherits parent cwd", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("project is not trusted"),
      "warning",
    ));
    expect(resolveAgentCatalog).not.toHaveBeenCalled();

    // The spawn-time trust check also must not resolve an overlay.
    settingsListCalls[1].instance.items.find((i: any) => i.id === "spawn").submenu("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1));
    expect(resolveAgentCatalog).not.toHaveBeenCalled();
  });

  it("selecting 'Inherits parent cwd' returns that label", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "worktree");
    const mockDone = vi.fn();
    item.submenu("Inherits parent cwd", mockDone);
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("Inherits parent cwd");
    expect(mockDone).toHaveBeenCalledWith("Inherits parent cwd");
  });
});

describe("showSpawnAgentMenu — spawn action", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("opens a trusted worktree picker for an empty parent catalog and spawns a worktree-only type", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "/test/.git", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "worktree /wt-only\nbranch refs/heads/only", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    (getAvailableTypes as any).mockReturnValue([]);
    const worktreeOnly = { name: "worktree-only", description: "Only in worktree", model: "openai/gpt-4o", thinkingLevel: "high", maxTurns: 42, maxTokens: 8192, systemPrompt: "" };
    (resolveAgentCatalog as any).mockResolvedValue(new Map([["worktree-only", worktreeOnly]]));
    const ctx = createMockWizardCtx(["/wt-only", "worktree-only", "review", undefined]);
    await completeWizard(ctx);

    expect(resolveAgentCatalog).toHaveBeenCalledWith("/wt-only/.pi/agents", { disableDefaultAgents: undefined });
    const options = settingsListCalls.at(-1)!.instance.items;
    expect(options.find((i: any) => i.id === "type").currentValue).toBe("worktree-only");
    options.find((i: any) => i.id === "spawn").submenu("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1));
    expect(mockModules.mockManager.spawn.mock.calls[0][2]).toBe("worktree-only");
    expect(mockModules.mockManager.spawn.mock.calls[0][4]).toMatchObject({
      worktreePath: "/wt-only", agentConfig: worktreeOnly,
    });
  });

  it("spawn item has submenu", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "spawn");
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

  it("passes the selected thinking override to the spawned agent", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    settingsListCalls[1].onChange("thinkingLevel", "high");

    const item = settingsListCalls[1].items.find((i: any) => i.id === "spawn");
    item.submenu("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1));

    expect(mockModules.mockManager.spawn.mock.calls[0][4].thinkingLevel).toBe("high");
  });
});
