/**
 * menu-spawn-wizard.test.ts — Tests for showSpawnAgentMenu.
 *
 * Wizard approach: 3 sequential ctx.ui.custom calls.
 *   Step 1: SettingsList for type selection
 *   Step 2: Input for prompt entry
 *   Step 3: SettingsList for options + spawn
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, selectDialogInstances, resetSelectDialogInstances, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Component, SelectItem, SettingItem, SettingsListTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../../src/types.js";
import type { SpawnOptions } from "../../../src/agents/agent-manager.js";

// Mock pi's settings reads (per-model map + global default)
const piSettingsMock = vi.hoisted(() => ({
  getPiDefaultThinkingLevel: vi.fn<(cwd: string, agentDir?: string) => ThinkingLevel | undefined>(() => undefined),
  getPiModelThinkingLevels: vi.fn<(cwd: string, agentDir?: string) => Record<string, ThinkingLevel>>(() => ({})),
}));

vi.mock("../../../src/pi-settings.js", () => piSettingsMock);

// Mock pi-ai thinking level functions
let mockGetSupportedThinkingLevels: (model: Model<Api>) => ModelThinkingLevel[] = () => [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
let mockClampThinkingLevel: (model: Model<Api>, level: ModelThinkingLevel) => ModelThinkingLevel = (_m, level) => level;

vi.mock("@earendil-works/pi-ai", () => ({
  getSupportedThinkingLevels: vi.fn((model: Model<Api>) => mockGetSupportedThinkingLevels(model)),
  clampThinkingLevel: vi.fn((model: Model<Api>, level: ModelThinkingLevel) => mockClampThinkingLevel(model, level)),
}));

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: SettingItem[];
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: { enableSearch?: boolean };
  activate: (id: string) => void;
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
  items: SelectItem[];
  maxVisible: number;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}> = [];

vi.mock("@earendil-works/pi-tui", async () => {
  const { activatePickerRow } = await import("../../menu-picker-helpers.js");
  return {
    SettingsList: class MockSettingsList {
      items: SettingItem[];
      onChange: (id: string, newValue: string) => void;
      onCancel: () => void;
      options?: { enableSearch?: boolean };
      submenuComponent: Component | null = null;
      constructor(
        items: SettingItem[],
        maxVisible: number,
        theme: SettingsListTheme,
        onChange: (id: string, newValue: string) => void,
        onCancel: () => void,
        options?: { enableSearch?: boolean },
      ) {
        this.items = items;
        this.onChange = onChange;
        this.onCancel = onCancel;
        this.options = options;
        // Push the instance (not a snapshot) so rebuild() reassignments of
        // list.items stay observable through settingsListCalls.
        settingsListCalls.push(this);
      }
      activate(id: string) {
        activatePickerRow(this, id);
      }
    },
    Input: class MockInput {
      value = "";
      onSubmit?: (value: string) => void;
      onEscape?: () => void;
      setValue(v: string) {
        this.value = v;
      }
      getValue() {
        return this.value;
      }
      constructor() {
        inputInstances.push(this);
      }
    },
    SelectList: class MockSelectList {
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
      items: SelectItem[];
      maxVisible: number;
      constructor(items: SelectItem[], maxVisible: number, _theme?: SelectListTheme) {
        this.items = items;
        this.maxVisible = maxVisible;
        selectListInstances.push(this);
      }
    },
  };
});

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
  resetSelectDialogInstances();
  vi.mocked(getAgentConfig).mockImplementation((name: string) => {
    if (name === "general-purpose")
      return {
        name: "general-purpose",
        description: "General-purpose agent",
        model: "anthropic/claude-sonnet-4-20250514",
        thinkingLevel: "medium" as const,
        maxTurns: 25,
        maxTokens: 10000,
        extensions: true,
        skills: true,
        systemPrompt: "",
      };
    if (name === "Explore")
      return {
        name: "Explore",
        description: "Explore agent",
        model: "openai/gpt-4o",
        thinkingLevel: "low" as const,
        maxTurns: 10,
        extensions: false,
        skills: false,
        systemPrompt: "",
      };
    return undefined;
  });
  // Reset pi-ai mocks to defaults (reasoning model)
  mockGetSupportedThinkingLevels = (model: Model<Api>) =>
    model.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"];
  mockClampThinkingLevel = (_m: Model<Api>, level: ModelThinkingLevel) => level;
  piSettingsMock.getPiDefaultThinkingLevel.mockReturnValue(undefined);
  piSettingsMock.getPiModelThinkingLevels.mockReturnValue({});
}

/**
 * Create a mock ctx that returns step results sequentially.
 * stepResults: array of values returned from each ctx.ui.custom call.
 *   undefined = cancel at that step.
 */
