/**
 * nudge-status-message.test.ts — Tests for emitIndividualNudge status message.
 *
 * Verifies that the nudge message sent to the LLM reflects the agent's
 * actual lifecycle status instead of always saying "completed".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentRecord } from "../src/types.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const { mockSendMessage, mockGetRecord, mockGetLifetimeTotal, mockGetSessionContextPercent } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockGetRecord: vi.fn(),
  mockGetLifetimeTotal: vi.fn(() => 0),
  mockGetSessionContextPercent: vi.fn(() => null),
}));

vi.mock("@sinclair/typebox", () => ({
  Type: {
    Object: (p: any, o?: any) => ({ type: "object", properties: p, ...(o || {}) }),
    String: (o?: any) => ({ type: "string", ...(o || {}) }),
    Number: (o?: any) => ({ type: "number", ...(o || {}) }),
    Boolean: (o?: any) => ({ type: "boolean", ...(o || {}) }),
    Optional: (s: any) => ({ ...s, optional: true }),
    Array: (i: any) => ({ type: "array", items: i }),
    Record: (k: any, v: any) => ({ type: "record", keyType: k, valueType: v }),
    Union: (v: any[]) => ({ type: "union", variants: v }),
    Literal: (v: any) => ({ type: "literal", const: v }),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class { children: any[] = []; addChild(c: any) { this.children.push(c); } clear() { this.children = []; } },
  Input: class { onSubmit = null; focused = false; getValue() { return ""; } handleInput(_k: string) {} },
  Spacer: class {},
  Text: class {},
  fuzzyFilter: (items: any[], _q: string, _f: any) => items,
  getKeybindings: () => ({ matches: () => false }),
}));

vi.mock("../src/model-selector.js", () => ({ ModelSelectorDialog: class {} }));
vi.mock("../src/model-precedence.js", () => ({ resolveModel: vi.fn() }));
vi.mock("../src/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => []),
  getAllTypes: vi.fn(() => []),
}));
vi.mock("../src/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue([]),
  mergeAgents: vi.fn().mockReturnValue(new Map()),
  AgentConfigFromMd: {},
}));
vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn() }));
vi.mock("../src/default-agents.js", () => ({ DEFAULT_AGENTS: new Map() }));
vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
  buildStatsParts: vi.fn(),
  formatMs: vi.fn(),
  getDisplayName: vi.fn(),
  SPINNER: [],
  ERROR_STATUSES: new Set(),
}));

vi.mock("../src/usage.js", () => ({
  addUsage: vi.fn(),
  getLifetimeTotal: mockGetLifetimeTotal,
  getSessionContextPercent: mockGetSessionContextPercent,
}));

vi.mock("../src/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(),
}));

vi.mock("../src/state.js", () => ({
  piInstance: { sendMessage: mockSendMessage, exec: vi.fn() },
  sessionCtx: { cwd: "/home/test" },
  agentActivity: new Map(),
  getManager: () => ({
    spawn: vi.fn(),
    getRecord: mockGetRecord,
    listAgents: vi.fn(() => []),
    abort: vi.fn(() => false),
    getTotalAgentCost: vi.fn(() => 0),
  }),
  getWidget: () => ({
    ensureTimer: vi.fn(),
    update: vi.fn(),
    markFinished: vi.fn(),
  }),
  getCoordinator: () => coordinator,
}));

// Import after mocks
import { SpawnCoordinator } from "../src/spawn-coordinator.js";
import type { AgentManager } from "../src/agent-manager.js";

// Create a coordinator instance for tests
const mockManager = {
  getRecord: mockGetRecord,
  listAgents: vi.fn(() => []),
  spawn: vi.fn(),
  abort: vi.fn(() => false),
  getTotalAgentCost: vi.fn(() => 0),
  setOnComplete: vi.fn(),
} as unknown as AgentManager;
const coordinator = new SpawnCoordinator(mockManager, { sendMessage: mockSendMessage, exec: vi.fn() } as any);

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const base: AgentRecord = {
    id: "test-agent-id",
    result: "Some result text",
    lifecycle: {
      status: "completed",
      startedAt: 1000,
      completedAt: 5000,
    },
    display: {
      type: "builder",
      description: "Build something",
    },
    execution: {},
    stats: {
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 },
      toolUses: 5,
      turnCount: 10,
      maxTurns: 25,
      compactionCount: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
    display: { ...base.display, ...overrides.display },
    execution: { ...base.execution, ...overrides.execution },
    stats: { ...base.stats, ...overrides.stats },
  } as AgentRecord;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("emitIndividualNudge — status in message", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses 'completed' when agent completed normally", async () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 } });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain('[Subagent "builder" completed]');
  });

  it("uses 'error' when agent errored", async () => {
    const record = makeRecord({
      result: "Error occurred",
      lifecycle: { status: "error", startedAt: 1000, completedAt: 5000 },
    });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain('[Subagent "builder" error]');
    expect(content).not.toContain("completed");
  });

  it("uses 'aborted' when agent was aborted", async () => {
    const record = makeRecord({
      result: "",
      lifecycle: { status: "aborted", startedAt: 1000, completedAt: 5000 },
    });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain('[Subagent "builder" aborted]');
    expect(content).not.toContain("completed");
  });

  it("uses 'stopped' when agent was stopped", async () => {
    const record = makeRecord({
      result: "",
      lifecycle: { status: "stopped", startedAt: 1000, completedAt: 5000 },
    });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain('[Subagent "builder" stopped]');
    expect(content).not.toContain("completed");
  });

  it("uses 'steered' when agent was steered", async () => {
    const record = makeRecord({
      result: "Steered result",
      lifecycle: { status: "steered", startedAt: 1000, completedAt: 5000 },
    });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain('[Subagent "builder" steered]');
    expect(content).not.toContain("completed");
  });

  it("preserves the result text after the status header", async () => {
    const record = makeRecord({
      result: "Detailed output here",
      lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 },
    });
    mockGetRecord.mockReturnValue(record);

    coordinator.scheduleNudge("test-agent-id");
    await vi.advanceTimersByTimeAsync(300);

    const content = mockSendMessage.mock.calls[0][0].content;
    expect(content).toContain("Detailed output here");
  });
});
