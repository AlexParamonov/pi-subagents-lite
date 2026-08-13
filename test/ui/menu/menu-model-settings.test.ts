/**
 * menu-model-settings.test.ts — Tests for showModelSettingsMenu using SettingsList.
 *
 * Uses ctx.ui.custom with SettingsList. Model overrides go through target-level
 * submenus (session/global/project, nested per-level clear) per ADR-0008.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig, selectDialogInstances } from "../../menu-mock-setup.js";
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
    render() {
      return [];
    }
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
    render() {
      return [];
    }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) {
      this.value = v;
    }
    getValue() {
      return this.value;
    }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() {
      return [];
    }
    handleInput() {}
    invalidate() {}
  },
}));

import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockProjectConfig.agent = {};
  mockModules.mockSessionOverrides = { default: null };
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockProjectTargetOffered = false;
}

afterEach(() => resetConfig());

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

  it("shows '(inherits parent)' when no default is set", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toContain("(inherits parent)");
  });

  it("tags a project-sourced default with [project]", async () => {
    mockModules.mockProjectConfig.agent.default = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toContain("openai/gpt-4o");
    expect(item.currentValue).toContain("[project]");
  });

  it("tags a session default with [session]", async () => {
    mockModules.mockSessionOverrides.default = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toContain("[session]");
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
      if (name === "general-purpose")
        return { name: "general-purpose", description: "", model: "anthropic/claude-sonnet-4-20250514" };
      return undefined;
    });
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("shows overridden types as items", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("type:Explore");
  });

  it("shows session override indicator", async () => {
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    expect(item.currentValue).toContain("[session]");
  });

  it("tags a project-sourced per-type value with [project]", async () => {
    mockModules.mockProjectConfig.agent["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    expect(item.currentValue).toContain("openai/gpt-4o");
    expect(item.currentValue).toContain("[project]");
  });

  it("shows 'Override another type...' when non-overridden types exist", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("overrideType");
  });

  it("sets a per-type model at project level via the submenu", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    const proxy = item.submenu("", done);

    const modeList = selectListInstances[selectListInstances.length - 1];
    expect(modeList.items.map((i: any) => i.value)).toEqual(["session", "global", "project", "clear"]);
    modeList.onSelect!({ value: "project" });

    const selector = selectDialogInstances[selectDialogInstances.length - 1];
    selector.callbacks.onSelect("openai/gpt-4o");

    expect(mockModules.mockProjectConfig.agent["Explore"]).toBe("openai/gpt-4o");
    expect(mockModules.mockConfig.agent["Explore"]).toBe("anthropic/claude-sonnet-4-20250514");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("openai/gpt-4o"), "info");
    expect(done).toHaveBeenCalledWith("openai/gpt-4o");
    expect(proxy).toBeDefined();
  });

  it("offers no project entry when the project target is not offered", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    item.submenu("", done);
    const modeList = selectListInstances[selectListInstances.length - 1];
    expect(modeList.items.map((i: any) => i.value)).toEqual(["session", "global", "clear"]);
  });

  it("clears a per-type override at the global level via the nested picker", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    item.submenu("", done);
    const modeList = selectListInstances[selectListInstances.length - 1];
    modeList.onSelect!({ value: "clear" });

    const targetList = selectListInstances[selectListInstances.length - 1];
    expect(targetList.items.map((i: any) => i.value)).toEqual(["session", "global", "all"]);
    targetList.onSelect!({ value: "global" });

    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cleared"), "info");
    expect(done).toHaveBeenCalledWith("global");
  });

  it("clears a per-type override at the project level via the nested picker", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockProjectConfig.agent["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    item.submenu("", done);
    const modeList = selectListInstances[selectListInstances.length - 1];
    modeList.onSelect!({ value: "clear" });

    const targetList = selectListInstances[selectListInstances.length - 1];
    expect(targetList.items.map((i: any) => i.value)).toEqual(["session", "global", "project", "all"]);
    targetList.onSelect!({ value: "project" });

    expect(mockModules.mockProjectConfig.agent["Explore"]).toBeUndefined();
    expect(done).toHaveBeenCalledWith("project");
  });
});

describe("showModelSettingsMenu — clear all overrides per target", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
  });

  it("shows 'Clear all model overrides...' item", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("clearAll");
  });

  it("clear-all at global clears config overrides after target pick + confirm", async () => {
    mockModules.mockConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent.default = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = selectListInstances[selectListInstances.length - 1];
    expect(targetList.items.map((i: any) => i.value)).toEqual(["session", "global", "all"]);
    targetList.onSelect!({ value: "global" });

    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    // The model family clears too (default is a model key).
    expect(mockModules.mockConfig.agent.default).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cleared"), "info");
  });

  it("clear-all at project clears the project layer only", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockProjectConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = selectListInstances[selectListInstances.length - 1];
    targetList.onSelect!({ value: "project" });
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockProjectConfig.agent["Explore"]).toBeUndefined();
    expect(mockModules.mockConfig.agent["Explore"]).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("clear-all at all levels clears session, global and project", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockSessionOverrides["Explore"] = "s/explore";
    mockModules.mockConfig.agent["Explore"] = "g/explore";
    mockModules.mockProjectConfig.agent["Explore"] = "p/explore";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = selectListInstances[selectListInstances.length - 1];
    targetList.onSelect!({ value: "all" });
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockSessionOverrides).toEqual({ default: null });
    expect(mockModules.mockConfig.agent["Explore"]).toBeUndefined();
    expect(mockModules.mockProjectConfig.agent["Explore"]).toBeUndefined();
  });

  it("clear-all at session resets session overrides", async () => {
    mockModules.mockSessionOverrides["Explore"] = "s/explore";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = selectListInstances[selectListInstances.length - 1];
    targetList.onSelect!({ value: "session" });
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockSessionOverrides).toEqual({ default: null });
  });
});
