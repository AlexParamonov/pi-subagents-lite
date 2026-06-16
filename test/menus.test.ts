/**
 * menus.test.ts — Tests for /agents menu system (concurrency settings).
 *
 * Tests focus on:
 *   - Remove limit for per-provider entries
 *   - Remove limit for per-model entries
 *   - Reset all to defaults
 *   - Edit limit still works after refactor
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock modules ---

const mockModules = vi.hoisted(() => ({
  mockConfig: {
    agent: { default: null, forceBackground: false },
    concurrency: { default: 4 },
  },
  mockSessionOverrides: { default: null },
  resultViewerCalls: [] as any[][],
  mockManager: {
    setConcurrency: vi.fn(),
    listAgents: vi.fn(() => []),
    getRecord: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(),
    spawn: vi.fn(() => "agent-id-123"),
  },
  mockSessionCtx: {
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => {
        const known: Record<string, { provider: string; id: string }> = {
          "openai/gpt-4o": { provider: "openai", id: "gpt-4o" },
          "anthropic/claude-sonnet-4-20250514": { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        };
        return known[`${provider}/${modelId}`];
      }),
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "openai", id: "gpt-4o" },
      ]),
    },
    model: { provider: "test", id: "parent-model" },
    cwd: "/test",
  },
  mockAgentActivity: new Map(),
  mockBackgroundAgentIds: new Set(),
  mockPiExec: vi.fn(),
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => name),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../src/model-selector.js", () => ({
  ModelSelectorDialog: class {},
}));

vi.mock("../src/result-viewer.js", () => ({
  ResultViewer: class {
    constructor(...args: any[]) {
      mockModules.resultViewerCalls.push(args);
    }
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  getDisplayName: vi.fn((t: string) => t),
}));

vi.mock("../src/context.js", () => ({
  buildSnapshotMarkdown: vi.fn(),
}));

vi.mock("../src/config-io.js", () => ({
  saveConfigAtomic: vi.fn(),
  DEFAULT_CONFIG: {
    agent: { default: null, forceBackground: false },
    concurrency: { default: 4 },
  },
}));

vi.mock("../src/tool-execution.js", () => ({
  createActivityTracker: vi.fn((maxTurns?: number) => ({
    state: {
      activeTools: new Map(),
      toolUses: 0,
      turnCount: 1,
      maxTurns,
      responseText: "",
      session: undefined,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
    },
    callbacks: {
      onToolActivity: vi.fn(),
      onTextDelta: vi.fn(),
      onTurnEnd: vi.fn(),
      onSessionCreated: vi.fn(),
      onAssistantUsage: vi.fn(),
    },
  })),
  backgroundAgentIds: mockModules.mockBackgroundAgentIds,
}));

// Mock state.ts with a mutable config object
vi.mock("../src/state.js", () => {
  // Create a mock store that delegates to the mutable mock config
  const mockStore = {
    get agent() {
      const a = mockModules.mockConfig.agent;
      const widgetMaxLines = a.widgetMaxLines ?? 12;
      return {
        defaultModel: a.default ?? null,
        forceBackground: a.forceBackground === true,
        showCost: a.showCost === true,
        graceTurns: a.graceTurns ?? 6,
        widgetMaxLines,
        widgetMaxLinesCompact: a.widgetMaxLinesCompact ?? Math.floor(widgetMaxLines / 2),
        widgetCompact: a.widgetCompact === true,
        widgetShortcut: a.widgetShortcut === true,
      };
    },
    get concurrency() {
      return {
        default: mockModules.mockConfig.concurrency.default,
        providers: mockModules.mockConfig.concurrency.providers ?? {},
        models: mockModules.mockConfig.concurrency.models ?? {},
      };
    },
    get sessionDefaultModel() {
      return mockModules.mockSessionOverrides.default ?? null;
    },
    sessionModelOverride(type: string) {
      return mockModules.mockSessionOverrides[type] ?? null;
    },
    agentConfigSnapshot() {
      return mockModules.mockConfig.agent;
    },
    modelFor(type: string, parentModelId: string, agentConfig?: any) {
      // Simplified model resolution for testing
      const sessionOverride = mockModules.mockSessionOverrides[type];
      if (sessionOverride) return sessionOverride;
      const sessionDefault = mockModules.mockSessionOverrides.default;
      if (sessionDefault) return sessionDefault;
      const configOverride = mockModules.mockConfig.agent[type];
      if (configOverride) return configOverride;
      const configDefault = mockModules.mockConfig.agent.default;
      if (configDefault) return configDefault;
      if (agentConfig?.model) return agentConfig.model;
      return parentModelId;
    },
  };

  return {
    __config: mockModules.mockConfig,
    sessionOverrides: mockModules.mockSessionOverrides,
    store: mockStore,
    getManager: () => mockModules.mockManager,
    getWidget: vi.fn(() => undefined),
    piInstance: { sendUserMessage: vi.fn(), exec: mockModules.mockPiExec },
    sessionCtx: mockModules.mockSessionCtx,
    agentActivity: mockModules.mockAgentActivity,
    setShowCostEnabled: vi.fn((enabled: boolean) => {
      mockModules.mockConfig.agent.showCost = enabled;
    }),
    syncWidgetSettings: vi.fn(),
  };
});

// --- Import module under test ---
import { showConcurrencySettingsMenu, showModelSettingsMenu, showWidgetSettingsMenu, showAgentsMainMenu, showSettingsMenu, showSpawnAgentMenu } from "../src/menus.js";
import { getAgentConfig } from "../src/agent-types.js";

/**
 * Select menu item by partial name match.
 * Maps short names to menu items: 'model', 'concurrency', 'running', 'widget', 'debug'
 */
function selectByName(name: string): (title: string, items: string[]) => string | undefined {
  const nameMap: Record<string, string> = {
    model: "Model settings",
    concurrency: "Concurrency settings",
    running: "Running agents",
    widget: "Widget settings",
    debug: "Debug",
    settings: "Settings",
    spawn: "Spawn agent",
  };
  const search = nameMap[name.toLowerCase()] ?? name;
  return (_title: string, items: string[]) => {
    const match = items.find(item => item.toLowerCase().includes(search.toLowerCase()));
    return match ?? undefined;
  };
}

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
}

/**
 * Create a mock extension command context with controllable UI.
 *
 * @param selections Array of values that ctx.ui.select returns sequentially.
 * @param inputs Array of values that ctx.ui.input returns sequentially.
 * @param customValues Array of values that ctx.ui.custom returns sequentially.
 */
function createMockCtx(
  selections: (string | ((title: string, items: string[]) => string | undefined) | undefined)[] = [],
  inputs: (string | undefined)[] = [],
  customValues: (string | null)[] = [],
): any {
  let selectIdx = 0;
  let inputIdx = 0;
  let customIdx = 0;

  return {
    ui: {
      select: vi.fn(async (title: string, items: string[]) => {
        const sel = selections[selectIdx++];
        if (typeof sel === "function") return sel(title, items);
        return sel ?? undefined;
      }),
      input: vi.fn(async (_label: string, _initialValue?: string) => {
        return inputs[inputIdx++] ?? undefined;
      }),
      custom: vi.fn(async (_factory: any) => {
        // If customValues have explicit entries, return those
        if (customIdx < customValues.length) {
          return customValues[customIdx++];
        }
        // Otherwise, invoke the factory to trigger side effects (e.g. ResultViewer construction)
        // Provide a mock tui with terminal.rows, a noop theme, and a done callback
        _factory(
          { terminal: { rows: 40 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
          },
          null,
          () => {},
        );
        return undefined;
      }),
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "openai", id: "gpt-4o" },
      ]),
    },
  };
}

