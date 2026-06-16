/**
 * stop-agent-tool.test.ts — Execute behavior tests for the StopAgent tool.
 *
 * Tests the executeStopAgentTool handler with a mocked manager.
 * Schema tests live in index.test.ts (which doesn't mock index.js).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Module-level mock variables — defined before vi.mock calls so they  */
/*  are available when hoisted mock factories run.                      */
/* ------------------------------------------------------------------ */

const mockAbort = vi.fn();
const mockGetRecord = vi.fn();
const mockListAgents = vi.fn();

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("@sinclair/typebox", () => {
  const createType = (type: string) => (opts?: any) => ({
    type,
    ...(opts || {}),
  });

  return {
    Type: {
      Object: (properties: Record<string, any>, opts?: any) => ({
        type: "object",
        properties,
        ...(opts || {}),
      }),
      String: createType("string"),
      Number: createType("number"),
      Boolean: createType("boolean"),
      Optional: (schema: any) => ({ ...schema, optional: true }),
      Array: (items: any) => ({ type: "array", items }),
      Record: (keyType: any, valueType: any) => ({
        type: "record",
        keyType,
        valueType,
      }),
      Union: (variants: any[]) => ({ type: "union", variants }),
      Literal: (value: string | number | boolean) => ({
        type: "literal",
        const: value,
      }),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: any[] = [];
    addChild(c: any) { this.children.push(c); }
    clear() { this.children = []; }
  },
  Input: class {
    onSubmit: (() => void) | null = null;
    focused = false;
    getValue() { return ""; }
    handleInput(_k: string) {}
  },
  Spacer: class {},
  Text: class {},
  fuzzyFilter: (items: any[], _query: string, _fn: any) => items,
  getKeybindings: () => ({ matches: () => false }),
}));

vi.mock("../src/model-selector.js", () => ({
  ModelSelectorDialog: class {},
}));

vi.mock("../src/model-precedence.js", () => ({
  resolveModel: vi.fn((_type, _config, _cfg, parentModel: string) => parentModel),
}));

vi.mock("../src/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
}));

vi.mock("../src/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue([]),
  mergeAgents: vi.fn().mockReturnValue(new Map()),
  AgentConfigFromMd: {},
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../src/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
  formatTokens: vi.fn(),
  formatTurns: vi.fn(),
  formatMs: vi.fn(),
  describeActivity: vi.fn(),
  getDisplayName: vi.fn(),
  buildInvocationTags: vi.fn(),
  formatSessionTokens: vi.fn(),
  formatDuration: vi.fn(),
  SPINNER: [],
  ERROR_STATUSES: new Set(),
}));

// Mock the shell module so executeStopAgentTool gets a fake manager
vi.mock("../src/shell.js", () => ({
  getShell: () => ({
    manager: {
      abort: mockAbort,
      getRecord: mockGetRecord,
      listAgents: mockListAgents,
    },
  }),
  getManager: () => ({
    abort: mockAbort,
    getRecord: mockGetRecord,
    listAgents: mockListAgents,
  }),
  getPiInstance: () => ({}),
  getSessionCtx: () => ({ cwd: "/home/test" }),
  getStore: () => ({
    agent: { graceTurns: 6, forceBackground: false, showCost: false },
    modelFor: () => "",
  }),
  getCoordinator: () => ({ spawn: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/*  Execute behavior tests                                            */
/* ------------------------------------------------------------------ */

describe("StopAgent tool execute behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops a running agent and returns truncated ID", async () => {
    const record = { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);
    mockAbort.mockReturnValue(true);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_1",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      {} as any,
    );

    expect(mockGetRecord).toHaveBeenCalledWith("abc123def456ghi");
    expect(mockAbort).toHaveBeenCalledWith("abc123def456ghi");
    expect(result.content[0].text).toBe("Stopped agent abc123de");
    expect(result.isError).toBeFalsy();
  });

  it("stops a queued agent and returns truncated ID", async () => {
    const record = { id: "xyz789xyz789abc", display: { type: "reviewer" }, lifecycle: { status: "queued" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);
    mockAbort.mockReturnValue(true);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_2",
      { agent_id: "xyz789xyz789abc" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toBe("Stopped agent xyz789xy");
    expect(result.isError).toBeFalsy();
  });

  it("returns error when agent ID not found, with running agents list", async () => {
    mockGetRecord.mockReturnValue(undefined);
    mockAbort.mockReturnValue(false);

    // Running agents list for the error
    const runningAgents = [
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "running" } },
    ];
    mockListAgents.mockReturnValue(runningAgents);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_3",
      { agent_id: "nonexistent-id" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent-id not found");
    expect(result.content[0].text).toContain("Running agents:");
    expect(result.content[0].text).toContain("builder·aaa111bb");
    expect(result.content[0].text).toContain("reviewer·ddd333ee");
  });

  it("returns info (not error) when agent already completed, with running agents list", async () => {
    const record = { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "completed" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);

    const runningAgents = [
      { id: "aaa111bbb222ccc", display: { type: "explorer" }, lifecycle: { status: "running" } },
    ];
    mockListAgents.mockReturnValue(runningAgents);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_4",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      {} as any,
    );

    // Already completed → info, not error
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
    expect(result.content[0].text).toContain("Running agents:");
    expect(result.content[0].text).toContain("explorer·aaa111bb");
  });

  it("returns info (not error) when agent already stopped", async () => {
    const record = { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "stopped" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);

    const runningAgents: Array<{ id: string; display: { type: string }; lifecycle: { status: string } }> = [];
    mockListAgents.mockReturnValue(runningAgents);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_5",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already stopped");
    expect(result.content[0].text).toContain("Running agents: none");
  });

  it("returns info when agent already aborted", async () => {
    const record = { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "aborted" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);

    const runningAgents: Array<{ id: string; display: { type: string }; lifecycle: { status: string } }> = [];
    mockListAgents.mockReturnValue(runningAgents);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_6",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already aborted");
    expect(result.content[0].text).toContain("Running agents: none");
  });

  it("running agents list shows only running/queued agents", async () => {
    const record = { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "completed" }, execution: {}, stats: {} };
    mockGetRecord.mockReturnValue(record);

    // Mix of statuses — only running/queued should appear in the list
    const allAgents = [
      { id: "r1", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "r2", display: { type: "reviewer" }, lifecycle: { status: "queued" } },
      { id: "r3", display: { type: "explore" }, lifecycle: { status: "completed" } },
      { id: "r4", display: { type: "code" }, lifecycle: { status: "stopped" } },
    ];
    mockListAgents.mockReturnValue(allAgents);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_7",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("builder·r1");
    expect(result.content[0].text).toContain("reviewer·r2");
    expect(result.content[0].text).not.toContain("explore·r3");
    expect(result.content[0].text).not.toContain("code·r4");
  });

  it("returns error result when agent_id is missing", async () => {
    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_8",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("agent_id is required");
  });
});