function createMockWizardCtx(stepResults: (string | undefined)[]) {
  let callCount = 0;
  const ctx = createMockCtx([], [], [], {
    ui: {
      custom: vi.fn(async (factory) => {
        const stepIndex = callCount++;
        // Call factory to create component (captured by pi-tui mocks)
        const theme = { fg: (c: string, t: string) => t, bold: (t: string) => t };
        factory(null, theme, null, () => {});
        return stepResults[stepIndex];
      }),
    },
  });
  return ctx;
}

async function completeWizard(ctx: ReturnType<typeof createMockCtx>) {
  await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
}

afterEach(() => resetConfig());

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
    expect(settingsListCalls[0].items.map((i) => i.id)).toEqual(["general-purpose", "Explore"]);
    // Search must be enabled on the type selector (src passes { enableSearch: true }).
    expect(settingsListCalls[0].options?.enableSearch).toBe(true);
  });

  it("includes bullet prefix in type selection labels", async () => {
    const ctx = createMockWizardCtx([undefined]);
    await completeWizard(ctx);
    const items = settingsListCalls[0].items;
    // agentBulletPrefix returns "" in mock setup, but labels should contain type names
    for (const item of items) {
      expect(item.label).toContain(item.id);
    }
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
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir")
        return { code: 0, stdout: "/test/.git", stderr: "" };
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain")
        return { code: 0, stdout: "worktree /test\nbranch refs/heads/main", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i) => i.id);
    expect(ids).toContain("worktree");
  });

  it("does not include worktree item when not in git repo", async () => {
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { code: 128, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const ids = settingsListCalls[1].items.map((i) => i.id);
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
    const item = settingsListCalls[1].items.find((i) => i.id === "description")!;
    expect(item.currentValue).toBe("a".repeat(50));
  });

  it("description pre-filled from prompt (full if <=50 chars)", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "description")!;
    expect(item.currentValue).toBe("fix the bug");
  });

  it("description submenu creates Input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "description")!;
    const beforeCount = inputInstances.length;
    const mockDone = vi.fn();
    item.submenu!("fix the bug", mockDone);
    expect(inputInstances.length).toBe(beforeCount + 1);
  });
});