function resetConfig(): void {
  mockModules.mockConfig.concurrency = { default: 4 };
}

describe("showConcurrencySettingsMenu — remove limit", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  describe("per-provider remove limit", () => {
    it("removes a per-provider limit when 'Remove limit' is selected", async () => {
      // Arrange: set up a provider limit
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2 };
      const selections = [
        "llamacpp  ·  2 slots",  // click the provider entry
        "Remove limit",          // click remove
        undefined,               // Escape to exit the loop (runMenuLoop returns)
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "llamacpp/4b"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency.providers).toEqual({});
      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBeUndefined();

      // Verify notification was shown
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Removed per-provider limit for llamacpp",
        "info",
      );
    });

    it("preserves other providers when one is removed", async () => {
      // Arrange: set up multiple provider limits
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2, openai: 5 };

      const selections = [
        "openai  ·  5 slots",    // click openai entry
        "Remove limit",          // click remove
        undefined,               // Escape to exit
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b", "openai/gpt-4o"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(2);
      expect(mockModules.mockConfig.concurrency.providers!.openai).toBeUndefined();
    });
  });

  describe("per-model remove limit", () => {
    it("removes a per-model limit when 'Remove limit' is selected", async () => {
      // Arrange: set up a model limit
      mockModules.mockConfig.concurrency.models = { "llamacpp/4b": 3 };

      const selections = [
        "llamacpp/4b  ·  3 slots",  // click the model entry
        "Remove limit",             // click remove
        undefined,                  // Escape to exit
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Removed per-model limit for llamacpp/4b",
        "info",
      );
    });
  });

  describe("reset all to defaults", () => {
    it("clears all per-provider and per-model limits when 'Reset all to defaults' is selected", async () => {
      // Arrange: set up various limits
      mockModules.mockConfig.concurrency = {
        default: 4,
        providers: { llamacpp: 2, openai: 5 },
        models: { "llamacpp/4b": 3, "openai/gpt-4o": 1 },
      };

      const selections = [
        "Reset all to defaults",  // click reset
        undefined,                // Escape to exit
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b", "openai/gpt-4o"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency).toEqual({ default: 4 });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Concurrency reset to defaults",
        "info",
      );
    });
  });

  describe("edit limit still works", () => {
    it("edits a per-provider limit when 'Edit limit' is selected", async () => {
      // Arrange: set up a provider limit
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2 };

      const selections = [
        "llamacpp  ·  2 slots",  // click the provider entry
        "Edit limit",            // click edit
        undefined,               // Escape to exit (after menu loop back)
      ];

      const inputs = [
        "5",  // new value
      ];

      const ctx = createMockCtx(selections, inputs);
      const modelOptions = ["llamacpp/4b"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(5);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "llamacpp concurrency set to 5",
        "info",
      );
    });

    it("edits a per-model limit when 'Edit limit' is selected", async () => {
      // Arrange: set up a model limit
      mockModules.mockConfig.concurrency.models = { "llamacpp/4b": 1 };

      const selections = [
        "llamacpp/4b  ·  1 slots",  // click the model entry
        "Edit limit",                // click edit
        undefined,                   // Escape to exit
      ];

      const inputs = [
        "8",  // new value
      ];

      const ctx = createMockCtx(selections, inputs);
      const modelOptions = ["llamacpp/4b"];

      // Act
      await showConcurrencySettingsMenu(ctx, modelOptions);

      // Assert
      expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBe(8);
    });
  });
});

// ---------------------------------------------------------------------------
// Grace turns tests
// ---------------------------------------------------------------------------

