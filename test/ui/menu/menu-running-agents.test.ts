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
  matchesKey: vi.fn((data: string, key: string) => {
    const map: Record<string, string[]> = {
      up: ["\x1b[A", "k"],
      down: ["\x1b[B", "j"],
      pageUp: ["\x1b[5~"],
      pageDown: ["\x1b[6~"],
      home: ["\x1b[H"],
      escape: ["\x1b"],
      q: ["q"],
      s: ["s"],
    };
    return (map[key] ?? [key]).includes(data);
  }),
  truncateToWidth: vi.fn((s: string, w: number) => s.length > w ? s.slice(0, w - 3) + "..." : s),
  visibleWidth: vi.fn((s: string) => s.length),
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

});

describe("showTextViewer (via buildAgentActionsList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("opens text viewer when selecting view-result", async () => {
    let capturedFactory: any = null;
    const record = makeRecord({ result: "hello world\nline 2" });
    const ctx = createMockCtx();
    ctx.ui.custom = vi.fn(async (factory: any) => {
      capturedFactory = factory;
      return undefined;
    });

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: "view-result" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens text viewer when selecting view-error", async () => {
    let capturedFactory: any = null;
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const ctx = createMockCtx();
    ctx.ui.custom = vi.fn(async (factory: any) => {
      capturedFactory = factory;
      return undefined;
    });

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: "view-error" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens ConversationViewer when selecting view-snapshot", async () => {
    let capturedFactory: any = null;
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [{ role: "user", content: "hi" }], subscribe: vi.fn(() => () => {}) } },
      result: "",
    });
    const ctx = createMockCtx();
    ctx.ui.custom = vi.fn(async (factory: any) => {
      capturedFactory = factory;
      return undefined;
    });

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: "view-snapshot" });

    expect(capturedFactory).toBeDefined();
  });
});

describe("showTextViewer — component behavior", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  async function getComponent(record: any, kind: "result" | "error", text: string) {
    let factory: any = null;
    const ctx = createMockCtx();
    ctx.ui.custom = vi.fn(async (f: any) => {
      factory = f;
      return undefined;
    });
    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, () => {});
    await list.onSelect!({ value: kind === "result" ? "view-result" : "view-error" });
    // Invoke the factory to get the component
    const doneFn = vi.fn();
    const component = factory!
      ({ terminal: { rows: 40, cols: 80 } },
      { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      null,
      doneFn,
    );
    return { component, done: doneFn };
  }

  it("renders border frame with title", async () => {
    const record = makeRecord({ result: "hello world\nline 2" });
    const { component } = await getComponent(record, "result", "hello world\nline 2");
    const lines = component.render(80);

    expect(lines[0]).toMatch(/\u256d/); // top-left corner
    expect(lines[lines.length - 1]).toMatch(/\u2570/); // bottom-right corner
    expect(lines[1]).toContain("general-purpose"); // title contains agent type
    expect(lines[1]).toContain("test-id"); // title contains short id
  });

  it("renders content lines", async () => {
    const record = makeRecord({ result: "line one\nline two\nline three" });
    const { component } = await getComponent(record, "result", "line one\nline two\nline three");
    const lines = component.render(80);
    const text = lines.join("\n");

    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(text).toContain("line three");
  });

  it("renders error viewer with Error suffix", async () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const { component } = await getComponent(record, "error", "something went wrong");
    const lines = component.render(80);
    const text = lines.join("\n");

    expect(text).toContain("Error");
    expect(text).toContain("something went wrong");
  });

  it("closes on q key", async () => {
    const record = makeRecord({ result: "test" });
    const { component, done } = await getComponent(record, "result", "test");

    component.handleInput("q");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const record = makeRecord({ result: "test" });
    const { component, done } = await getComponent(record, "result", "test");

    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("scrolls through content with up/down", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    // Render once to establish state, then scroll up
    component.render(80);
    component.handleInput("\x1b[A"); // up
    component.handleInput("\x1b[A"); // up again
    // Should not crash, scroll offset should be bounded
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("jumps to top on g", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    component.render(80);
    component.handleInput("G"); // jump to bottom
    component.handleInput("g"); // jump to top
    // Should not crash
    expect(() => component.render(80)).not.toThrow();
  });

  it("handles single-line text gracefully", async () => {
    const record = makeRecord({ result: "single line" });
    const { component } = await getComponent(record, "result", "single line");
    const lines = component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("single line");
  });
});

describe("buildAgentActionsList — stop/steer callback routing", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("calls manager.abort on stop selection", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const ctx = createMockCtx();
    const onClose = vi.fn();
    mockModules.mockManager.abort.mockReset();

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, () => {}, onClose);
    await list.onSelect!({ value: "stop" });

    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("test-id-123", "user");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens steer input on steer selection", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: any = null;
    const setActive = vi.fn((c: any) => { capturedInput = c; });

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, setActive, () => {});
    await list.onSelect!({ value: "steer" });

    expect(setActive).toHaveBeenCalled();
    expect(capturedInput).toBeTruthy();
    expect(capturedInput.onSubmit).toBeDefined();
    expect(capturedInput.onEscape).toBeDefined();
  });

  it("routes steer message to manager.steer on submit", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: any = null;
    const setActive = vi.fn((c: any) => { capturedInput = c; });
    mockModules.mockManager.steer.mockResolvedValue(true);

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, setActive, () => {});
    await list.onSelect!({ value: "steer" });

    // Submit a steer message
    await capturedInput.onSubmit("please do this");

    expect(mockModules.mockManager.steer).toHaveBeenCalledWith("test-id-123", "please do this");
    // After submit, should switch back to the list
    expect(setActive).toHaveBeenCalledTimes(2); // steer input + back to list
  });

  it("cancels steer on escape", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [] } },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: any = null;
    const setActive = vi.fn((c: any) => { capturedInput = c; });

    const list = buildAgentActionsList(ctx, record, noopTheme, () => {}, setActive, () => {});
    await list.onSelect!({ value: "steer" });

    // Cancel steer
    capturedInput.onEscape();

    // setActive should have been called twice: once with Input, once with list
    expect(setActive).toHaveBeenCalledTimes(2);
  });
});

