/**
 * menu-running-agents.test.ts — Tests for showRunningAgentsMenu using SelectList.
 *
 * Uses ctx.ui.custom (not ctx.ui.select/runMenuLoop).
 * The running agents menu is a SelectList with dynamic agent entries.
 * Selecting an agent opens an actions submenu (also SelectList).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx, type ComponentFactory } from "../../menu-test-helpers.js";
import { asAgentSession, selectListView } from "../../pi-boundaries.js";
import type { AgentRecord, AgentDisplayInfo, AgentExecutionState, AgentLifecycle } from "../../../src/types.js";
import type { Theme } from "../../../src/ui/types.js";
import type { Component, Input, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";

/** The mocked SelectList surface the tests drive: the items the menu built
 * plus the selection state the navigation tests step by hand. */
interface SelectListCapture {
  items: SelectItem[];
  maxVisible: number;
  selectedIndex: number;
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}

// Capture SelectList constructor calls
let selectListCalls: SelectListCapture[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor() {}
  },
  SelectList: class MockSelectList {
    items: SelectItem[];
    maxVisible: number;
    selectedIndex = 0;
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    constructor(items: SelectItem[], maxVisible: number, _theme: SelectListTheme) {
      this.items = items;
      this.maxVisible = maxVisible;
      selectListCalls.push(this);
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
  truncateToWidth: vi.fn((s: string, w: number) => (s.length > w ? s.slice(0, w - 3) + "..." : s)),
  visibleWidth: vi.fn((s: string) => s.length),
}));

// Import AFTER mock setup
import { showRunningAgentsMenu, buildAgentActionsList } from "../../../src/ui/menu/menu-running-agents.js";

/** Nested-partial overrides the record factory merges over its base record. */
interface RecordOverrides {
  id?: string;
  display?: Partial<AgentDisplayInfo>;
  lifecycle?: Partial<AgentLifecycle>;
  execution?: Partial<AgentExecutionState>;
  result?: string;
  error?: string;
}

/** A session handle the menu only checks for truthiness; the real
 * ConversationViewer (never constructed here) would consume it. */
function makeMockSession(messages: { role: string; content: string }[]) {
  return asAgentSession({ messages, subscribe: vi.fn(() => () => {}) });
}

function makeRecord(overrides: RecordOverrides = {}): AgentRecord {
  const base: AgentRecord = {
    id: "test-id-123",
    display: { type: "general-purpose", description: "Test agent" },
    lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000, started: true },
    execution: { settled: false, settlementCount: 0 },
    result: "some result",
    error: "",
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 10,
      turnCount: 15,
      compactionCount: 0,
    },
  };
  return {
    ...base,
    ...overrides,
    display: { ...base.display, ...overrides.display },
    lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
    execution: { ...base.execution, ...overrides.execution },
  };
}
const noopTheme: Theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

/** The factory's unknown return narrowed at the render boundary: the real
 * showTextViewer builds a plain Component the tests render and feed keys to. */
function asComponent(component: unknown): Component {
  return component as Component;
}

/** The steer branch hands the delegator a pi-tui Input; assert it at the
 * setActive boundary, where Component is the wider declared type. */
function asInput(component: Component): Input {
  return component as Input;
}

afterEach(() => resetConfig());

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
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No agents have been spawned this session"),
      "info",
    );
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
    // Bulk rows (separator, Clear all / Clear done) follow the agent entries
    const agentItems = selectListCalls[0].items.filter((i) => i.value.startsWith("agent-"));
    expect(agentItems.map((i) => i.value)).toEqual(["agent-1", "agent-2"]);
  });

  it("includes agent type in label", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "Test" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    expect(selectListCalls[0].items[0].label).toContain("general-purpose");
  });

  it("uses agentBulletPrefix for agent labels (plain type name, no agent color)", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", display: { type: "general-purpose", description: "Test" } }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    // agentBulletPrefix returns "" in mock setup, but the label should still contain the type name
    const label = selectListCalls[0].items[0].label as string;
    expect(label).toContain("general-purpose");
  });
});

