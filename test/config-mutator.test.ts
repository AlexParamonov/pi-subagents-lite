/**
 * config-mutator.test.ts — Unit tests for config-mutator.ts setters.
 *
 * Each setter must:
 *   1. Mutate __config correctly
 *   2. Call saveConfigAtomic
 *   3. Call syncWidgetSettings where needed
 *   4. Call applyConcurrencyConfig (save + getManager().setConcurrency) for concurrency setters
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock modules ---

const { mockConfig, mockSaveConfigAtomic, mockSyncWidgetSettings, mockSetShowCostEnabled, mockSetConcurrency } = vi.hoisted(() => {
  const mockSaveConfigAtomic = vi.fn();
  const mockSyncWidgetSettings = vi.fn();
  const mockSetShowCostEnabled = vi.fn();
  const mockSetConcurrency = vi.fn();
  const mockConfig: any = {
    agent: {
      default: null,
      forceBackground: false,
      graceTurns: 6,
      widgetMaxLines: 12,
      widgetCompact: false,
      widgetShortcut: false,
    },
    concurrency: { default: 4 },
  };
  return { mockConfig, mockSaveConfigAtomic, mockSyncWidgetSettings, mockSetShowCostEnabled, mockSetConcurrency };
});

vi.mock("../src/state.js", () => ({
  __config: mockConfig,
  getManager: () => ({ setConcurrency: mockSetConcurrency }),
  setShowCostEnabled: mockSetShowCostEnabled,
  syncWidgetSettings: mockSyncWidgetSettings,
}));

vi.mock("../src/config-io.js", () => ({
  saveConfigAtomic: mockSaveConfigAtomic,
  DEFAULT_CONFIG: {
    agent: {
      default: null,
      forceBackground: false,
      graceTurns: 6,
      widgetMaxLines: 12,
      widgetCompact: false,
      widgetShortcut: false,
    },
    concurrency: { default: 4 },
  },
}));

// --- Import module under test ---
import {
  setModelOverride,
  setDefaultModel,
  clearModelOverride,
  clearAllModelOverrides,
  setForceBackground,
  setShowCost,
  setGraceTurns,
  setWidgetCompact,
  setWidgetMaxLines,
  setWidgetMaxLinesCompact,
  setWidgetShortcut,
  setAgent,
  setConcurrencyDefault,
  setConcurrencyProvider,
  setConcurrencyModel,
  removeConcurrencyProvider,
  removeConcurrencyModel,
  resetConcurrency,
} from "../src/config-mutator.js";

function resetConfig(): void {
  mockConfig.agent = {
    default: null,
    forceBackground: false,
    graceTurns: 6,
    widgetMaxLines: 12,
    widgetCompact: false,
    widgetShortcut: false,
  };
  mockConfig.concurrency = { default: 4 };
}

// ============================================================================
// Model override setters
// ============================================================================

describe("setModelOverride", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets a model override for a type", () => {
    setModelOverride("Explore", "anthropic/claude-sonnet-4-20250514");
    expect(mockConfig.agent["Explore"]).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("sets the global default model", () => {
    setModelOverride("default", "openai/gpt-4o");
    expect(mockConfig.agent.default).toBe("openai/gpt-4o");
  });

  it("sets override to null (inherits parent)", () => {
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    setModelOverride("Explore", null);
    expect(mockConfig.agent["Explore"]).toBeNull();
  });

  it("calls saveConfigAtomic", () => {
    setModelOverride("Explore", "openai/gpt-4o");
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setModelOverride("Explore", "openai/gpt-4o");
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

describe("setDefaultModel", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets the global default model", () => {
    setDefaultModel("openai/gpt-4o");
    expect(mockConfig.agent.default).toBe("openai/gpt-4o");
  });

  it("clears the default model to null", () => {
    mockConfig.agent.default = "openai/gpt-4o";
    setDefaultModel(null);
    expect(mockConfig.agent.default).toBeNull();
  });

  it("calls saveConfigAtomic", () => {
    setDefaultModel("openai/gpt-4o");
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setDefaultModel("openai/gpt-4o");
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

describe("clearModelOverride", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("removes a per-type override", () => {
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    clearModelOverride("Explore");
    expect(mockConfig.agent["Explore"]).toBeUndefined();
  });

  it("does nothing when override doesn't exist", () => {
    clearModelOverride("Explore");
    expect(mockConfig.agent["Explore"]).toBeUndefined();
  });

  it("calls saveConfigAtomic", () => {
    clearModelOverride("Explore");
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });
});

describe("clearAllModelOverrides", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("removes per-type overrides", () => {
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    mockConfig.agent["general-purpose"] = "anthropic/claude-sonnet-4-20250514";
    clearAllModelOverrides();
    expect(mockConfig.agent["Explore"]).toBeUndefined();
    expect(mockConfig.agent["general-purpose"]).toBeUndefined();
  });

  it("preserves default and forceBackground", () => {
    mockConfig.agent.default = "openai/gpt-4o";
    mockConfig.agent.forceBackground = true;
    mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    clearAllModelOverrides();
    expect(mockConfig.agent.default).toBe("openai/gpt-4o");
    expect(mockConfig.agent.forceBackground).toBe(true);
  });

  it("preserves graceTurns", () => {
    mockConfig.agent.graceTurns = 10;
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    clearAllModelOverrides();
    expect(mockConfig.agent.graceTurns).toBe(10);
  });

  it("preserves widget settings", () => {
    mockConfig.agent.widgetMaxLines = 8;
    mockConfig.agent.widgetMaxLinesCompact = 4;
    mockConfig.agent.widgetCompact = true;
    mockConfig.agent.widgetShortcut = true;
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    clearAllModelOverrides();
    expect(mockConfig.agent.widgetMaxLines).toBe(8);
    expect(mockConfig.agent.widgetMaxLinesCompact).toBe(4);
    expect(mockConfig.agent.widgetCompact).toBe(true);
    expect(mockConfig.agent.widgetShortcut).toBe(true);
  });

  it("preserves showCost", () => {
    mockConfig.agent.showCost = true;
    mockConfig.agent["Explore"] = "openai/gpt-4o";
    clearAllModelOverrides();
    expect(mockConfig.agent.showCost).toBe(true);
  });

  it("calls saveConfigAtomic", () => {
    clearAllModelOverrides();
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls syncWidgetSettings", () => {
    clearAllModelOverrides();
    expect(mockSyncWidgetSettings).toHaveBeenCalled();
  });
});

// ============================================================================
// Simple agent settings
// ============================================================================

describe("setForceBackground", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets forceBackground to true", () => {
    setForceBackground(true);
    expect(mockConfig.agent.forceBackground).toBe(true);
  });

  it("sets forceBackground to false", () => {
    mockConfig.agent.forceBackground = true;
    setForceBackground(false);
    expect(mockConfig.agent.forceBackground).toBe(false);
  });

  it("calls saveConfigAtomic", () => {
    setForceBackground(true);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setForceBackground(true);
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

describe("setShowCost", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("calls setShowCostEnabled with the value", () => {
    setShowCost(true);
    expect(mockSetShowCostEnabled).toHaveBeenCalledWith(true);
  });

  it("calls saveConfigAtomic", () => {
    setShowCost(true);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setShowCost(true);
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

describe("setGraceTurns", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets graceTurns", () => {
    setGraceTurns(10);
    expect(mockConfig.agent.graceTurns).toBe(10);
  });

  it("sets graceTurns to 0", () => {
    setGraceTurns(0);
    expect(mockConfig.agent.graceTurns).toBe(0);
  });

  it("calls saveConfigAtomic", () => {
    setGraceTurns(10);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setGraceTurns(10);
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Widget settings
// ============================================================================

describe("setWidgetCompact", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets widgetCompact to true", () => {
    setWidgetCompact(true);
    expect(mockConfig.agent.widgetCompact).toBe(true);
  });

  it("sets widgetCompact to false", () => {
    mockConfig.agent.widgetCompact = true;
    setWidgetCompact(false);
    expect(mockConfig.agent.widgetCompact).toBe(false);
  });

  it("calls saveConfigAtomic", () => {
    setWidgetCompact(true);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls syncWidgetSettings", () => {
    setWidgetCompact(true);
    expect(mockSyncWidgetSettings).toHaveBeenCalled();
  });
});

describe("setWidgetMaxLines", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets widgetMaxLines", () => {
    setWidgetMaxLines(8);
    expect(mockConfig.agent.widgetMaxLines).toBe(8);
  });

  it("auto-derives widgetMaxLinesCompact when not explicitly set", () => {
    delete mockConfig.agent.widgetMaxLinesCompact;
    setWidgetMaxLines(10);
    expect(mockConfig.agent.widgetMaxLinesCompact).toBe(5);
  });

  it("does NOT override explicit widgetMaxLinesCompact", () => {
    mockConfig.agent.widgetMaxLinesCompact = 3;
    setWidgetMaxLines(10);
    expect(mockConfig.agent.widgetMaxLinesCompact).toBe(3);
  });

  it("calls saveConfigAtomic", () => {
    setWidgetMaxLines(8);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls syncWidgetSettings", () => {
    setWidgetMaxLines(8);
    expect(mockSyncWidgetSettings).toHaveBeenCalled();
  });
});

describe("setWidgetMaxLinesCompact", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets widgetMaxLinesCompact", () => {
    setWidgetMaxLinesCompact(4);
    expect(mockConfig.agent.widgetMaxLinesCompact).toBe(4);
  });

  it("calls saveConfigAtomic", () => {
    setWidgetMaxLinesCompact(4);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls syncWidgetSettings", () => {
    setWidgetMaxLinesCompact(4);
    expect(mockSyncWidgetSettings).toHaveBeenCalled();
  });
});

describe("setWidgetShortcut", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets widgetShortcut to true", () => {
    setWidgetShortcut(true);
    expect(mockConfig.agent.widgetShortcut).toBe(true);
  });

  it("sets widgetShortcut to false", () => {
    mockConfig.agent.widgetShortcut = true;
    setWidgetShortcut(false);
    expect(mockConfig.agent.widgetShortcut).toBe(false);
  });

  it("calls saveConfigAtomic", () => {
    setWidgetShortcut(true);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("does NOT call syncWidgetSettings", () => {
    setWidgetShortcut(true);
    expect(mockSyncWidgetSettings).not.toHaveBeenCalled();
  });
});

describe("setAgent", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("replaces the agent config", () => {
    const newAgent = { default: "openai/gpt-4o", forceBackground: true } as any;
    setAgent(newAgent);
    expect(mockConfig.agent).toBe(newAgent);
  });

  it("calls saveConfigAtomic", () => {
    setAgent({ default: null, forceBackground: false } as any);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls syncWidgetSettings", () => {
    setAgent({ default: null, forceBackground: false } as any);
    expect(mockSyncWidgetSettings).toHaveBeenCalled();
  });
});

// ============================================================================
// Concurrency setters — these call applyConcurrencyConfig (save + setConcurrency)
// ============================================================================

describe("setConcurrencyDefault", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("sets concurrency.default", () => {
    setConcurrencyDefault(8);
    expect(mockConfig.concurrency.default).toBe(8);
  });

  it("calls saveConfigAtomic", () => {
    setConcurrencyDefault(8);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    setConcurrencyDefault(8);
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});

describe("setConcurrencyProvider", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("adds a new provider limit", () => {
    setConcurrencyProvider("anthropic", 5);
    expect(mockConfig.concurrency.providers).toEqual({ anthropic: 5 });
  });

  it("updates an existing provider limit", () => {
    mockConfig.concurrency.providers = { anthropic: 2 };
    setConcurrencyProvider("anthropic", 5);
    expect(mockConfig.concurrency.providers).toEqual({ anthropic: 5 });
  });

  it("preserves other providers", () => {
    mockConfig.concurrency.providers = { openai: 3 };
    setConcurrencyProvider("anthropic", 5);
    expect(mockConfig.concurrency.providers).toEqual({ openai: 3, anthropic: 5 });
  });

  it("calls saveConfigAtomic", () => {
    setConcurrencyProvider("anthropic", 5);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    setConcurrencyProvider("anthropic", 5);
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});

describe("setConcurrencyModel", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("adds a new model limit", () => {
    setConcurrencyModel("anthropic/claude-sonnet-4-20250514", 3);
    expect(mockConfig.concurrency.models).toEqual({ "anthropic/claude-sonnet-4-20250514": 3 });
  });

  it("updates an existing model limit", () => {
    mockConfig.concurrency.models = { "anthropic/claude-sonnet-4-20250514": 1 };
    setConcurrencyModel("anthropic/claude-sonnet-4-20250514", 3);
    expect(mockConfig.concurrency.models!["anthropic/claude-sonnet-4-20250514"]).toBe(3);
  });

  it("preserves other models", () => {
    mockConfig.concurrency.models = { "openai/gpt-4o": 2 };
    setConcurrencyModel("anthropic/claude-sonnet-4-20250514", 3);
    expect(mockConfig.concurrency.models!["openai/gpt-4o"]).toBe(2);
    expect(mockConfig.concurrency.models!["anthropic/claude-sonnet-4-20250514"]).toBe(3);
  });

  it("calls saveConfigAtomic", () => {
    setConcurrencyModel("anthropic/claude-sonnet-4-20250514", 3);
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    setConcurrencyModel("anthropic/claude-sonnet-4-20250514", 3);
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});

describe("removeConcurrencyProvider", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("removes a provider limit", () => {
    mockConfig.concurrency.providers = { anthropic: 5, openai: 3 };
    removeConcurrencyProvider("anthropic");
    expect(mockConfig.concurrency.providers).toEqual({ openai: 3 });
  });

  it("does nothing when provider doesn't exist", () => {
    mockConfig.concurrency.providers = { openai: 3 };
    removeConcurrencyProvider("anthropic");
    expect(mockConfig.concurrency.providers).toEqual({ openai: 3 });
  });

  it("does nothing when providers is undefined", () => {
    delete mockConfig.concurrency.providers;
    removeConcurrencyProvider("anthropic");
    // No error thrown
  });

  it("calls saveConfigAtomic", () => {
    mockConfig.concurrency.providers = { anthropic: 5 };
    removeConcurrencyProvider("anthropic");
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    mockConfig.concurrency.providers = { anthropic: 5 };
    removeConcurrencyProvider("anthropic");
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});

describe("removeConcurrencyModel", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("removes a model limit", () => {
    mockConfig.concurrency.models = { "openai/gpt-4o": 2, "anthropic/claude-sonnet-4-20250514": 3 };
    removeConcurrencyModel("openai/gpt-4o");
    expect(mockConfig.concurrency.models).toEqual({ "anthropic/claude-sonnet-4-20250514": 3 });
  });

  it("does nothing when model doesn't exist", () => {
    mockConfig.concurrency.models = { "openai/gpt-4o": 2 };
    removeConcurrencyModel("anthropic/claude-sonnet-4-20250514");
    expect(mockConfig.concurrency.models).toEqual({ "openai/gpt-4o": 2 });
  });

  it("does nothing when models is undefined", () => {
    delete mockConfig.concurrency.models;
    removeConcurrencyModel("openai/gpt-4o");
    // No error thrown
  });

  it("calls saveConfigAtomic", () => {
    mockConfig.concurrency.models = { "openai/gpt-4o": 2 };
    removeConcurrencyModel("openai/gpt-4o");
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    mockConfig.concurrency.models = { "openai/gpt-4o": 2 };
    removeConcurrencyModel("openai/gpt-4o");
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});

describe("resetConcurrency", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it("resets concurrency to defaults", () => {
    mockConfig.concurrency = {
      default: 8,
      providers: { anthropic: 5 },
      models: { "openai/gpt-4o": 2 },
    };
    resetConcurrency();
    expect(mockConfig.concurrency).toEqual({ default: 4 });
  });

  it("calls saveConfigAtomic", () => {
    resetConcurrency();
    expect(mockSaveConfigAtomic).toHaveBeenCalledWith(mockConfig);
  });

  it("calls getManager().setConcurrency", () => {
    resetConcurrency();
    expect(mockSetConcurrency).toHaveBeenCalledWith(mockConfig.concurrency);
  });
});
