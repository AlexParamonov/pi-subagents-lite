/**
 * menu-model-settings.test.ts — Tests for showModelSettingsMenu using SettingsList.
 *
 * Uses ctx.ui.custom with SettingsList. Model overrides go through target-level
 * submenus (session/global/project, nested per-level clear) per ADR-0008.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig, selectDialogInstances } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { ConfigStore, type ConfigIO } from "../../../src/config/config-store.js";
import { getAgentConfig, getAllTypes } from "../../../src/agents/agent-types.js";
import { SEPARATOR_ID } from "../../../src/ui/menu/helpers.js";

const piSettingsMock = vi.hoisted(() => ({
  getPiDefaultThinkingLevel: vi.fn(() => undefined),
}));

let settingsListCalls: Array<any> = [];
let selectListInstances: Array<any> = [];
let settingsListWrapperCalls: Array<any> = [];

vi.mock("@earendil-works/pi-tui", async () => {
  const { activatePickerRow } = await import("../../menu-picker-helpers.js");
  return {
    SettingsList: class MockSettingsList {
      items: any[];
      onChange: any;
      onCancel: any;
      submenuComponent: any = null;
      constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
        this.items = items;
        this.onChange = onChange;
        this.onCancel = onCancel;
        settingsListCalls.push(this as any);
      }
      render() {
        return this.submenuComponent ? this.submenuComponent.render(80) : [];
      }
      handleInput() {}
      updateValue() {}
      activate(id: string) {
        activatePickerRow(this, id);
      }
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
  };
});

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

vi.mock("../../../src/pi-settings.js", () => piSettingsMock);

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockProjectConfig.agent = {};
  mockModules.mockSessionOverrides = { default: null };
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockProjectTargetOffered = false;
}

/** True for group-header rows (bare model id section titles). */
const isGroupHeader = (item: any) => item.kind === "group-header";
/** Group-header rows of the last built item list. */
const groupHeaders = () => settingsListCalls[0].items.filter(isGroupHeader);
/** Index of the group header for a model id, or -1. */
const groupHeaderIndex = (modelId: string) =>
  settingsListCalls[0].items.findIndex((i: any) => isGroupHeader(i) && i.label === modelId);
/** The item with this id from the last built item list. */
const row = (id: string) => settingsListCalls[0].items.find((i: any) => i.id === id);
const rowIndex = (id: string) => settingsListCalls[0].items.findIndex((i: any) => i.id === id);

/** In-memory ConfigIO over two raw layers, mirroring config-store.test.ts. */
function memIO(opts: { global?: any; project?: any | null; projectStatus?: any } = {}): ConfigIO {
  const state = {
    global: opts.global ?? {},
    project: opts.project === undefined ? null : opts.project,
    projectStatus: opts.projectStatus ?? "untrusted",
  };
  return {
    load: () => ({
      global: structuredClone(state.global),
      project: state.project ? structuredClone(state.project) : null,
      projectStatus: state.projectStatus,
    }),
    saveGlobal: (config) => {
      state.global = structuredClone(config);
    },
    saveProject: (config) => {
      state.project = structuredClone(config);
    },
  };
}