describe("showRunningAgentsMenu — __sep__ navigation skip", () => {
  // Mirrors the pi-tui SelectList handleInput wrap-around writes: up is
  // cur === 0 ? len-1 : cur-1, down is cur === len-1 ? 0 : cur+1.
  function pressUp(list: SelectListCapture) {
    const len = list.items.length;
    list.selectedIndex = list.selectedIndex === 0 ? len - 1 : list.selectedIndex - 1;
  }
  function pressDown(list: SelectListCapture) {
    const len = list.items.length;
    list.selectedIndex = list.selectedIndex === len - 1 ? 0 : list.selectedIndex + 1;
  }

  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents
      .mockReset()
      .mockReturnValue([
        makeRecord({ id: "agent-1", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-3", lifecycle: { status: "completed", startedAt: Date.now() - 20000 } }),
      ]);
  });

  // Open the menu and return the agent list, mirroring the real SelectList
  // whose class field initializes selectedIndex to 0.
  async function openMenu() {
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    const list = selectListCalls[0];
    list.selectedIndex = 0;
    return list;
  }

  it("never lands on a __sep__ row while sweeping down the whole list", async () => {
    const list = await openMenu();
    const seps = new Set(list.items.map((i, idx) => (i.value === "__sep__" ? idx : -1)));
    for (let step = 0; step < 3 * list.items.length; step++) {
      pressDown(list);
      expect(seps.has(list.selectedIndex)).toBe(false);
    }
  });

  it("moving down from the last agent lands on the first bulk action row", async () => {
    const list = await openMenu();
    pressDown(list); // agent-1
    pressDown(list); // agent-2
    pressDown(list); // agent-3, then sep is skipped
    expect(list.items[list.selectedIndex].value).toBe("__stop-all");
  });

  it("moving up from a bulk action row lands on the last agent", async () => {
    const list = await openMenu();
    list.selectedIndex = 4; // __stop-all
    pressUp(list); // hits the sep, skips back to the last agent
    expect(list.items[list.selectedIndex].value).toBe("agent-3");
  });

  it("wrap-around up from the first item lands on the last real item", async () => {
    const list = await openMenu();
    pressUp(list); // library writes len-1
    expect(list.items[list.selectedIndex].value).toBe("__clear-all");
  });

  it("wrap-around down from the last item lands on the first agent", async () => {
    const list = await openMenu();
    list.selectedIndex = list.items.length - 1; // __clear-all
    pressDown(list); // library writes 0
    expect(list.items[list.selectedIndex].value).toBe("agent-1");
  });

  it("the skipped-to bulk row is still selectable and performs its action", async () => {
    const list = await openMenu();
    pressDown(list);
    pressDown(list);
    pressDown(list); // lands on __stop-all past the sep
    await list.onSelect!(list.items[list.selectedIndex]);
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("agent-1", "user");
  });
});

describe("buildAgentActionsList — actions submenu", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("shows View result action for completed agent with result", () => {
    const list = buildAgentActionsList(
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-result");
  });

  it("shows View error action for agent with error", () => {
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-error");
  });

  it("shows View snapshot action for running agent with session", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-snapshot");
  });

  it("shows Steer and Stop actions for running agent", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("steer");
    expect(values).toContain("stop");
  });

  it("does not show Steer/Stop for completed agent", () => {
    const list = buildAgentActionsList(
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
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
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({ result: "hello world\nline 2" });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-result", label: "View result" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens text viewer when selecting view-error", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "error", startedAt: Date.now() - 30000 },
      result: "",
      error: "something went wrong",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-error", label: "View error" });

    expect(capturedFactory).toBeDefined();
  });

  it("opens ConversationViewer when selecting view-snapshot", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-snapshot", label: "View snapshot" });

    expect(capturedFactory).toBeDefined();
  });
});

