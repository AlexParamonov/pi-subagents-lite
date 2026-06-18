/**
 * menu-running-agents-new.test.ts — Tests for showRunningAgentsMenu using SelectList.
 *
 * After migration: uses ctx.ui.custom (not ctx.ui.select/runMenuLoop).
 * The running agents menu is a SelectList with dynamic agent entries.
 * Selecting an agent opens an actions submenu (also SelectList).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";

// Capture SelectList constructor calls
let selectListCalls: Array<any> = [];

let settingsListWrapperCalls: Array<{
  component: any;
  options: any;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList { constructor() {} },
  SelectList: class MockSelectList {
    items: any[];
    maxVisible: number;
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[], maxVisible: number, _theme: any) {
      this.items = items;
      this.maxVisible = maxVisible;
      selectListCalls.push(this as any);
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

vi.mock("../src/ui/menu/menu-settings-list-wrapper.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

// Import AFTER mock setup
import { showRunningAgentsMenu, showAgentActions } from "../src/ui/menu/menu-running-agents.js";

function makeRecord(overrides: any = {}): any {
  return {
    id: "test-id-123",
    display: { type: "general-purpose", description: "Test agent" },
    lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
    execution: {},
    result: "some result",
    error: "",
    stats: { lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 }, toolUses: 10, turnCount: 15, compactionCount: 0 },
    ...overrides,
  };
}

describe("showRunningAgentsMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([makeRecord()]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows notification when no agents exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No agents have been spawned this session", "info");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("creates a SelectList with agent entries", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "First" } }),
      makeRecord({ id: "agent-2", display: { type: "Explore", description: "Second" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items.length).toBe(2);
    expect(selectListCalls[0].items[0].value).toBe("agent-1");
    expect(selectListCalls[0].items[1].value).toBe("agent-2");
  });

  it("includes agent type in label", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "Test" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(selectListCalls[0].items[0].label).toContain("general-purpose");
  });

  it("wraps in SettingsListWrapper with title 'Running Agents'", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([makeRecord()]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(settingsListWrapperCalls.length).toBe(1);
    expect(settingsListWrapperCalls[0].options.title).toBe("Running Agents");
  });
});

describe("showAgentActions — actions submenu", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    mockModules.resultViewerCalls.length = 0;
  });

  it("shows View result action for completed agent with result", async () => {
    const record = makeRecord();
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    expect(ctx.ui.custom).toHaveBeenCalled();
    // The actions submenu should have been created
    expect(selectListCalls.length).toBeGreaterThan(0);
    const lastList = selectListCalls[selectListCalls.length - 1];
    const values = lastList.items.map((i: any) => i.value);
    expect(values).toContain("view-result");
  });

  it("shows View error action for agent with error", async () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    const lastList = selectListCalls[selectListCalls.length - 1];
    const values = lastList.items.map((i: any) => i.value);
    expect(values).toContain("view-error");
  });

  it("shows View snapshot action for running agent with session", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [{ role: "user", content: "hi" }] } },
      result: "",
    });
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    const lastList = selectListCalls[selectListCalls.length - 1];
    const values = lastList.items.map((i: any) => i.value);
    expect(values).toContain("view-snapshot");
  });

  it("shows Steer and Stop actions for running agent", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    const lastList = selectListCalls[selectListCalls.length - 1];
    const values = lastList.items.map((i: any) => i.value);
    expect(values).toContain("steer");
    expect(values).toContain("stop");
  });

  it("does not show Steer/Stop for completed agent", async () => {
    const record = makeRecord();
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    const lastList = selectListCalls[selectListCalls.length - 1];
    const values = lastList.items.map((i: any) => i.value);
    expect(values).not.toContain("steer");
    expect(values).not.toContain("stop");
  });

  it("passes modelName from invocation when present", async () => {
    const record = {
      id: "test-id-model",
      display: { type: "general-purpose", description: "Model agent", invocation: { modelName: "gpt-4o" } },
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: { messages: [] } },
      result: "some result text",
      stats: { lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 }, toolUses: 10, turnCount: 15, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    // Trigger onSelect on the actions SelectList to simulate selecting "View result"
    const actionsList = selectListCalls[selectListCalls.length - 1];
    await actionsList.onSelect!({ value: "view-result", label: "View result" });
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].modelName).toBe("gpt-4o");
  });

  it("passes undefined modelName when invocation is absent", async () => {
    const record = {
      id: "test-id-no-model",
      display: { type: "general-purpose", description: "No model agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: { messages: [] } },
      result: "some result text",
      stats: { lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 }, toolUses: 10, turnCount: 15, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx();
    await showAgentActions(ctx, record);
    // Trigger onSelect on the actions SelectList to simulate selecting "View result"
    const actionsList = selectListCalls[selectListCalls.length - 1];
    await actionsList.onSelect!({ value: "view-result", label: "View result" });
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].modelName).toBeUndefined();
  });
});
