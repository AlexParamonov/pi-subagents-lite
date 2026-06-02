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
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
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

// Mock state.ts with a mutable config object
vi.mock("../src/state.js", () => {
  return {
    __config: mockModules.mockConfig,
    sessionOverrides: mockModules.mockSessionOverrides,
    getManager: () => ({
      setConcurrency: vi.fn(),
      listAgents: vi.fn(() => []),
      getRecord: vi.fn(),
      abort: vi.fn(),
      steer: vi.fn(),
    }),
    getWidget: vi.fn(() => undefined),
    piInstance: { sendUserMessage: vi.fn() },
    setShowCostEnabled: vi.fn((enabled: boolean) => {
      mockModules.mockConfig.agent.showCost = enabled;
    }),
    syncWidgetSettings: vi.fn(),
  };
});

// --- Import module under test ---
import { showConcurrencySettingsMenu, showModelSettingsMenu, showWidgetSettingsMenu, showAgentsMainMenu } from "../src/menus.js";
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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
      selectByName("model"),
      "Clear all overrides",
      undefined,  // Exit model settings loop
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

describe("showResultViewer — stats passing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModules.resultViewerCalls.length = 0;
  });

  it("passes stats from AgentRecord when viewing result", async () => {
    const record = {
      id: "test-id-123",
      type: "general-purpose",
      description: "Test agent",
      status: "completed",
      result: "some result text",
      toolUses: 10,
      startedAt: Date.now() - 50000,
      completedAt: Date.now() - 10000,
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      turnCount: 15,
      session: { messages: [] },
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
      type: "general-purpose",
      description: "Error agent",
      status: "error",
      error: "something went wrong",
      toolUses: 5,
      startedAt: Date.now() - 30000,
      completedAt: Date.now() - 5000,
      lifetimeUsage: { input: 500, output: 200, cacheWrite: 50, cost: 0.005 },
      turnCount: 3,
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
      type: "general-purpose",
      description: "Snapshot agent",
      status: "running",
      result: "",
      error: "",
      toolUses: 8,
      startedAt: Date.now() - 60000,
      lifetimeUsage: { input: 8000, output: 4000, cacheWrite: 1000, cost: 0.012 },
      turnCount: 7,
      session: { messages: [{ role: "user", content: "hello" }] },
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
      type: "general-purpose",
      description: "Running agent",
      status: "running",
      result: "",
      error: "",
      toolUses: 3,
      startedAt: Date.now() - 20000,
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 10, cost: 0.001 },
      // turnCount is undefined for running agents
      session: { messages: [{ role: "user", content: "hi" }] },
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