afterEach(() => {
  resetConfig();
  piSettingsMock.getPiDefaultThinkingLevel.mockReturnValue(undefined);
});

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

  it("shows the global default untagged when only the global file has the key", async () => {
    mockModules.mockConfig.agent.default = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toBe("openai/gpt-4o");
  });

  it("shows '(inherits parent)' without a tag when no default is set", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toBe("(inherits parent)");
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

  it("shows exactly one tag on the default row when multiple layers carry the key", async () => {
    mockModules.mockConfig.agent.default = "g/default";
    mockModules.mockProjectConfig.agent.default = "p/default";
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    expect(item.currentValue).toBe("s/default [session]");
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
    expect(item.currentValue).toBe("off     [session]");
  });
  it("tags a project-sourced per-type value with [project]", async () => {
    mockModules.mockProjectConfig.agent["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const items = settingsListCalls[0].items;
    const item = items.find((i: any) => i.id === "type:Explore");
    expect(item.currentValue).toBe("off     [project]");
    // The model id moved to the group header above the row.
    const headerIdx = groupHeaderIndex("openai/gpt-4o");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(items.indexOf(item));
  });

  // The session default is a session-wide override: it beats the project
  // per-type key, so the row shows the session value and the [session] tag
  // instead of the stale project value.
  it("lists a shadowed project per-type override under a set session default with [session]", async () => {
    mockModules.mockProjectConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    expect(item).toBeDefined();
    expect(item.currentValue).toBe("medium  [session]");
    // frontmatter-only general-purpose stays hidden even though its model
    // (claude-sonnet) differs from the session default.
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("type:general-purpose");
  });
  it("lists a shadowed global per-type override under the session default with [session]", async () => {
    mockModules.mockConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const items = settingsListCalls[0].items;
    const item = items.find((i: any) => i.id === "type:Explore");
    expect(item).toBeDefined();
    expect(item.currentValue).toBe("medium  [session]");
    // The row sits under the session default's group, not the override's.
    const headerIdx = groupHeaderIndex("s/default");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(items.indexOf(item));
  });

  it("keeps a session per-type override ahead of the session default", async () => {
    mockModules.mockSessionOverrides.default = "s/default";
    mockModules.mockSessionOverrides["Explore"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const items = settingsListCalls[0].items;
    const exploreRow = items.find((i: any) => i.id === "type:Explore");
    // Explore resolves to its session per-type override (gpt-4o, known →
    // thinking clamped to off), not the session default.
    expect(groupHeaderIndex("openai/gpt-4o")).toBeLessThan(items.indexOf(exploreRow));
    expect(exploreRow?.currentValue).toBe("off     [session]");
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

    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList.items.map((i: any) => i.id)).toEqual(["session", "global", "project", "clear"]);
    modeList.activate("project");

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
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList.items.map((i: any) => i.id)).toEqual(["session", "global", "clear"]);
  });

  it("clears a per-type override at the global level via the nested picker", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    item.submenu("", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["global"]);
    targetList.activate("global");

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
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["project"]);
    targetList.activate("project");

    expect(mockModules.mockProjectConfig.agent["Explore"]).toBeUndefined();
    expect(done).toHaveBeenCalledWith("project");
  });

  it("per-type clear offers 'All levels' when two levels carry the key", async () => {
    mockModules.mockConfig.agent["Explore"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockSessionOverrides["Explore"] = "s/explore";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "type:Explore");
    const done = vi.fn();
    item.submenu("", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["session", "global", "all"]);
    targetList.activate("session");

    expect(mockModules.mockSessionOverrides["Explore"]).toBeUndefined();
    expect(mockModules.mockConfig.agent["Explore"]).toBe("anthropic/claude-sonnet-4-20250514");
  });
});