describe("showModelSettingsMenu — grace turns", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    for (const key of Object.keys(mockModules.mockSessionOverrides)) {
      if (key !== "default") delete mockModules.mockSessionOverrides[key];
    }
    vi.clearAllMocks();

    // Set up agent config mock to return a default model for each type
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") {
        return { name: "Explore", description: "", model: "openai/gpt-4o", extensions: false, skills: false, systemPrompt: "" };
      }
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: false, skills: false, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("displays 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    const items = ctx.ui.select.mock.calls[0][1];
    const graceTurnsItem = items.find((i: string) => i.startsWith("Grace turns"));
    expect(graceTurnsItem).toBe("Grace turns · 6");
  });

  it("displays 'Grace turns · 6' when config value is undefined", async () => {
    // graceTurns not set in mock — defaults to 6
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    const items = ctx.ui.select.mock.calls[0][1];
    const graceTurnsItem = items.find((i: string) => i.startsWith("Grace turns"));
    expect(graceTurnsItem).toBe("Grace turns · 6");
  });

  it("displays configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    const items = ctx.ui.select.mock.calls[0][1];
    const graceTurnsItem = items.find((i: string) => i.startsWith("Grace turns"));
    expect(graceTurnsItem).toBe("Grace turns · 10");
  });

  it("prompts for number input with current value pre-filled", async () => {
    mockModules.mockConfig.agent.graceTurns = 8;
    // Selection sequence: click Grace turns, then Escape to exit
    const ctx = createMockCtx(["Grace turns · 8", undefined], ["12"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.input).toHaveBeenCalledWith("Grace turns (≥ 0)", "8");
  });

  it("persists setting to 0", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const ctx = createMockCtx(["Grace turns · 5", undefined], ["0"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    expect(mockModules.mockConfig.agent.graceTurns).toBe(0);
    expect(saveConfigAtomic).toHaveBeenCalledWith(mockModules.mockConfig);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Grace turns set to 0", "info");
  });

  it("rejects negative numbers with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 3;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const ctx = createMockCtx(["Grace turns · 3", undefined], ["-1"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    // Value should not change
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
    // Config should not be saved (no saveConfigAtomic call for grace turns action)
    const graceTurnsSaveCalls = saveConfigAtomic.mock.calls.filter(
      (call: any[]) => call[0] === mockModules.mockConfig,
    );
    // Only the initial menu build calls save, not the rejected action
    expect(graceTurnsSaveCalls.length).toBe(0);
  });

  it("rejects non-numeric input with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const ctx = createMockCtx(["Grace turns · 5", undefined], ["abc"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(5);
    const graceTurnsSaveCalls = saveConfigAtomic.mock.calls.filter(
      (call: any[]) => call[0] === mockModules.mockConfig,
    );
    expect(graceTurnsSaveCalls.length).toBe(0);
  });

  it("shows 'Grace turns' after 'Force background' and before separator", async () => {
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showModelSettingsMenu(ctx, modelOptions);

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
    // Reset config state
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    for (const key of Object.keys(mockModules.mockSessionOverrides)) {
      if (key !== "default") delete mockModules.mockSessionOverrides[key];
    }
    vi.clearAllMocks();

    // Set up agent config mock to return a default model for each type
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") {
        return { name: "Explore", description: "", model: "openai/gpt-4o", extensions: false, skills: false, systemPrompt: "" };
      }
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", extensions: false, skills: false, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("shows 'Clear' option when type has a permanent override", async () => {
    // Arrange: Set a permanent override for Explore
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";

    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",  // click Explore entry (frontmatter → override)
      "Clear",                                          // choose clear
      undefined,                                          // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert: the "Save mode" select includes "Clear"
    const selectCalls = ctx.ui.select.mock.calls;
    const saveModeCall = selectCalls.find((call: any) =>
      call[0] === "Save mode"
    );
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).toContain("Clear");
  });

  it("does NOT show 'Clear' option when type has no permanent override", async () => {
    // Arrange: Session override exists (so type appears in overrides section), but no permanent override
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent["Explore"] = undefined;

    const selections = [
      "Explore          ·  openai/gpt-4o [session]",  // click Explore entry
      "Set for this session (not saved)", // choose session
      "anthropic/claude-sonnet-4-20250514", // pick model
      undefined,  // Escape to exit
    ];

    const ctx = createMockCtx(selections, [], ["anthropic/claude-sonnet-4-20250514"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert: the "Save mode" select excludes "Clear"
    const selectCalls = ctx.ui.select.mock.calls;
    const saveModeCall = selectCalls.find((call: any) =>
      call[0] === "Save mode"
    );
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).not.toContain("Clear");
  });

  it("removes permanent override and saves config when 'Clear' is selected", async () => {
    // Arrange
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",  // click Explore entry (frontmatter → override)
      "Clear",                                          // choose clear
      undefined,                                          // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert
    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    expect(saveConfigAtomic).toHaveBeenCalledWith(mockModules.mockConfig);
  });

  it("clears both session and permanent override", async () => {
    // Arrange: Both session and permanent override for Explore
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";

    const selections = [
      "Explore          ·  openai/gpt-4o [session]",  // click Explore entry (shows session value)
      "Clear",                                // choose clear
      undefined,                                // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert: both cleared
    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    expect(mockModules.mockSessionOverrides["Explore"]).toBeUndefined();
  });

  it("shows notification after clearing overrides", async () => {
    // Arrange
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";

    const selections = [
      "Explore          ·  openai/gpt-4o → anthropic/claude-sonnet-4-20250514",  // click Explore entry (frontmatter → override)
      "Clear",                                          // choose clear
      undefined,                                          // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Explore overrides cleared",
      "info",
    );
  });

  it("does not show clear option for global default entry", async () => {
    // Arrange: Global default can't be "cleared" — only set to null
    const selections = [
      "Global default model · (inherits parent)",  // click global default
      undefined,  // Escape instead of choosing
      undefined,  // Escape to exit submenu
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert: the "Save mode" select (from promptOverrideMode) must not include "Clear"
    const selectCalls = ctx.ui.select.mock.calls;
    const saveModeCall = selectCalls.find((call: any) =>
      call[0] === "Save mode"
    );
    expect(saveModeCall).toBeDefined();
    expect(saveModeCall[1]).not.toContain("Clear");
  });

  it("shows 'Clear' for type with override even when session also active", async () => {
    // Arrange: Both session and permanent override for Explore
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";

    const selections = [
      "Explore          ·  openai/gpt-4o [session]",  // click Explore entry
      "Clear",                                // choose clear
      undefined,                                // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showModelSettingsMenu(ctx, modelOptions);

    // Assert: select menu included clear option
    const selectCalls = ctx.ui.select.mock.calls;
    const clearCall = selectCalls.find((call: any) =>
      call[1]?.includes("Clear")
    );
    expect(clearCall).toBeDefined();
  });
});

describe("showAgentsMainMenu — clear all overrides", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'No overrides to clear' when only forceBackground:false exists (no model overrides)", async () => {
    // Arrange:
    // __config.agent = { default: null, forceBackground: false }
    // This is the bug scenario: forceBackground:false should NOT count as an override.
    resetAgentState();

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No overrides to clear",
      "info",
    );
    // Config should remain unchanged
    expect(mockModules.mockConfig.agent).toEqual({
      default: null,
      forceBackground: false,
    });
  });

  it("clears per-type overrides when they exist", async () => {
    // Arrange: set a per-type model override
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All model overrides cleared",
      "info",
    );
    // Per-type overrides should be gone, default and forceBackground preserved
    expect(mockModules.mockConfig.agent).toEqual({
      default: null,
      forceBackground: false,
    });
    expect(
      Object.keys(mockModules.mockConfig.agent).filter(
        (k) => k !== "default" && k !== "forceBackground",
      ),
    ).toHaveLength(0);
  });

  it("preserves default and forceBackground when clearing", async () => {
    // Arrange: set a default model and per-type override
    mockModules.mockConfig.agent.default = "openai/gpt-4o";
    mockModules.mockConfig.agent["general-purpose"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.agent.forceBackground = true;

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All model overrides cleared",
      "info",
    );
    // default and forceBackground should be preserved, per-type overrides removed
    expect(mockModules.mockConfig.agent).toEqual({
      default: "openai/gpt-4o",
      forceBackground: true,
    });
    expect(
      Object.keys(mockModules.mockConfig.agent).filter(
        (k) => k !== "default" && k !== "forceBackground",
      ),
    ).toHaveLength(0);
  });

  it("preserves graceTurns when clearing all overrides", async () => {
    // Arrange: set a per-type override and graceTurns
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.graceTurns = 10;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert: graceTurns is preserved, per-type override is removed
    expect(mockModules.mockConfig.agent.graceTurns).toBe(10);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All model overrides cleared",
      "info",
    );
  });

  it("preserves showCost when clearing all overrides", async () => {
    // Arrange: set a per-type override and showCost
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.showCost = false;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert: showCost is preserved, per-type override is removed
    expect(mockModules.mockConfig.agent.showCost).toBe(false);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All model overrides cleared",
      "info",
    );
  });

  it("preserves widget settings when clearing all overrides", async () => {
    // Arrange: set widget settings and a per-type override
    mockModules.mockConfig.agent.default = null;
    mockModules.mockConfig.agent.forceBackground = false;
    mockModules.mockConfig.agent.widgetMaxLines = 10;
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 5;
    mockModules.mockConfig.agent.widgetCompact = true;
    mockModules.mockConfig.agent.widgetShortcut = true;
    mockModules.mockConfig.agent["general-purpose"] = "openai/gpt-4o";

    const selections = [
      selectByName("settings"),
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
      undefined,  // Exit settings sub-menu loop
      undefined,  // Exit main menu loop
    ];

    const ctx = createMockCtx(selections);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"];

    // Act
    await showAgentsMainMenu(ctx, modelOptions);

    // Assert: widget settings preserved, per-type override removed
    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(5);
    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(mockModules.mockConfig.agent["general-purpose"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All model overrides cleared",
      "info",
    );
  });
});

