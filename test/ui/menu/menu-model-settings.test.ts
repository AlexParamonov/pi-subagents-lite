/**
 * menu-model-settings-new.test.ts — Tests for showModelSettingsMenu using SettingsList.
 *
 * After migration: uses ctx.ui.custom with SettingsList.
 * Cost display toggle removed (still in widget settings → usage stats).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig, getAllTypes } from "../../../src/agents/agent-types.js";

let settingsListCalls: Array<any> = [];
let selectListInstances: Array<any> = [];
let settingsListWrapperCalls: Array<any> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: any;
    onCancel: any;
    constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
      this.items = items;
      this.onChange = onChange;
      this.onCancel = onCancel;
      settingsListCalls.push(this as any);
    }
    render() { return []; }
    handleInput() {}
    updateValue() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() { return []; }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

// Mock SearchableSelectDialog from searchable-select
vi.mock("../../../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    onSelect?: (v: string) => void;
    onCancel?: () => void;
    constructor(_items: any, _current: any, callbacks: any, _theme: any) {
      this.onSelect = callbacks.onSelect;
      this.onCancel = callbacks.onCancel;
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockConfig.thinkingOverrides = {};
  mockModules.mockSessionOverrides = { default: null };
  mockModules.mockSessionThinkingOverrides = {};
  mockModules.mockSessionShowCost = undefined;
}

describe("showModelSettingsMenu — SettingsList migration", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with global default model item", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(settingsListCalls.length).toBe(1);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("defaultModel");
  });

  it("shows global default model with current value", async () => {
    mockModules.mockConfig.agent.default = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toContain("openai/gpt-4o");
  });

  it("shows the parent source when no global default is set", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toBe("inherit (parent)");
  });

  it("shows global model and thinking values with their sources", async () => {
    mockModules.mockSessionOverrides.default = "openai/gpt-4o";
    mockModules.mockConfig.agent.defaultThinking = "low";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);

    expect(settingsListCalls[0].items.find((i: any) => i.id === "defaultModel").currentValue)
      .toBe("openai/gpt-4o (session global)");
    expect(settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking").currentValue)
      .toBe("low (global default)");
  });
});

describe("showModelSettingsMenu — cost display removed", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("does NOT include cost display toggle", async () => {
    mockModules.mockConfig.agent.showCost = true;
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("showCost");
    expect(ids).not.toContain("costDisplay");
  });
});

describe("showModelSettingsMenu — per-type overrides", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "", model: "openai/gpt-4o" };
      if (name === "general-purpose") return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514", thinkingLevel: "medium" };
      return undefined;
    });
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("shows model and thinking settings for every agent", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(expect.arrayContaining([
      "model:general-purpose", "thinking:general-purpose",
      "model:Explore", "thinking:Explore",
    ]));
  });

  it("shows the effective per-agent model and thinking source", async () => {
    mockModules.mockSessionOverrides.Explore = "openai/gpt-4o";
    mockModules.mockConfig.thinkingOverrides.Explore = "xhigh";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);

    expect(settingsListCalls[0].items.find((i: any) => i.id === "model:Explore").currentValue)
      .toBe("openai/gpt-4o (session override)");
    expect(settingsListCalls[0].items.find((i: any) => i.id === "thinking:Explore").currentValue)
      .toBe("xhigh (saved override)");
  });

  it("shows Agent MD as the source when no per-agent override is set", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);

    expect(settingsListCalls[0].items.find((i: any) => i.id === "model:Explore").currentValue)
      .toBe("openai/gpt-4o (agent MD)");
    expect(settingsListCalls[0].items.find((i: any) => i.id === "thinking:general-purpose").currentValue)
      .toBe("medium (agent MD)");
  });

  it("shows the clamped value and only supported levels for an incompatible agent setting", async () => {
    mockModules.mockConfig.thinkingOverrides.Explore = "high";
    const ctx = createMockCtx();
    ctx.modelRegistry.find = vi.fn(() => ({ provider: "openai", id: "gpt-4o", reasoning: false }));
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);

    const item = settingsListCalls[0].items.find((i: any) => i.id === "thinking:Explore");
    expect(item.currentValue).toBe("off (saved override)");
    expect(item.description).toContain("requested high from saved override");

    item.submenu("", vi.fn());
    selectListInstances.at(-1)!.onSelect!({ value: "session" });
    expect(selectListInstances.at(-1)!.items.map((entry: any) => entry.value)).toEqual(["inherit", "off"]);
  });

  it("shows 'Clear session overrides' when session overrides exist", async () => {
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("clearSession");
  });

  it("does NOT show 'Clear session overrides' when no session overrides", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("clearSession");
  });

  it("clear session overrides calls store.mutate.session.clearAll", async () => {
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearSession");
    const done = vi.fn();
    item.submenu("", done);
    // Confirm submenu creates SelectList — select "Yes"
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });
    expect(mockModules.mockSessionOverrides).toEqual({ default: null });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showModelSettingsMenu — clear all overrides", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("shows 'Clear all overrides' item", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("clearAll");
  });

  it("clear all overrides clears config overrides", async () => {
    mockModules.mockConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent.default = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("reset all clears persisted thinking overrides for removed agent types", async () => {
    mockModules.mockConfig.thinkingOverrides["removed-agent"] = "high";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockConfig.thinkingOverrides).toEqual({});
    expect(ctx.ui.notify).toHaveBeenCalledWith("All agent settings reset", "info");
  });
});