describe("showSpawnAgentMenu — thinking level", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("uses a submenu instead of static values", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(typeof item.submenu).toBe("function");
    expect(item.values).toBeUndefined();
  });

  it("shows agent config thinking level as currentValue", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(item.currentValue).toBe("medium");
  });

  it("pre-populates thinking from config default when agent has no thinking", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(item.currentValue).toBe("high");
  });

  it("agent config thinking takes precedence over config default", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(item.currentValue).toBe("medium");
  });

  it("shows 'medium' when no thinking source is set anywhere (pi's spawn fallback)", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(item.currentValue).toBe("medium");
  });

  it("submenu shows supported levels for reasoning model", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    const mockDone = vi.fn();
    item.submenu!("medium", mockDone);
    // The submenu creates a SelectList; check its items
    const list = selectListInstances[selectListInstances.length - 1];
    const values = list.items.map((i) => i.value);
    expect(values).toContain("off");
    expect(values).toContain("medium");
    expect(values).toContain("high");
    expect(values).toContain("inherit");
  });

  it("submenu shows only 'off' for non-reasoning model", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "openai/gpt-4o",
          thinkingLevel: "off" as const,
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    const mockDone = vi.fn();
    item.submenu!("off", mockDone);
    const list = selectListInstances[selectListInstances.length - 1];
    const values = list.items.map((i) => i.value);
    expect(values).toEqual(["off"]);
    // Check the description note
    expect(list.items[0].description).toContain("not supported");
  });

  it("model change re-derives thinking (Derived state) clamped to the new model", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          thinkingLevel: "high" as const,
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    // Clamp to a distinct value so the rebuilt options list proves the
    // clamp result was applied (identity would hide a discarded result).
    mockClampThinkingLevel = (_m: Model<Api>, level: ModelThinkingLevel) => (level === "high" ? "low" : level);
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const modelItem = settingsListCalls[1].items.find((i) => i.id === "model")!;
    const mockDone = vi.fn();
    modelItem.submenu!("anthropic/claude-sonnet-4-20250514", mockDone);
    // Trigger mode selection (session) — this creates the model selector
    settingsListCalls[settingsListCalls.length - 1].activate("session");
    // Select a non-reasoning model to trigger the re-derivation callback
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("openai/gpt-4o");
    // Derive runs once for the initial model and once for the switch; the
    // re-derivation must clamp against the NEW model (non-reasoning).
    const clampCalls = vi.mocked(clampThinkingLevel).mock.calls;
    expect(clampCalls.length).toBeGreaterThanOrEqual(2);
    const [model, level] = clampCalls[clampCalls.length - 1];
    expect(model.reasoning).toBe(false);
    expect(level).toBe("high");
    // The re-derived value is observable in the rebuilt options list
    const thinkingItem = settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;
    expect(thinkingItem.currentValue).toBe("low");
  });
});