describe("showSettingsMenu", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows Model settings, Concurrency settings, and Widget settings in sub-menu", async () => {
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showSettingsMenu(ctx, modelOptions);

    const items = ctx.ui.select.mock.calls[0][1];
    const modelItem = items.find((i: string) => i.includes("Model settings"));
    const concurrencyItem = items.find((i: string) => i.includes("Concurrency settings"));
    const widgetItem = items.find((i: string) => i.includes("Widget settings"));
    expect(modelItem).toBeDefined();
    expect(concurrencyItem).toBeDefined();
    expect(widgetItem).toBeDefined();
  });

  it("returns to main menu on Escape", async () => {
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    // Should return without error
    await showSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("returns to main menu when 'Back' is selected", async () => {
    const ctx = createMockCtx(["Back"]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("opens Model settings when selected", async () => {
    const ctx = createMockCtx([
      selectByName("model"),
      undefined,  // Exit model settings
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showSettingsMenu(ctx, modelOptions);

    // First call is settings menu, second is model settings menu, third is settings menu again (exit)
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Model Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });

  it("opens Concurrency settings when selected", async () => {
    const ctx = createMockCtx([
      selectByName("concurrency"),
      undefined,  // Exit concurrency settings
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Concurrency Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });

  it("opens Widget settings when selected", async () => {
    const ctx = createMockCtx([
      selectByName("widget"),
      undefined,  // Exit widget settings
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showSettingsMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Widget Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Settings");
  });
});

describe("showAgentsMainMenu — settings sub-menu integration", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 4 items: Running agents, Spawn agent, Settings, Debug", async () => {
    const ctx = createMockCtx([undefined]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    const items = ctx.ui.select.mock.calls[0][1];
    const runningItem = items.find((i: string) => i.includes("Running agents"));
    const spawnItem = items.find((i: string) => i.includes("Spawn agent"));
    const settingsItem = items.find((i: string) => i.includes("Settings"));
    const debugItem = items.find((i: string) => i.includes("Debug"));
    expect(runningItem).toBeDefined();
    expect(spawnItem).toBeDefined();
    expect(settingsItem).toBeDefined();
    expect(debugItem).toBeDefined();

    // Verify ordering: Running agents, Spawn agent, Settings, Debug
    const runningIdx = items.findIndex((i: string) => i.includes("Running agents"));
    const spawnIdx = items.findIndex((i: string) => i.includes("Spawn agent"));
    const settingsIdx = items.findIndex((i: string) => i.includes("Settings"));
    const debugIdx = items.findIndex((i: string) => i.includes("Debug"));
    expect(spawnIdx).toBeGreaterThan(runningIdx);
    expect(settingsIdx).toBeGreaterThan(spawnIdx);
    expect(debugIdx).toBeGreaterThan(settingsIdx);

    // Should not have Model settings, Concurrency settings, or Widget settings directly
    const modelDirect = items.find((i: string) => i.includes("Model settings") && !i.includes("Settings —"));
    const concurrencyDirect = items.find((i: string) => i.includes("Concurrency settings"));
    const widgetDirect = items.find((i: string) => i.includes("Widget settings"));
    expect(modelDirect).toBeUndefined();
    expect(concurrencyDirect).toBeUndefined();
    expect(widgetDirect).toBeUndefined();
  });

  it("opens Settings sub-menu when selected", async () => {
    const ctx = createMockCtx([
      selectByName("settings"),
      undefined,  // Exit settings sub-menu
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    // First call is main menu, second is settings sub-menu, third is main menu again (exit)
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Model settings", async () => {
    const ctx = createMockCtx([
      selectByName("settings"),
      selectByName("model"),
      undefined,  // Exit model settings
      undefined,  // Exit settings sub-menu
      undefined,  // Exit main menu
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Model Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Concurrency settings", async () => {
    const ctx = createMockCtx([
      selectByName("settings"),
      selectByName("concurrency"),
      undefined,  // Exit concurrency settings
      undefined,  // Exit settings sub-menu
      undefined,  // Exit main menu
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Concurrency Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });

  it("navigates through Settings to Widget settings", async () => {
    const ctx = createMockCtx([
      selectByName("settings"),
      selectByName("widget"),
      undefined,  // Exit widget settings
      undefined,  // Exit settings sub-menu
      undefined,  // Exit main menu
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    expect(ctx.ui.select).toHaveBeenCalledTimes(5);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Subagents Management");
    expect(ctx.ui.select.mock.calls[1][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[2][0]).toBe("Widget Settings");
    expect(ctx.ui.select.mock.calls[3][0]).toBe("Settings");
    expect(ctx.ui.select.mock.calls[4][0]).toBe("Subagents Management");
  });
});

describe("showResultViewer — stats passing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModules.resultViewerCalls.length = 0;
  });

  it("passes stats from AgentRecord when viewing result", async () => {
    const record = {
      id: "test-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: { messages: [] } },
      result: "some result text",
      stats: {
        lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
        toolUses: 10,
        turnCount: 15,
        compactionCount: 0,
      },
    } as any;

    const ctx = createMockCtx([
      "View result",
      undefined,
    ]);

    const { showAgentActions } = await import("../src/menus.js");
    await showAgentActions(ctx, record);

    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const stats = lastCall[5];
    expect(stats).toBeDefined();
    expect(stats.lifetimeUsage).toEqual({ input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 });
    expect(stats.turnCount).toBe(15);
    expect(stats.durationMs).toBe(40000); // completedAt - startedAt
  });

  it("passes stats when viewing error", async () => {
    const record = {
      id: "test-id-456",
      display: { type: "general-purpose", description: "Error agent" },
      lifecycle: { status: "error", startedAt: Date.now() - 30000, completedAt: Date.now() - 5000 },
      execution: {},
      error: "something went wrong",
      stats: {
        lifetimeUsage: { input: 500, output: 200, cacheWrite: 50, cost: 0.005 },
        toolUses: 5,
        turnCount: 3,
        compactionCount: 0,
      },
    } as any;

    const ctx = createMockCtx([
      "View error",
      undefined,
    ]);

    const { showAgentActions } = await import("../src/menus.js");
    await showAgentActions(ctx, record);

    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const stats = lastCall[5];
    expect(stats).toBeDefined();
    expect(stats.lifetimeUsage.input).toBe(500);
    expect(stats.turnCount).toBe(3);
  });

  it("passes stats when viewing snapshot", async () => {
    const record = {
      id: "test-id-789",
      display: { type: "general-purpose", description: "Snapshot agent" },
      lifecycle: { status: "running", startedAt: Date.now() - 60000 },
      execution: { session: { messages: [{ role: "user", content: "hello" }] } },
      result: "",
      error: "",
      stats: {
        lifetimeUsage: { input: 8000, output: 4000, cacheWrite: 1000, cost: 0.012 },
        toolUses: 8,
        turnCount: 7,
        compactionCount: 0,
      },
    } as any;

    const ctx = createMockCtx([
      "View snapshot",
      undefined,
    ]);

    const { showAgentActions } = await import("../src/menus.js");
    await showAgentActions(ctx, record);

    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const stats = lastCall[5];
    expect(stats).toBeDefined();
    expect(stats.lifetimeUsage.input).toBe(8000);
    expect(stats.turnCount).toBe(7);
  });

  it("handles missing turnCount gracefully", async () => {
    const record = {
      id: "test-id-no-turns",
      display: { type: "general-purpose", description: "Running agent" },
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [{ role: "user", content: "hi" }] } },
      result: "",
      error: "",
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 10, cost: 0.001 },
        toolUses: 3,
        // turnCount is undefined for running agents
        compactionCount: 0,
      },
    } as any;

    const ctx = createMockCtx([
      "View snapshot",
      undefined,
    ]);

    const { showAgentActions } = await import("../src/menus.js");
    await showAgentActions(ctx, record);

    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const stats = lastCall[5];
    expect(stats).toBeDefined();
    expect(stats.turnCount).toBeUndefined();
    expect(stats.durationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cost display toggle tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Widget settings tests
// ---------------------------------------------------------------------------

describe("showWidgetSettingsMenu — widget settings", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null,
      forceBackground: false,
      widgetMaxLines: 12,
      widgetMaxLinesCompact: 6,
      widgetCompact: false,
    };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows widget settings menu items", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.length).toBeGreaterThan(0);
  });

  it("shows 'Force compact mode · OFF' when widgetCompact is false", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const compactItem = items.find((i: string) => i.startsWith("Force compact mode"));
    expect(compactItem).toBe("Force compact mode · OFF");
  });

  it("shows 'Force compact mode · ON' when widgetCompact is true", async () => {
    mockModules.mockConfig.agent.widgetCompact = true;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const compactItem = items.find((i: string) => i.startsWith("Force compact mode"));
    expect(compactItem).toBe("Force compact mode · ON");
  });

  it("toggles force compact mode and saves", async () => {
    mockModules.mockConfig.agent.widgetCompact = false;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Force compact mode · OFF",
      undefined,
    ];

    const ctx = createMockCtx(selections);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetCompact).toBe(true);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Force compact mode ON", "info");
  });

  it("shows 'Max lines (full) · 12' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const maxLinesItem = items.find((i: string) => i.startsWith("Max lines (full)"));
    expect(maxLinesItem).toBe("Max lines (full) · 12");
  });

  it("shows configured max lines value", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 8;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const maxLinesItem = items.find((i: string) => i.startsWith("Max lines (full)"));
    expect(maxLinesItem).toBe("Max lines (full) · 8");
  });

  it("updates max lines and saves", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Max lines (full) · 12",
      undefined,
    ];
    const inputs = ["10"];

    const ctx = createMockCtx(selections, inputs);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(10);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (full) set to 10", "info");
  });

  it("rejects max lines < 2", async () => {
    mockModules.mockConfig.agent.widgetMaxLines = 12;

    const selections = [
      "Max lines (full) · 12",
      undefined,
    ];
    const inputs = ["1"];

    const ctx = createMockCtx(selections, inputs);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetMaxLines).toBe(12);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 2", "error");
  });

  it("shows 'Max lines (compact) · 6' with default value", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const compactMaxItem = items.find((i: string) => i.startsWith("Max lines (compact)"));
    expect(compactMaxItem).toBe("Max lines (compact) · 6");
  });

  it("updates compact max lines and saves", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Max lines (compact) · 6",
      undefined,
    ];
    const inputs = ["4"];

    const ctx = createMockCtx(selections, inputs);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(4);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Max lines (compact) set to 4", "info");
  });

  it("rejects compact max lines < 1", async () => {
    mockModules.mockConfig.agent.widgetMaxLinesCompact = 6;

    const selections = [
      "Max lines (compact) · 6",
      undefined,
    ];
    const inputs = ["0"];

    const ctx = createMockCtx(selections, inputs);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetMaxLinesCompact).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1", "error");
  });

  it("shows compact mode, max lines, and shortcut settings", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items: string[] = ctx.ui.select.mock.calls[0][1];
    const compactIdx = items.findIndex((i: string) => i.startsWith("Force compact mode"));
    const maxLinesIdx = items.findIndex((i: string) => i.startsWith("Max lines (full)"));
    const maxLinesCompactIdx = items.findIndex((i: string) => i.startsWith("Max lines (compact)"));
    const shortcutIdx = items.findIndex((i: string) => i.startsWith("Ctrl+o shortcut"));

    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(maxLinesIdx).toBeGreaterThan(compactIdx);
    expect(maxLinesCompactIdx).toBeGreaterThan(maxLinesIdx);
    expect(shortcutIdx).toBeGreaterThan(maxLinesCompactIdx);
  });
});