describe("showTextViewer — component behavior", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  async function getComponent(record: AgentRecord, kind: "result" | "error", text: string) {
    let factory: ComponentFactory | null = null;
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (f) => {
          factory = f;
          return undefined;
        }),
      },
    });
    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({
      value: kind === "result" ? "view-result" : "view-error",
      label: kind === "result" ? "View result" : "View error",
    });
    // Invoke the factory to get the component
    const doneFn = vi.fn();
    const component = asComponent(
      factory!({ terminal: { rows: 40 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, null, doneFn),
    );
    return { component, done: doneFn };
  }

  it("renders border frame with title", async () => {
    const record = makeRecord({ result: "hello world\nline 2" });
    const { component } = await getComponent(record, "result", "hello world\nline 2");
    const lines = component.render(80);

    expect(lines[0].startsWith("\u256d")).toBe(true); // ╭ top-left corner
    const bottom = lines[lines.length - 1];
    expect(bottom.startsWith("\u2570")).toBe(true); // ╰ bottom-left corner
    expect(bottom.endsWith("\u256f")).toBe(true); // ╯ bottom-right corner
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

    component.handleInput!("q");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const record = makeRecord({ result: "test" });
    const { component, done } = await getComponent(record, "result", "test");

    component.handleInput!("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("scrolls through content with up/down", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    // Initial render auto-scrolls to the bottom of the content
    const initial = component.render(80).join("\n");
    expect(initial).toContain("line 49");

    // Up scrolls the visible window toward the top
    component.handleInput!("\x1b[A"); // up
    component.handleInput!("\x1b[A"); // up again
    const scrolledUp = component.render(80).join("\n");
    expect(scrolledUp).toContain("line 25");
    expect(scrolledUp).not.toContain("line 49");

    // Down scrolls back toward the bottom
    component.handleInput!("\x1b[B"); // down
    const scrolledDown = component.render(80).join("\n");
    expect(scrolledDown).toContain("line 48");
    expect(scrolledDown).not.toContain("line 25");
  });

  it("jumps to top on g", async () => {
    const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const record = makeRecord({ result: longText });
    const { component } = await getComponent(record, "result", longText);

    component.render(80); // auto-scrolls to bottom
    component.handleInput!("G"); // jump to bottom
    // Last content line stays visible after G
    expect(component.render(80).join("\n")).toContain("line 49");

    component.handleInput!("g"); // jump to top
    const text = component.render(80).join("\n");
    expect(text).toContain("line 0");
    expect(text).not.toContain("line 49");
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
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const ctx = createMockCtx();
    const onClose = vi.fn();
    mockModules.mockManager.abort.mockReset();

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      onClose,
    );
    await list.onSelect!({ value: "stop", label: "Stop" });

    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("test-id-123", "user");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens steer input on steer selection", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: Input | null = null;
    const setActive = vi.fn((c: Component) => {
      capturedInput = asInput(c);
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      setActive,
      () => {},
    );
    await list.onSelect!({ value: "steer", label: "Steer" });

    expect(setActive).toHaveBeenCalled();
    expect(capturedInput).toBeTruthy();
    expect(capturedInput!.onSubmit).toBeDefined();
    expect(capturedInput!.onEscape).toBeDefined();
  });

  it("routes steer message to manager.steer on submit", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: Input | null = null;
    const setActive = vi.fn((c: Component) => {
      capturedInput = asInput(c);
    });
    mockModules.mockManager.steer.mockResolvedValue(true);

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      setActive,
      () => {},
    );
    await list.onSelect!({ value: "steer", label: "Steer" });

    // Submit a steer message
    await capturedInput!.onSubmit!("please do this");

    expect(mockModules.mockManager.steer).toHaveBeenCalledWith("test-id-123", "please do this");
    // After submit, should switch back to the list
    expect(setActive).toHaveBeenCalledTimes(2); // steer input + back to list
  });

  it("cancels steer on escape", async () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([]) },
      result: "",
    });
    const ctx = createMockCtx();
    let capturedInput: Input | null = null;
    const setActive = vi.fn((c: Component) => {
      capturedInput = asInput(c);
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      setActive,
      () => {},
    );
    await list.onSelect!({ value: "steer", label: "Steer" });

    // Cancel steer
    capturedInput!.onEscape!();

    // setActive should have been called twice: once with Input, once with list
    expect(setActive).toHaveBeenCalledTimes(2);
  });
});

describe("buildAgentActionsList — completed agent with session", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
  });

  it("shows View conversation action for completed agent with session", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
  });

  it("shows View conversation for completed agent without result", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
  });

  it("does not show View conversation for completed agent without session", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: {},
      result: "done",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).not.toContain("view-conversation");
  });

  it("does not show View conversation for running agent (still View snapshot)", () => {
    const record = makeRecord({
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).not.toContain("view-conversation");
    expect(values).toContain("view-snapshot");
  });

  it("opens ConversationViewer when selecting view-conversation", async () => {
    let capturedFactory: ComponentFactory | null = null;
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const ctx = createMockCtx([], [], [], {
      ui: {
        custom: vi.fn(async (factory) => {
          capturedFactory = factory;
          return undefined;
        }),
      },
    });

    const list = buildAgentActionsList(
      ctx,
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    await list.onSelect!({ value: "view-conversation", label: "View conversation" });

    expect(capturedFactory).toBeDefined();
    expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true });
  });

  it("shows both View conversation and View result for completed agent with session and result", () => {
    const record = makeRecord({
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: makeMockSession([{ role: "user", content: "hi" }]) },
      result: "done",
    });
    const list = buildAgentActionsList(
      createMockCtx(),
      record,
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("view-conversation");
    expect(values).toContain("view-result");
  });
});