describe("showSpawnAgentMenu — per-model thinking (Derived/UserSet)", () => {
  /** Agent config with no frontmatter thinking, so derivation starts at per-model. */
  function typeWithoutThinking() {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
  }

  const thinkingItem = () => settingsListCalls[1].items.find((i) => i.id === "thinkingLevel")!;

  /** Trigger the model submenu's session-target picker and select a model. */
  function switchModel(to: string) {
    const modelItem = settingsListCalls[1].items.find((i) => i.id === "model")!;
    modelItem.submenu!("anthropic/claude-sonnet-4-20250514", vi.fn());
    settingsListCalls[settingsListCalls.length - 1].activate("session");
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect(to);
  }

  /** Pick a level (or "inherit") from the thinking submenu — a user selection. */
  function pickThinking(level: string) {
    thinkingItem().submenu!("medium", vi.fn());
    const list = selectListInstances[selectListInstances.length - 1];
    list.onSelect!({ value: level, label: level });
    // The real SettingsList writes the picked value into the row and fires
    // onChange when the submenu completes — simulate that seam too.
    settingsListCalls[1].onChange("thinkingLevel", level);
  }

  async function spawnOptions(): Promise<SpawnOptions> {
    thinkingItem(); // ensure the list is built
    settingsListCalls[1].items.find((i) => i.id === "spawn")!.submenu!("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalled());
    return mockModules.mockManager.spawn.mock.calls[0][4];
  }

  beforeEach(() => {
    setupMocks();
    typeWithoutThinking();
  });

  it("shows the per-model level of the resolved model as the current value", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({ "anthropic/claude-sonnet-4-20250514": "high" });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("high");
  });

  it("shows pi's global default when frontmatter, per-model, and defaultThinking are unset", async () => {
    piSettingsMock.getPiDefaultThinkingLevel.mockReturnValue("low");
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("low");
  });

  it("per-model beats defaultThinking in the derived value", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({ "anthropic/claude-sonnet-4-20250514": "high" });
    mockModules.mockConfig.agent.defaultThinking = "max";
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("high");
  });

  it("model switch re-derives from the new model's per-model level (Derived state)", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({
      "anthropic/claude-sonnet-4-20250514": "high",
      "openai/gpt-4o": "low",
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("high");

    switchModel("openai/gpt-4o");
    expect(thinkingItem().currentValue).toBe("low");
  });

  it("model switch keeps a user-chosen level and clamps it to the new model (UserSet state)", async () => {
    mockClampThinkingLevel = (_m: Model<Api>, level: ModelThinkingLevel) => (level === "xhigh" ? "high" : level);
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    pickThinking("xhigh");
    expect(thinkingItem().currentValue).toBe("xhigh");

    switchModel("openai/gpt-4o");
    expect(thinkingItem().currentValue).toBe("high");
  });

  it("Inherit is a user selection: it displays 'inherit' and survives a model switch", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({ "anthropic/claude-sonnet-4-20250514": "high" });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("high");

    pickThinking("inherit");
    expect(thinkingItem().currentValue).toBe("inherit");

    switchModel("openai/gpt-4o");
    expect(thinkingItem().currentValue).toBe("inherit");
  });

  it("Derived state spawns with nothing so the runner resolves the chain at the spawn's target", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({ "anthropic/claude-sonnet-4-20250514": "high" });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    // The row still shows the predicted level for the current model.
    expect(thinkingItem().currentValue).toBe("high");

    const options = await spawnOptions();
    // The derived value is a display prediction read at the parent cwd.
    // Passing it as the explicit param would shadow the spawn target's own
    // per-model entry — frontmatter, per-model, and defaultThinking belong to
    // the runner's chain, so Derived passes nothing.
    expect(options.thinkingLevel).toBeUndefined();
    expect(options.invocation?.thinkingLevel).toBeUndefined();
  });

  it("worktree switch re-reads pi settings at the worktree and re-derives (Derived state)", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    piSettingsMock.getPiModelThinkingLevels.mockImplementation((cwd: string): Record<string, ThinkingLevel> =>
      cwd === "/test-feature" ? { "anthropic/claude-sonnet-4-20250514": "max" } : {},
    );
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    expect(thinkingItem().currentValue).toBe("medium");

    const wtItem = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    wtItem.submenu!("Inherits parent cwd", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    // The real SettingsList fires onChange when the submenu completes — the
    // rebuild that refreshes the displayed value rides on it.
    settingsListCalls[1].onChange("worktree", "feature");

    expect(piSettingsMock.getPiModelThinkingLevels).toHaveBeenCalledWith("/test-feature");
    expect(thinkingItem().currentValue).toBe("max");
  });

  it("returning to the parent cwd re-derives from the parent's settings (Derived state)", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    piSettingsMock.getPiModelThinkingLevels.mockImplementation((cwd: string): Record<string, ThinkingLevel> =>
      cwd === "/test-feature" ? { "anthropic/claude-sonnet-4-20250514": "max" } : {},
    );
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    const pickWorktree = (value: string) => {
      const wtItem = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
      wtItem.submenu!("Inherits parent cwd", vi.fn());
      selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect(value);
      settingsListCalls[1].onChange("worktree", value);
    };
    pickWorktree("/test-feature");
    expect(thinkingItem().currentValue).toBe("max");

    pickWorktree("Inherits parent cwd");
    expect(thinkingItem().currentValue).toBe("medium");
  });

  it("worktree switch keeps a user-chosen level (UserSet state)", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    piSettingsMock.getPiModelThinkingLevels.mockImplementation((cwd: string): Record<string, ThinkingLevel> =>
      cwd === "/test-feature" ? { "anthropic/claude-sonnet-4-20250514": "max" } : {},
    );
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    pickThinking("low");
    expect(thinkingItem().currentValue).toBe("low");

    const wtItem = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    wtItem.submenu!("Inherits parent cwd", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    settingsListCalls[1].onChange("worktree", "feature");

    expect(thinkingItem().currentValue).toBe("low");
    const options = await spawnOptions();
    expect(options.thinkingLevel).toBe("low");
  });

  it("spawns with nothing when the user picked Inherit, so the runtime chain decides", async () => {
    piSettingsMock.getPiModelThinkingLevels.mockReturnValue({ "anthropic/claude-sonnet-4-20250514": "high" });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    pickThinking("inherit");
    const options = await spawnOptions();
    expect(options.thinkingLevel).toBeUndefined();
  });
});