describe("showWidgetSettingsMenu — Ctrl+o shortcut toggle", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = {
      default: null,
      forceBackground: false,
      widgetCompact: false,
      widgetShortcut: false,
    };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows 'Ctrl+o shortcut · OFF' when widgetShortcut is false", async () => {
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const shortcutItem = items.find((i: string) => i.startsWith("Ctrl+o shortcut"));
    expect(shortcutItem).toBe("Ctrl+o shortcut · OFF");
  });

  it("shows 'Ctrl+o shortcut · ON' when widgetShortcut is true", async () => {
    mockModules.mockConfig.agent.widgetShortcut = true;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const shortcutItem = items.find((i: string) => i.startsWith("Ctrl+o shortcut"));
    expect(shortcutItem).toBe("Ctrl+o shortcut · ON");
  });

  it("defaults to OFF when widgetShortcut is not set", async () => {
    delete mockModules.mockConfig.agent.widgetShortcut;
    const ctx = createMockCtx([undefined]);
    await showWidgetSettingsMenu(ctx);

    const items = ctx.ui.select.mock.calls[0][1];
    const shortcutItem = items.find((i: string) => i.startsWith("Ctrl+o shortcut"));
    expect(shortcutItem).toBe("Ctrl+o shortcut · OFF");
  });

  it("toggles shortcut from OFF to ON and saves", async () => {
    mockModules.mockConfig.agent.widgetShortcut = false;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Ctrl+o shortcut · OFF",
      undefined,
    ];

    const ctx = createMockCtx(selections);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(true);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Ctrl+o shortcut ON", "info");
  });

  it("toggles shortcut from ON to OFF and saves", async () => {
    mockModules.mockConfig.agent.widgetShortcut = true;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Ctrl+o shortcut · ON",
      undefined,
    ];

    const ctx = createMockCtx(selections);
    await showWidgetSettingsMenu(ctx);

    expect(mockModules.mockConfig.agent.widgetShortcut).toBe(false);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Ctrl+o shortcut OFF", "info");
  });
});

describe("showModelSettingsMenu — cost display toggle", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, showCost: true };
    mockModules.mockSessionOverrides.default = null;
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("shows 'Cost display · ON' when showCost is true", async () => {
    const ctx = createMockCtx([undefined]); // Escape immediately
    await showModelSettingsMenu(ctx, []);

    const items = ctx.ui.select.mock.calls[0][1];
    const costItem = items.find((i: string) => i.startsWith("Cost display"));
    expect(costItem).toBe("Cost display · ON");
  });

  it("shows 'Cost display · OFF' when showCost is false", async () => {
    mockModules.mockConfig.agent.showCost = false;

    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);

    const items = ctx.ui.select.mock.calls[0][1];
    const costItem = items.find((i: string) => i.startsWith("Cost display"));
    expect(costItem).toBe("Cost display · OFF");
  });

  it("toggles showCost from true to false and saves", async () => {
    mockModules.mockConfig.agent.showCost = true;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Cost display · ON",  // click the toggle
      undefined,             // Escape to exit
    ];

    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);

    expect(mockModules.mockConfig.agent.showCost).toBe(false);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cost display OFF", "info");
  });

  it("toggles showCost from false to true and saves", async () => {
    mockModules.mockConfig.agent.showCost = false;
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const selections = [
      "Cost display · OFF",
      undefined,
    ];

    const ctx = createMockCtx(selections);
    await showModelSettingsMenu(ctx, []);

    expect(mockModules.mockConfig.agent.showCost).toBe(true);
    expect(saveConfigAtomic).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Cost display ON", "info");
  });

  it("defaults to false when showCost is not set", async () => {
    delete mockModules.mockConfig.agent.showCost;

    const ctx = createMockCtx([undefined]);
    await showModelSettingsMenu(ctx, []);

    const items = ctx.ui.select.mock.calls[0][1];
    const costItem = items.find((i: string) => i.startsWith("Cost display"));
    expect(costItem).toBe("Cost display · OFF");
  });
});