describe("clear actions for finished agents", () => {
  beforeEach(() => {
    selectListCalls = [];
    vi.clearAllMocks();
    mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
    mockModules.mockManager.clear.mockReset();
    mockModules.mockManager.abort.mockReset();
  });

  it("shows a Clear action for finished records", () => {
    const list = buildAgentActionsList(
      createMockCtx(),
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      () => {},
    );
    const values = selectListView(list).items.map((i) => i.value);
    expect(values).toContain("clear");
  });

  it("does not show a Clear action for running or queued records", () => {
    for (const status of ["running", "queued"] as const) {
      const list = buildAgentActionsList(
        createMockCtx(),
        makeRecord({
          lifecycle: { status, startedAt: Date.now() - 20000 },
          execution: { session: makeMockSession([]) },
          result: "",
        }),
        noopTheme,
        () => {},
        () => {},
        () => {},
      );
      const values = selectListView(list).items.map((i) => i.value);
      expect(values).not.toContain("clear");
      expect(values).toContain("stop");
    }
  });

  it("clears the record through the manager when Clear is selected", async () => {
    const ctx = createMockCtx();
    const onClose = vi.fn();
    const list = buildAgentActionsList(
      ctx,
      makeRecord(),
      noopTheme,
      () => {},
      () => {},
      onClose,
    );
    await list.onSelect!({ value: "clear", label: "Clear" });
    expect(mockModules.mockManager.clear).toHaveBeenCalledWith("test-id-123");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a Clear all row when finished records exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
  });

  it("hides both bulk clear rows when only active records exist", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "queued", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).not.toContain("Clear all");
    expect(labels).not.toContain("Clear done");
  });

  it("Clear all removes every terminal record and leaves active ones", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "error", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-4", lifecycle: { status: "turn_limited", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-5", lifecycle: { status: "aborted", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-6", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Clear all")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    for (const id of ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"]) {
      expect(mockModules.mockManager.clear).toHaveBeenCalledWith(id);
    }
    expect(mockModules.mockManager.clear).not.toHaveBeenCalledWith("agent-6");
  });

  it("shows a Clear done row when a completed record exists", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
    expect(labels).toContain("Clear done");
  });

  it("hides Clear done when no completed record exists", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);
    const labels = selectListCalls[0].items.map((i) => i.label);
    expect(labels).toContain("Clear all");
    expect(labels).not.toContain("Clear done");
  });

  it("Clear done removes only completed records", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "error", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-4", lifecycle: { status: "turn_limited", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-5", lifecycle: { status: "aborted", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-6", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Clear done")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    expect(mockModules.mockManager.clear).toHaveBeenCalledWith("agent-1");
    for (const id of ["agent-2", "agent-3", "agent-4", "agent-5", "agent-6"]) {
      expect(mockModules.mockManager.clear).not.toHaveBeenCalledWith(id);
    }
  });

  it("Stop all running row stops active records and leaves terminal ones", async () => {
    mockModules.mockManager.listAgents.mockReturnValue([
      makeRecord({ id: "agent-1" }), // completed
      makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      makeRecord({ id: "agent-3", lifecycle: { status: "queued", startedAt: Date.now() - 20000 }, result: "" }),
    ]);
    const ctx = createMockCtx();
    await showRunningAgentsMenu(ctx);

    const row = selectListCalls[0].items.find((i) => i.label === "Stop 2 running agent(s)")!;
    expect(row).toBeDefined();

    const list = selectListCalls[0];
    await list.onSelect!(row);
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("agent-2", "user");
    expect(mockModules.mockManager.abort).toHaveBeenCalledWith("agent-3", "user");
    expect(mockModules.mockManager.abort).not.toHaveBeenCalledWith("agent-1", "user");
  });

  describe("bulk action row ordering", () => {
    beforeEach(() => {
      selectListCalls = [];
      vi.clearAllMocks();
      mockModules.mockManager.listAgents.mockReset().mockReturnValue([]);
      mockModules.mockManager.clear.mockReset();
      mockModules.mockManager.abort.mockReset();
    });

    it("orders bulk rows: stop group, then clear group with Clear done before Clear all", async () => {
      mockModules.mockManager.listAgents.mockReturnValue([
        makeRecord({ id: "agent-1" }), // completed
        makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-3", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
      ]);
      const ctx = createMockCtx();
      await showRunningAgentsMenu(ctx);
      const values = selectListCalls[0].items.map((i) => i.value);
      expect(values).toEqual([
        "agent-1",
        "agent-2",
        "agent-3",
        "__sep__",
        "__stop-all",
        "__sep__",
        "__clear-done",
        "__clear-all",
      ]);
    });

    it("shows only Clear all in the clear group when no completed agents exist", async () => {
      mockModules.mockManager.listAgents.mockReturnValue([
        makeRecord({ id: "agent-1", lifecycle: { status: "stopped", startedAt: Date.now() - 20000 }, result: "" }),
        makeRecord({ id: "agent-2", lifecycle: { status: "running", startedAt: Date.now() - 20000 }, result: "" }),
      ]);
      const ctx = createMockCtx();
      await showRunningAgentsMenu(ctx);
      const values = selectListCalls[0].items.map((i) => i.value);
      expect(values).toEqual(["agent-1", "agent-2", "__sep__", "__stop-all", "__sep__", "__clear-all"]);
    });
  });
});