describe("showSpawnAgentMenu — max turns submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows agent config max turns", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    expect(item.currentValue).toBe("25");
  });

  it("shows '(not set)' when no config and no agent config", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    expect(item.currentValue).toBe("(not set)");
  });

  it("pre-populates from config default when agent has no maxTurns", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    expect(item.currentValue).toBe("50");
  });

  it("max turns submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    const mockDone = vi.fn();
    item.submenu!("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("15");
    expect(mockDone).toHaveBeenCalledWith("15");
  });

  it("max turns submenu accepts 'unlimited'", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    const mockDone = vi.fn();
    item.submenu!("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("unlimited");
    expect(mockDone).toHaveBeenCalledWith("(not set)");
  });

  it("max turns submenu rejects value < 1", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    const mockDone = vi.fn();
    item.submenu!("25", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("0");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu rejects invalid input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTurns")!;
    const mockDone = vi.fn();
    item.submenu!("25", mockDone);
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
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTokens")!;
    expect(item.currentValue).toBe("10000");
  });

  it("shows '(not set)' when no agent config", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name: "general-purpose",
          description: "",
          model: "anthropic/claude-sonnet-4-20250514",
          extensions: true,
          skills: true,
          systemPrompt: "",
        };
      return undefined;
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTokens")!;
    expect(item.currentValue).toBe("(not set)");
  });

  it("max tokens submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTokens")!;
    const mockDone = vi.fn();
    item.submenu!("10000", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("5000");
    expect(mockDone).toHaveBeenCalledWith("5000");
  });

  it("max tokens submenu rejects invalid input", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "maxTokens")!;
    const mockDone = vi.fn();
    item.submenu!("10000", mockDone);
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
    const item = settingsListCalls[1].items.find((i) => i.id === "graceTurns")!;
    expect(item.currentValue).toBe("8");
  });

  it("grace turns submenu accepts valid number", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "graceTurns")!;
    const mockDone = vi.fn();
    item.submenu!("6", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("3");
    expect(mockDone).toHaveBeenCalledWith("3");
  });

  it("grace turns submenu rejects negative numbers", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "graceTurns")!;
    const mockDone = vi.fn();
    item.submenu!("6", mockDone);
    inputInstances[inputInstances.length - 1].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});

describe("showSpawnAgentMenu — background toggle", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows 'ON' by default so the parent gets the result", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "background")!;
    expect(item.currentValue).toBe("ON");
  });

  it("shows 'ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "background")!;
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
    const item = settingsListCalls[1].items.find((i) => i.id === "model")!;
    expect(item.currentValue).toBe("anthropic/claude-sonnet-4-20250514");
    expect(typeof item.submenu).toBe("function");
  });

  it("shows '(inherits parent)' when no model in precedence chain", async () => {
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return { name: "general-purpose", description: "", extensions: true, skills: true, systemPrompt: "" };
      return undefined;
    });
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    const origModel = mockModules.mockSessionCtx.model;
    mockModules.mockSessionCtx.model = undefined;
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "model")!;
    expect(item.currentValue).toBe("(inherits parent)");
    mockModules.mockSessionCtx.model = origModel;
  });
});

function setupExecMock(
  options: { inGitRepo?: boolean; worktrees?: { path: string; branch?: string; detached?: boolean }[] } = {},
) {
  const { inGitRepo = true, worktrees = [] } = options;
  function buildPorcelainOutput(wts: typeof worktrees): string {
    return wts
      .map((wt) => {
        let block = `worktree ${wt.path}`;
        if (wt.branch) block += `\nbranch refs/heads/${wt.branch}`;
        else if (wt.detached) block += "\ndetached";
        return block;
      })
      .join("\n\n");
  }
  mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return inGitRepo
        ? { code: 0, stdout: "/test/.git", stderr: "" }
        : { code: 128, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
      if (!inGitRepo) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      return { code: 0, stdout: buildPorcelainOutput(worktrees), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown command" };
  });
}