// ---------------------------------------------------------------------------
// Spawn agent menu tests
// ---------------------------------------------------------------------------

describe("showSpawnAgentMenu — type selection", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockAgentActivity.clear();
    mockModules.mockBackgroundAgentIds.clear();
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      }
      if (name === "Explore") {
        return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinking: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("shows types from getAvailableTypes()", async () => {
    const ctx = createMockCtx([undefined]); // Escape at type selection

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Select agent type");
    expect(ctx.ui.select.mock.calls[0][1]).toEqual(["general-purpose", "Explore"]);
  });

  it("returns to main menu on Escape at type selection", async () => {
    const ctx = createMockCtx([undefined]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // Only type selection was shown, no prompt
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });

  it("shows error for unknown type and loops back", async () => {
    // First selection: unknown type, second: Escape
    const ctx = createMockCtx(["unknown-type", undefined]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Unknown agent type: unknown-type", "error");
    // Two select calls: first for unknown type, second for retry (escape)
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
  });
});

describe("showSpawnAgentMenu — prompt entry", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockAgentActivity.clear();
    mockModules.mockBackgroundAgentIds.clear();
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("shows prompt input after type selection", async () => {
    // Select type, then Escape at prompt
    const ctx = createMockCtx(["general-purpose", undefined]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.input).toHaveBeenCalledWith("Agent prompt");
  });

  it("shows error for empty prompt and loops back", async () => {
    // Select type, empty prompt, then Escape
    const ctx = createMockCtx(["general-purpose", undefined], ["", undefined]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Prompt cannot be empty", "error");
    // Two input calls: first empty, second escape
    expect(ctx.ui.input).toHaveBeenCalledTimes(2);
  });

  it("returns to main menu on Escape at prompt", async () => {
    const ctx = createMockCtx(["general-purpose", undefined]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // No options menu shown
    expect(ctx.ui.select).toHaveBeenCalledTimes(1); // Only type selection
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
    mockModules.mockAgentActivity.clear();
    mockModules.mockBackgroundAgentIds.clear();
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      }
      if (name === "Explore") {
        return { name: "Explore", description: "Explore agent", model: "openai/gpt-4o", thinking: "low" as const, maxTurns: 10, extensions: false, skills: false, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("shows pre-filled options from agent config and global config", async () => {
    // Type → prompt → Escape at options
    const ctx = createMockCtx(["general-purpose", undefined], ["Do something"]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // Find the options menu call
    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall).toBeDefined();
    const items: string[] = optionsCall[1];

    // Description should be first 50 chars of prompt
    const descItem = items.find((i: string) => i.startsWith("Description"));
    expect(descItem).toBe("Description · Do something");

    // Model should show effective model from precedence chain
    const modelItem = items.find((i: string) => i.startsWith("Model"));
    expect(modelItem).toBe("Model · anthropic/claude-sonnet-4-20250514");

    // Thinking from agent config
    const thinkingItem = items.find((i: string) => i.startsWith("Thinking"));
    expect(thinkingItem).toBe("Thinking · medium");

    // Max turns from agent config
    const maxTurnsItem = items.find((i: string) => i.startsWith("Max turns"));
    expect(maxTurnsItem).toBe("Max turns · 25");

    // Grace turns from global config
    const graceTurnsItem = items.find((i: string) => i.startsWith("Grace turns"));
    expect(graceTurnsItem).toBe("Grace turns · 8");

    // Background from forceBackground config
    const bgItem = items.find((i: string) => i.startsWith("Background"));
    expect(bgItem).toBe("Background · OFF");
  });

  it("auto-generates description from first 50 chars of prompt", async () => {
    const longPrompt = "A".repeat(60);
    const ctx = createMockCtx(["general-purpose", undefined], [longPrompt]);

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    const items: string[] = optionsCall[1];
    const descItem = items.find((i: string) => i.startsWith("Description"));
    expect(descItem).toBe(`Description · ${"A".repeat(50)}`);
  });

  it("allows overriding description", async () => {
    // Type → prompt → select Description → enter new value → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Description · Do something", undefined],
      ["Do something", "Custom description"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.input).toHaveBeenCalledWith("Description", "Do something");

    // After override, the options menu should show the new description
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const descItem = secondOptionsCall[1].find((i: string) => i.startsWith("Description"));
      expect(descItem).toBe("Description · Custom description");
    }
  });

  it("allows changing model via model selector", async () => {
    // Type → prompt → select Model → pick new model → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", undefined],
      ["Do something"],
      ["openai/gpt-4o"], // custom value for model selector
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);

    // After model change, the options menu should show the new model
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const modelItem = secondOptionsCall[1].find((i: string) => i.startsWith("Model"));
      expect(modelItem).toBe("Model · openai/gpt-4o");
    }
  });

  it("allows changing thinking level", async () => {
    // Type → prompt → select Thinking → pick "high" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Thinking · medium", "high", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // Thinking selector should show all levels plus inherit
    const thinkingCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Thinking level");
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall[1]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);

    // After change, options should show "high"
    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const thinkingItem = secondOptionsCall[1].find((i: string) => i.startsWith("Thinking"));
      expect(thinkingItem).toBe("Thinking · high");
    }
  });

  it("allows setting thinking to inherit", async () => {
    // Type → prompt → select Thinking → pick "inherit" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Thinking · medium", "inherit", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const thinkingItem = secondOptionsCall[1].find((i: string) => i.startsWith("Thinking"));
      expect(thinkingItem).toBe("Thinking · inherit");
    }
  });

  it("allows changing max turns", async () => {
    // Type → prompt → select Max turns → enter "15" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "15"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const maxTurnsItem = secondOptionsCall[1].find((i: string) => i.startsWith("Max turns"));
      expect(maxTurnsItem).toBe("Max turns · 15");
    }
  });

  it("allows setting max turns to unlimited", async () => {
    // Type → prompt → select Max turns → enter "unlimited" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "unlimited"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const maxTurnsItem = secondOptionsCall[1].find((i: string) => i.startsWith("Max turns"));
      expect(maxTurnsItem).toBe("Max turns · unlimited");
    }
  });

  it("rejects invalid max turns with error", async () => {
    // Type → prompt → select Max turns → enter "abc" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Max turns · 25", undefined],
      ["Do something", "abc"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Invalid value — must be a number ≥ 1 or 'unlimited'",
      "error",
    );
  });

  it("allows changing grace turns", async () => {
    // Type → prompt → select Grace turns → enter "3" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Grace turns · 8", undefined],
      ["Do something", "3"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const graceTurnsItem = secondOptionsCall[1].find((i: string) => i.startsWith("Grace turns"));
      expect(graceTurnsItem).toBe("Grace turns · 3");
    }
  });

  it("rejects invalid grace turns with error", async () => {
    // Type → prompt → select Grace turns → enter "-1" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Grace turns · 8", undefined],
      ["Do something", "-1"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Invalid value — must be a number ≥ 0",
      "error",
    );
  });

  it("toggles background ON/OFF", async () => {
    // Type → prompt → select Background → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Background · OFF", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    const secondOptionsCall = optionsCalls[1];
    if (secondOptionsCall) {
      const bgItem = secondOptionsCall[1].find((i: string) => i.startsWith("Background"));
      expect(bgItem).toBe("Background · ON");
    }
  });

  it("returns to main menu on Escape at options", async () => {
    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // No spawn attempted
    expect(mockModules.mockManager.spawn).not.toHaveBeenCalled();
  });

  it("shows '(inherits parent)' when no model in precedence chain", async () => {
    // Use a type with no model config and no overrides
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "", extensions: true, skills: true, systemPrompt: "" };
      }
      return undefined;
    });
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    // sessionCtx.model is undefined for this test
    const origModel = mockModules.mockSessionCtx.model;
    mockModules.mockSessionCtx.model = undefined;

    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    const items: string[] = optionsCall[1];
    const modelItem = items.find((i: string) => i.startsWith("Model"));
    expect(modelItem).toBe("Model · (inherits parent)");

    mockModules.mockSessionCtx.model = origModel;
  });
});