describe("showModelSettingsMenu — model groups", () => {
  // Mirrors the issue's manual-test fixture: scout has a frontmatter model +
  // thinking, worker a frontmatter model (non-reasoning), plain inherits.
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    piSettingsMock.getPiDefaultThinkingLevel.mockReturnValue(undefined);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "scout")
        return { name: "scout", description: "", model: "anthropic/claude-sonnet-4-20250514", thinkingLevel: "high" };
      if (name === "worker") return { name: "worker", description: "", model: "openai/gpt-4o" };
      if (name === "plain") return { name: "plain", description: "" };
      return undefined;
    });
    (getAllTypes as any).mockReturnValue(["scout", "worker", "plain"]);
  });

  const items = () => settingsListCalls[0].items;

  it("renders one group header per non-default resolved model, alphabetical by model id", async () => {
    mockModules.mockConfig.agent["scout"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.agent["worker"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(groupHeaders().map((h: any) => h.label)).toEqual(["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
  });

  it("separates consecutive groups with a blank spacer but none before the long rule", async () => {
    mockModules.mockConfig.agent["scout"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.agent["worker"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const list = items();
    const scoutHeaderIdx = groupHeaderIndex("anthropic/claude-sonnet-4-20250514");
    const scoutIdx = rowIndex("type:scout");
    const workerHeaderIdx = groupHeaderIndex("openai/gpt-4o");
    const workerIdx = rowIndex("type:worker");
    // The pre-groups blank spacer stays directly before the first header.
    expect(list[scoutHeaderIdx - 1]).toMatchObject({ id: SEPARATOR_ID, label: " " });
    // No blank between a header and its own first row.
    expect(list[scoutHeaderIdx + 1].id).toBe("type:scout");
    expect(list[workerHeaderIdx + 1].id).toBe("type:worker");
    // Blank spacer between group 1's last row and group 2's header.
    expect(list[scoutIdx + 1]).toMatchObject({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    expect(scoutIdx + 2).toBe(workerHeaderIdx);
    // No spacer between the last group's last row and the long rule.
    expect(list[workerIdx + 1]).toMatchObject({ id: SEPARATOR_ID, currentValue: "────────" });
  });

  it("lists each non-default type once with name, clamped thinking, and provenance tag", async () => {
    mockModules.mockConfig.agent["scout"] = "anthropic/claude-sonnet-4-20250514";
    mockModules.mockConfig.agent["worker"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    // scout: frontmatter thinking high, reasoning model → unclamped.
    expect(row("type:scout")?.label).toBe("scout");
    expect(row("type:scout")?.currentValue).toBe("high    ");
    // worker: no thinking set → medium, clamped to off by the non-reasoning model.
    expect(row("type:worker")?.currentValue).toBe("off     ");
    // plain resolves to the parent (effective default) → not listed.
    expect(row("type:plain")).toBeUndefined();
  });

  it("never lists frontmatter-only types even when their model differs from the effective default", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    // scout (opus) and worker (gpt-4o) carry frontmatter models but no
    // per-type override; plain inherits. None of them gets a row.
    expect(groupHeaders()).toEqual([]);
    expect(row("type:scout")).toBeUndefined();
    expect(row("type:worker")).toBeUndefined();
    expect(row("type:plain")).toBeUndefined();
  });

  it("renders no model groups when every type resolves to the effective default", async () => {
    (getAgentConfig as any).mockImplementation((name: string) => ({ name }));
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(groupHeaders()).toEqual([]);
    const ids = items().map((i: any) => i.id);
    expect(ids).toContain("defaultModel");
    expect(ids).toContain("overrideType");
    expect(ids).toContain("clearAll");
    expect(ids).not.toContain("type:scout");
    expect(ids).not.toContain("type:worker");
    expect(ids).not.toContain("type:plain");
  });

  it("tags rows by provenance: [project] for a project-layer override, untagged for global", async () => {
    // worker: project layer wins over global → [project].
    mockModules.mockProjectConfig.agent["worker"] = "openai/gpt-4o";
    mockModules.mockConfig.agent["worker"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(row("type:worker")?.currentValue).toBe("off     [project]");

    // global-only override → untagged (the global layer is the default source).
    delete mockModules.mockProjectConfig.agent["worker"];
    mockModules.mockConfig.agent["worker"] = "openai/gpt-4o";
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(settingsListCalls[1].items.find((i: any) => i.id === "type:worker")?.currentValue).toBe("off     ");
  });

  it("lists a per-type override equal to the default under the default's group with the winning tag", async () => {
    mockModules.mockConfig.agent.default = "openai/gpt-4o";
    mockModules.mockConfig.agent["plain"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    // Only the default model's group renders: the frontmatter-only types are
    // never listed regardless of their resolved model.
    expect(groupHeaders().map((h: any) => h.label)).toEqual(["openai/gpt-4o"]);
    // plain: explicit global override equal to the default → listed, untagged.
    expect(row("type:plain")?.currentValue).toBe("off     ");
    // worker: frontmatter gpt-4o equals the default, no override → stays hidden.
    expect(row("type:worker")).toBeUndefined();
    // scout: frontmatter opus differs from the default, no override → stays hidden.
    expect(row("type:scout")).toBeUndefined();
  });

  it("tags a session per-type override with [session] and clamps its thinking", async () => {
    mockModules.mockSessionOverrides["scout"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(row("type:scout")?.currentValue).toBe("off     [session]");
  });

  it("shows the effective defaultThinking when frontmatter thinking is unset", async () => {
    mockModules.mockConfig.agent.defaultThinking = "low";
    mockModules.mockSessionOverrides["plain"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(row("type:plain")?.currentValue).toBe("low     [session]");
  });

  it("shows pi's defaultThinkingLevel when no thinking source is set", async () => {
    piSettingsMock.getPiDefaultThinkingLevel.mockReturnValue("low");
    mockModules.mockSessionOverrides["plain"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(row("type:plain")?.currentValue).toBe("low     [session]");
  });

  it("never displays a configured → effective arrow", async () => {
    // Old frontmatterHint setup: config override shadows a frontmatter model.
    mockModules.mockConfig.agent["scout"] = "openai/gpt-4o";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    for (const item of items()) {
      expect(`${item.label} ${item.currentValue}`).not.toContain("→");
    }
  });
  it("lists an empty-string per-type override with a clear path to its carrying level", async () => {
    mockModules.mockConfig.agent["scout"] = "";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const scout = row("type:scout");
    expect(scout).toBeDefined();
    const done = vi.fn();
    scout.submenu("", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toContain("global");
  });

  it("groups an unknown resolved model by its raw id without clamping", async () => {
    (getAgentConfig as any).mockImplementation((name: string) =>
      name === "scout" ? { name, thinkingLevel: "high" } : { name },
    );
    mockModules.mockConfig.agent["scout"] = "custom/unknown-1";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    expect(groupHeaders().map((h: any) => h.label)).toContain("custom/unknown-1");
    expect(row("type:scout")?.currentValue).toBe("high    ");
  });

  it("keeps frontmatter types overridable via 'Override another type...'", async () => {
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const item = row("overrideType");
    expect(item).toBeDefined();
    item.submenu("", vi.fn());
    const dialog = selectDialogInstances[selectDialogInstances.length - 1];
    expect(dialog.items.map((o: any) => o.value)).toEqual(["scout", "worker", "plain"]);
  });

  it("re-groups a row under the new model with [session] tag after a session override", async () => {
    mockModules.mockConfig.agent["scout"] = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const scout = row("type:scout");
    expect(scout).toBeDefined();
    const done = vi.fn();
    scout.submenu("", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("session");
    const selector = selectDialogInstances[selectDialogInstances.length - 1];
    selector.callbacks.onSelect("openai/gpt-4o");
    expect(mockModules.mockSessionOverrides["scout"]).toBe("openai/gpt-4o");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("session"), "info");

    // Reopen: scout sits under the new model's group with the [session] tag.
    settingsListCalls = [];
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    const reopened = settingsListCalls[0].items;
    const scoutRow = reopened.find((i: any) => i.id === "type:scout");
    expect(scoutRow.currentValue).toBe("off     [session]");
    expect(reopened.filter(isGroupHeader).map((i: any) => i.label)).toEqual(["openai/gpt-4o"]);
  });

  it("starts every row tag at the same value column and renders group headers as styled bare ids", async () => {
    mockModules.mockConfig.agent["scout"] = "anthropic/claude-sonnet-4-20250514"; // high
    mockModules.mockConfig.agent["worker"] = "openai/gpt-4o"; // off
    mockModules.mockConfig.agent["plain"] = "anthropic/claude-sonnet-4-20250514"; // medium
    mockModules.mockSessionOverrides["scout"] = "anthropic/claude-sonnet-4-20250514"; // [session] tag
    const ctx = createMockCtx();
    // ANSI-emitting theme fake so the assertion sees the styling pi's real
    // theme.bold(theme.fg("accent", ...)) would produce.
    ctx.ui.custom = vi.fn(async (factory: any) => {
      factory(
        { terminal: { rows: 40 } },
        { fg: (_c: string, t: string) => `\x1b[38;5;1m${t}\x1b[0m`, bold: (t: string) => `\x1b[1m${t}\x1b[0m` },
        null,
        () => {},
      );
    });
    await showModelSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    // Rows: thinking padded to a fixed width + one space; the tag follows at
    // the fixed column when present, and untagged (global-won) rows end there.
    const rows = items().filter((i: any) => i.id?.startsWith("type:"));
    expect(rows.map((r: any) => r.currentValue)).toEqual(["high    [session]", "medium  ", "off     "]);
    expect(rows.map((r: any) => r.currentValue.indexOf("["))).toEqual([8, -1, -1]);
    // Group headers: marker-identified, bare id in bold accent, no dashes,
    // still SEPARATOR_ID rows so separator-skip keeps the cursor off them.
    const headers = items().filter(isGroupHeader);
    for (const h of headers) {
      expect(h.id).toBe(SEPARATOR_ID);
      expect(h.currentValue).toBe("");
    }
    expect(headers.map((h: any) => h.label)).toEqual([
      "\x1b[1m\x1b[38;5;1manthropic/claude-sonnet-4-20250514\x1b[0m\x1b[0m",
      "\x1b[1m\x1b[38;5;1mopenai/gpt-4o\x1b[0m\x1b[0m",
    ]);
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
  it("hides the clear-all entry when no level has model settings", async () => {
    delete mockModules.mockConfig.agent.default;
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("clearAll");
  });

  it("clear-all offers only the levels with model settings (no 'All levels' with one)", async () => {
    delete mockModules.mockConfig.agent.default;
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["session"]);
  });

  it("clear-all offers 'All levels' when at least two levels have settings", async () => {
    mockModules.mockSessionOverrides.default = "s/default";
    mockModules.mockConfig.agent.default = "g/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["session", "global", "all"]);
  });

  it("clear-all offers the project level only when the project target is offered", async () => {
    delete mockModules.mockConfig.agent.default;
    mockModules.mockProjectConfig.agent["Explore"] = "p/explore";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    expect(settingsListCalls[0].items.map((i: any) => i.id)).not.toContain("clearAll");

    mockModules.mockProjectTargetOffered = true;
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[1].items.find((i: any) => i.id === "clearAll");
    item.submenu("", vi.fn());
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["project"]);
  });

  it("clear-all at global clears config overrides after target pick + confirm", async () => {
    mockModules.mockConfig.agent["Explore"] = "openai/gpt-4o";
    mockModules.mockConfig.agent.default = "anthropic/claude-sonnet-4-20250514";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "clearAll");
    const done = vi.fn();
    item.submenu("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i: any) => i.id)).toEqual(["global"]);
    targetList.activate("global");

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
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("project");
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
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("all");
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
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("session");
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes" });

    expect(mockModules.mockSessionOverrides).toEqual({ default: null });
  });
});

describe("showModelSettingsMenu — default row clear availability", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  /** Open the Global default row's submenu, pick "Clear...", return the nested level picker. */
  function openDefaultClear() {
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    item.submenu("", vi.fn());
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList.items.map((i: any) => i.id)).toContain("clear");
    modeList.activate("clear");
    return settingsListCalls[settingsListCalls.length - 1];
  }

  it("offers only the levels that carry the default key", async () => {
    delete mockModules.mockConfig.agent.default;
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);
    expect(openDefaultClear().items.map((i: any) => i.id)).toEqual(["session"]);
  });

  it("offers 'All levels' when two levels carry the default key", async () => {
    mockModules.mockSessionOverrides.default = "s/default";
    mockModules.mockConfig.agent.default = "g/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);
    expect(openDefaultClear().items.map((i: any) => i.id)).toEqual(["session", "global", "all"]);
  });

  it("omits levels without the default key even when the project target is offered", async () => {
    delete mockModules.mockConfig.agent.default;
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockProjectConfig.agent.default = "p/default";
    mockModules.mockSessionOverrides.default = "s/default";
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);
    expect(openDefaultClear().items.map((i: any) => i.id)).toEqual(["session", "project", "all"]);
  });
});

describe("showModelSettingsMenu — '(inherits parent)' clears the picked layer (real ConfigStore)", () => {
  beforeEach(() => {
    resetAgentState();
    settingsListCalls = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  // Regression: the picker returns the literal "(inherits parent)" string (never
  // null). Selecting it must delete the key at the picked layer (ADR-0008 delete
  // semantics), not store the sentinel as a model value. Driven through the real
  // ConfigStore so the mock-store mirror cannot hide the bug.
  it("at the global target deletes the global key and modelFor falls through to parent", async () => {
    const store = new ConfigStore(memIO({ global: { agent: { default: "g/default" } }, projectStatus: "loaded" }));
    mockModules.mockStoreOverride = store;
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);

    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    const done = vi.fn();
    item.submenu("", done);
    settingsListCalls[settingsListCalls.length - 1].activate("global");
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("(inherits parent)");

    expect(store.hasGlobalModelKey("default")).toBe(false);
    expect(store.agent.defaultModel).toBeNull();
    expect(store.modelFor("Explore", "parent-id")).toBe("parent-id");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inherits parent"), "info");
  });

  it("at the project target deletes only the project key and the global value applies again", async () => {
    const store = new ConfigStore(
      memIO({
        global: { agent: { default: "g/default" } },
        project: { agent: { default: "p/default" } },
        projectStatus: "loaded",
      }),
    );
    mockModules.mockStoreOverride = store;
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);

    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    const done = vi.fn();
    item.submenu("", done);
    settingsListCalls[settingsListCalls.length - 1].activate("project");
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("(inherits parent)");

    expect(store.hasProjectModelKey("default")).toBe(false);
    expect(store.hasGlobalModelKey("default")).toBe(true);
    expect(store.agent.defaultModel).toBe("g/default");
    expect(store.modelFor("Explore", "parent-id")).toBe("g/default");
  });

  it("at the session target clears the session override and the config value applies again", async () => {
    const store = new ConfigStore(memIO({ global: { agent: { default: "g/default" } }, projectStatus: "loaded" }));
    store.mutate.session.setOverride("default", "s/default");
    mockModules.mockStoreOverride = store;
    const ctx = createMockCtx();
    await showModelSettingsMenu(ctx, ["openai/gpt-4o"]);

    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultModel");
    const done = vi.fn();
    item.submenu("", done);
    settingsListCalls[settingsListCalls.length - 1].activate("session");
    selectDialogInstances[selectDialogInstances.length - 1].callbacks.onSelect("(inherits parent)");

    expect(store.sessionDefaultModel).toBeNull();
    expect(store.modelFor("Explore", "parent-id")).toBe("g/default");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inherits parent"), "info");
  });
});