describe("showSpawnAgentMenu — worktree submenu", () => {
  beforeEach(() => {
    setupMocks();
  });

  it("shows 'Inherits parent cwd' when in git repo", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    expect(item.currentValue).toBe("Inherits parent cwd");
  });

  it("worktree submenu creates SearchableSelectDialog with worktrees", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
        { path: "/test-feature", branch: "feature" },
      ],
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    const mockDone = vi.fn();
    item.submenu!("Inherits parent cwd", mockDone);
    const wtSelector = selectDialogInstances[selectDialogInstances.length - 1];
    const values = wtSelector.items.map((i) => i.value);
    expect(values[0]).toBe("Inherits parent cwd");
    expect(values).toHaveLength(3);
  });

  it("shows 'detached' for detached HEAD worktrees", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-detached", detached: true }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    const mockDone = vi.fn();
    item.submenu!("Inherits parent cwd", mockDone);
    const labels = selectDialogInstances[selectDialogInstances.length - 1].items.map((i) => i.label);
    expect(labels[1]).toContain("detached");
    expect(labels[1]).toContain("/test-detached");
  });

  it("selecting a worktree calls done with branch name", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
        { path: "/test-feature", branch: "feature" },
      ],
    });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    const mockDone = vi.fn();
    item.submenu!("Inherits parent cwd", mockDone);
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");
    expect(mockDone).toHaveBeenCalledWith("feature");
  });

  it("selecting 'Inherits parent cwd' returns that label", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    const mockDone = vi.fn();
    item.submenu!("Inherits parent cwd", mockDone);
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("Inherits parent cwd");
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
    const item = settingsListCalls[1].items.find((i) => i.id === "spawn")!;
    expect(typeof item.submenu).toBe("function");
  });

  it("spawn submenu immediately calls done", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "spawn")!;
    const mockDone = vi.fn();
    item.submenu!("", mockDone);
    expect(mockDone).toHaveBeenCalled();
  });

  it("invokes coordinator.spawn with the collected intent", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    const item = settingsListCalls[1].items.find((i) => i.id === "spawn")!;
    item.submenu!("", vi.fn());

    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalled());
    const [, , type, prompt, options] = mockModules.mockManager.spawn.mock.calls[0];
    expect(type).toBe("general-purpose");
    expect(prompt).toBe("fix the bug");
    // Derived state (no user pick): the wizard passes nothing — frontmatter,
    // per-model, and defaultThinking are resolved by the spawn runner's chain.
    expect(options.thinkingLevel).toBeUndefined();
    expect(options).toMatchObject({
      description: "fix the bug",
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      modelKey: "anthropic/claude-sonnet-4-20250514",
      maxTurns: 25,
      graceTurns: 6,
      isBackground: true,
      worktreePath: undefined,
      invocation: {
        modelName: "claude-sonnet-4-20250514",
        thinkingLevel: undefined,
        maxTurns: 25,
        runInBackground: true,
      },
    });
    // Menu-wizard spawns have no parent run — the intent carries no signal,
    // so the coordinator spread must not produce a signal option.
    expect(options).not.toHaveProperty("signal");
  });

  it("passes the selected worktree path to spawn", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test-feature", branch: "feature" }] });
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);

    const wtItem = settingsListCalls[1].items.find((i) => i.id === "worktree")!;
    wtItem.submenu!("Inherits parent cwd", vi.fn());
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("/test-feature");

    const spawnItem = settingsListCalls[1].items.find((i) => i.id === "spawn")!;
    spawnItem.submenu!("", vi.fn());
    await vi.waitFor(() => expect(mockModules.mockManager.spawn).toHaveBeenCalled());
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.worktreePath).toBe("/test-feature");
  });

  it("notifies 'Spawn failed' when the coordinator spawn rejects", async () => {
    const ctx = createMockWizardCtx(["general-purpose", "fix the bug", undefined]);
    await completeWizard(ctx);
    mockModules.mockManager.spawn.mockImplementation(() => {
      throw new Error("boom");
    });

    const item = settingsListCalls[1].items.find((i) => i.id === "spawn")!;
    item.submenu!("", vi.fn());

    await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalled());
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Spawn failed: boom"), "error");
  });
});