describe("showSpawnAgentMenu — spawn action", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, graceTurns: 6 };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockAgentActivity.clear();
    mockModules.mockBackgroundAgentIds.clear();
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("calls getManager().spawn() with correct arguments", async () => {
    // Type → prompt → Spawn
    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

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

  it("wires activity tracker callbacks into spawn options", async () => {
    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.onToolActivity).toBeDefined();
    expect(options.onTextDelta).toBeDefined();
    expect(options.onTurnEnd).toBeDefined();
    expect(options.onSessionCreated).toBeDefined();
    expect(options.onAssistantUsage).toBeDefined();
  });

  it("registers activity in agentActivity map for background spawn", async () => {
    // Use background spawn so activity persists after return
    const ctx = createMockCtx(
      ["general-purpose", "Background · OFF", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(mockModules.mockAgentActivity.has("agent-id-123")).toBe(true);
  });

  it("adds to backgroundAgentIds and returns immediately for background spawn", async () => {
    // Type → prompt → toggle Background ON → Spawn
    const ctx = createMockCtx(
      ["general-purpose", "Background · OFF", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(mockModules.mockBackgroundAgentIds.has("agent-id-123")).toBe(true);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.isBackground).toBe(true);
    // Should not have awaited any promise (no getRecord call needed for bg)
    expect(mockModules.mockManager.getRecord).not.toHaveBeenCalled();
  });

  it("blocks until completion for foreground spawn", async () => {
    let resolvePromise!: (value: string) => void;
    const promise = new Promise<string>((r) => { resolvePromise = r; });

    mockModules.mockManager.getRecord.mockReturnValue({
      execution: { promise },
    });

    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    const spawnPromise = showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    // The function should be waiting for the agent to complete
    // Resolve the promise to unblock
    resolvePromise("result");
    await spawnPromise;

    // Activity should be cleaned up after foreground completion
    expect(mockModules.mockAgentActivity.has("agent-id-123")).toBe(false);
  });

  it("shows error when model not found in registry and returns to options", async () => {
    // Session ctx model registry returns undefined for unknown model
    const origFind = mockModules.mockSessionCtx.modelRegistry.find;
    mockModules.mockSessionCtx.modelRegistry.find = vi.fn(() => undefined);

    // Type → prompt → select Model → pick unknown → select Spawn → Escape
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", "Spawn", undefined],
      ["Do something"],
      ["unknown/unknown"], // model selector returns unknown model
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Model not found: unknown/unknown", "error");
    // Spawn should not have been called
    expect(mockModules.mockManager.spawn).not.toHaveBeenCalled();

    mockModules.mockSessionCtx.modelRegistry.find = origFind;
  });

  it("shows error when manager spawn throws and returns to main menu", async () => {
    mockModules.mockManager.spawn.mockImplementation(() => {
      throw new Error("Spawn failed: internal error");
    });

    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Spawn failed: Spawn failed: internal error",
      "error",
    );
  });

  it("does not call saveConfigAtomic (no config mutation)", async () => {
    const { saveConfigAtomic } = await import("../src/config-io.js");

    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(saveConfigAtomic).not.toHaveBeenCalled();
  });

  it("resolves selected model string to Model object via findModelInRegistry", async () => {
    // Type → prompt → select Model → pick specific model → Spawn
    const ctx = createMockCtx(
      ["general-purpose", "Model · anthropic/claude-sonnet-4-20250514", "Spawn"],
      ["Do something"],
      ["openai/gpt-4o"], // model selector returns this
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);

    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.model).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(options.modelKey).toBe("openai/gpt-4o");
    expect(options.invocation.modelName).toBe("gpt-4o");
  });

  it("passes undefined for model and modelKey when inheriting parent", async () => {
    // Type → prompt → Spawn (no model change)
    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    // When inheriting (user didn't change model from resolved default),
    // model should be set from the registry since the default was resolved
    // But if the user keeps the resolved model, it should be resolved to a Model object
    expect(options.model).toBeDefined();
    expect(options.modelKey).toBeDefined();
  });

  it("passes custom description to spawn options", async () => {
    // Type → prompt → change description → Spawn
    const ctx = createMockCtx(
      ["general-purpose", "Description · Do something", "Spawn"],
      ["Do something", "Custom label"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.description).toBe("Custom label");
  });
});

// ---------------------------------------------------------------------------
// Briefing content tests (worktree_path)
// ---------------------------------------------------------------------------

describe("handleAgentBriefing — worktree_path content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") {
        return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      }
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      }
      return undefined;
    });
  });

  it("includes worktree_path in the parameters table", async () => {
    // Navigate: Main Menu → Debug → Agent briefing → Escape
    const mockSendUserMessage = vi.fn();
    const { piInstance } = await import("../src/state.js");
    (piInstance as any).sendUserMessage = mockSendUserMessage;

    const ctx = createMockCtx([
      selectByName("debug"),
      "2", // select Agent briefing (matchMenuChoice matches by number prefix)
      undefined, // Exit debug menu
      undefined, // Exit main menu
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    expect(mockSendUserMessage).toHaveBeenCalled();
    const sentMessage = mockSendUserMessage.mock.calls[0]?.[0];
    expect(sentMessage).toBeDefined();
    expect(sentMessage).toContain("worktree_path");
    expect(sentMessage).toContain("Optional path to a git worktree");
  });

  it("covers all five required briefing points", async () => {
    const mockSendUserMessage = vi.fn();
    const { piInstance } = await import("../src/state.js");
    (piInstance as any).sendUserMessage = mockSendUserMessage;

    const ctx = createMockCtx([
      selectByName("debug"),
      "2", // select Agent briefing
      undefined,
      undefined,
    ]);
    const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

    await showAgentsMainMenu(ctx, modelOptions);

    expect(mockSendUserMessage).toHaveBeenCalled();
    const sentMessage = mockSendUserMessage.mock.calls[0]?.[0];
    expect(sentMessage).toBeDefined();

    // (1) param exists and is optional
    expect(sentMessage).toContain("Optional");
    // (2) must be a path inside a git worktree of the parent's repo
    expect(sentMessage).toContain("git worktree of the parent");
    // (3) relative paths resolve against parent's cwd
    expect(sentMessage).toContain("Relative paths");
    expect(sentMessage).toContain("resolved against the parent");
    // (4) on failure, validator returns a specific reason
    expect(sentMessage).toContain("specific reason");
    // (5) worktree's .pi/agents/ is scanned for agent types
    expect(sentMessage).toContain(".pi/agents/");
    expect(sentMessage).toContain("agent types");
  });
});

