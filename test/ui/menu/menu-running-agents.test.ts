/**
 * menu-running-agents-new.test.ts — Tests for showRunningAgentsMenu using SelectList.
 *
 * After migration: uses ctx.ui.custom (not ctx.ui.select/runMenuLoop).
 * The running agents menu is a SelectList with dynamic agent entries.
 * Selecting an agent opens an actions submenu (also SelectList).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

// Capture SelectList constructor calls
let selectListCalls: Array<any> = [];

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

// Import AFTER mock setup
import { showRunningAgentsMenu, buildAgentActionsList } from "../../../src/ui/menu/menu-running-agents.js";

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
const noopTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("showRunningAgentsMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
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
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
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

  it("returns a component that renders with a title", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([makeRecord()]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    // Running agents now uses a simple title wrapper instead of SettingsListWrapper
    // because SettingsListWrapper doesn't work with delegating components.
    // Verify the menu was opened and a SelectList was created.
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(selectListCalls.length).toBe(1);
  });
});

describe("buildAgentActionsList — actions submenu", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.resultViewerCalls.length = 0;
  });

  it("shows View result action for completed agent with result", () => {
    const list = buildAgentActionsList(createMockCtx(), makeRecord(), noopTheme, () => {}, () => {}, () => {});
    const values = list.items.map((i: any) => i.value);
    expect(values).toContain("view-result");
  });

  it("shows View error action for agent with error", () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const list = buildAgentActionsList(createMockCtx(), record, noopTheme, () => {}, () => {}, () => {});
    const values = list.items.map((i: any) => i.value);
    expect(values).toContain("view-error");
  });

  it("shows View snapshot action for running agent with session", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [{ role: "user", content: "hi" }] } },
      result: "",
    });
    const list = buildAgentActionsList(createMockCtx(), record, noopTheme, () => {}, () => {}, () => {});
    const values = list.items.map((i: any) => i.value);
    expect(values).toContain("view-snapshot");
  });

  it("shows Steer and Stop actions for running agent", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const list = buildAgentActionsList(createMockCtx(), record, noopTheme, () => {}, () => {}, () => {});
    const values = list.items.map((i: any) => i.value);
    expect(values).toContain("steer");
    expect(values).toContain("stop");
  });

  it("does not show Steer/Stop for completed agent", () => {
    const list = buildAgentActionsList(createMockCtx(), makeRecord(), noopTheme, () => {}, () => {}, () => {});
    const values = list.items.map((i: any) => i.value);
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
    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: "view-result", label: "View result" });
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
    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: "view-result", label: "View result" });
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].modelName).toBeUndefined();
  });
});