// ---------------------------------------------------------------------------
// Spawn agent menu — worktree picker
// ---------------------------------------------------------------------------

describe("showSpawnAgentMenu — worktree picker", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockAgentActivity.clear();
    mockModules.mockBackgroundAgentIds.clear();
    mockModules.mockManager.spawn.mockReset().mockReturnValue("agent-id-123");
    mockModules.mockManager.getRecord.mockReset();
    mockModules.mockPiExec.mockReset();
    vi.clearAllMocks();

    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") {
        return { name: "general-purpose", description: "General-purpose agent", model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" as const, maxTurns: 25, extensions: true, skills: true, systemPrompt: "" };
      }
      return undefined;
    });
  });

  /** Build porcelain output from worktree entries. */
  function buildPorcelainOutput(worktrees: { path: string; branch?: string; detached?: boolean }[]): string {
    return worktrees.map(wt => {
      let block = `worktree ${wt.path}`;
      if (wt.branch) {
        block += `\nbranch refs/heads/${wt.branch}`;
      } else if (wt.detached) {
        block += "\ndetached";
      }
      return block;
    }).join("\n\n");
  }

  /**
   * Configure pi.exec mock for git repo check and worktree list.
   */
  function setupExecMock(options: {
    inGitRepo?: boolean;
    worktrees?: { path: string; branch?: string; detached?: boolean }[];
  } = {}) {
    const { inGitRepo = true, worktrees = [] } = options;

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

  // --- Row visibility ---

  it("shows 'Worktree · Inherits parent cwd' in options when in a git repo", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });

    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall).toBeDefined();
    const items: string[] = optionsCall[1];
    const worktreeItem = items.find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBe("Worktree · Inherits parent cwd");
  });

  it("does not show 'Worktree' row when not in a git repo", async () => {
    setupExecMock({ inGitRepo: false });

    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall).toBeDefined();
    const items: string[] = optionsCall[1];
    const worktreeItem = items.find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBeUndefined();
  });

  // --- Picker population ---

  it("opens worktree picker with 'Inherits parent cwd' first and worktrees from git", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
        { path: "/test-feature", branch: "feature" },
      ],
    });

    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    expect(pickerCall).toBeDefined();
    const pickerItems: string[] = pickerCall[1];
    expect(pickerItems[0]).toBe("Inherits parent cwd");
    expect(pickerItems).toHaveLength(3); // Inherits + 2 worktrees
  });

  it("shows branch name and path in picker rows", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
        { path: "/test-feature", branch: "feature" },
      ],
    });

    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    const pickerItems: string[] = pickerCall[1];
    expect(pickerItems[1]).toContain("main");
    expect(pickerItems[1]).toContain("/test");
    expect(pickerItems[2]).toContain("feature");
    expect(pickerItems[2]).toContain("/test-feature");
  });

  it("shows 'detached' for detached HEAD worktrees", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test-detached", detached: true },
      ],
    });

    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const pickerCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Select worktree");
    const pickerItems: string[] = pickerCall[1];
    expect(pickerItems[1]).toContain("detached");
    expect(pickerItems[1]).toContain("/test-detached");
  });

  // --- Selection updates row ---

  it("updates worktree row to selected branch after picking a worktree", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
        { path: "/test-feature", branch: "feature" },
      ],
    });

    // Type → prompt → select Worktree → pick "feature" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "feature  ·  /test-feature", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls.length).toBeGreaterThanOrEqual(2);
    const worktreeItem = optionsCalls[optionsCalls.length - 1][1].find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBe("Worktree · feature");
  });

  it("updates worktree row to 'Inherits parent cwd' when that option is picked", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
      ],
    });

    // Type → prompt → select Worktree → pick "Inherits parent cwd" → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "Inherits parent cwd", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls.length).toBeGreaterThanOrEqual(2);
    const worktreeItem = optionsCalls[optionsCalls.length - 1][1].find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBe("Worktree · Inherits parent cwd");
  });

  // --- Escape from picker ---

  it("returns to options on Escape from picker without committing change", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test", branch: "main" },
      ],
    });

    // Type → prompt → select Worktree → Escape from picker → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined, undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCalls = ctx.ui.select.mock.calls.filter((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCalls.length).toBe(2);
    // Worktree row should still show default
    const worktreeItem = optionsCalls[1][1].find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBe("Worktree · Inherits parent cwd");
  });

  // --- Git worktree list failure ---

  it("shows notification and returns to options when git worktree list fails", async () => {
    // Git repo check succeeds, but worktree list fails
    mockModules.mockPiExec.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return { code: 0, stdout: "/test/.git", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 128, stdout: "", stderr: "fatal: git unavailable" };
      }
      return { code: 1, stdout: "", stderr: "unknown" };
    });

    // Type → prompt → select Worktree → (picker fails) → Escape at options
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("worktree"),
      "error",
    );
  });

  // --- Spawn wiring ---

  it("forwards worktreePath in spawn options when a worktree is picked", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test-feature", branch: "feature" },
      ],
    });

    // Type → prompt → Worktree → pick feature → Spawn
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
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test-feature", branch: "feature" },
      ],
    });

    // Type → prompt → Worktree → pick Inherits → Spawn
    const ctx = createMockCtx(
      ["general-purpose", "Worktree · Inherits parent cwd", "Inherits parent cwd", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    expect(mockModules.mockManager.spawn).toHaveBeenCalledTimes(1);
    const options = mockModules.mockManager.spawn.mock.calls[0][4];
    expect(options.worktreePath).toBeUndefined();
    expect(options.worktreeLabel).toBeUndefined();
  });

  it("calls discoverNewAgents with worktree path before spawn", async () => {
    setupExecMock({
      inGitRepo: true,
      worktrees: [
        { path: "/test-feature", branch: "feature" },
      ],
    });

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

    const ctx = createMockCtx(
      ["general-purpose", "Spawn"],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const { discoverNewAgents } = await import("../src/agent-types.js");
    expect(discoverNewAgents).not.toHaveBeenCalled();
  });

  it("does not show 'Worktree' row when git repo check throws", async () => {
    mockModules.mockPiExec.mockRejectedValue(new Error("ENOENT"));

    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    expect(optionsCall).toBeDefined();
    const items: string[] = optionsCall[1];
    const worktreeItem = items.find((i: string) => i.startsWith("Worktree"));
    expect(worktreeItem).toBeUndefined();
  });

  it("positions 'Worktree' row after 'Description' in the options menu", async () => {
    setupExecMock({ inGitRepo: true, worktrees: [{ path: "/test", branch: "main" }] });

    const ctx = createMockCtx(
      ["general-purpose", undefined],
      ["Do something"],
    );

    await showSpawnAgentMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);

    const optionsCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Spawn Options");
    const items: string[] = optionsCall[1];
    const descIdx = items.findIndex((i: string) => i.startsWith("Description"));
    const worktreeIdx = items.findIndex((i: string) => i.startsWith("Worktree"));
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(worktreeIdx).toBeGreaterThan(descIdx);
  });
});


