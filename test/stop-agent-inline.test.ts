/**
 * stop-agent-inline.test.ts — Acceptance tests for slice 2: inline-stop-agent.
 *
 * Verifies:
 *   - src/stop-agent-tool.ts has been deleted
 *   - executeStopAgentTool is exported from tool-execution.ts
 *   - index.ts imports executeStopAgentTool from tool-execution.ts
 *   - Behavior is preserved after inlining
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

/* ------------------------------------------------------------------ */
/*  Mock definitions (available to vi.mock hoisted factories)         */
/* ------------------------------------------------------------------ */

const { mockAbort, mockGetRecord, mockListAgents } = vi.hoisted(() => ({
  mockAbort: vi.fn(),
  mockGetRecord: vi.fn(),
  mockListAgents: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("@sinclair/typebox", () => {
  const createType = (type: string) => (opts?: any) => ({ type, ...(opts || {}) });
  return {
    Type: {
      Object: (properties: Record<string, any>, opts?: any) => ({ type: "object", properties, ...(opts || {}) }),
      String: createType("string"),
      Number: createType("number"),
      Boolean: createType("boolean"),
      Optional: (schema: any) => ({ ...schema, optional: true }),
      Array: (items: any) => ({ type: "array", items }),
      Record: (keyType: any, valueType: any) => ({ type: "record", keyType, valueType }),
      Union: (variants: any[]) => ({ type: "union", variants }),
      Literal: (value: string | number | boolean) => ({ type: "literal", const: value }),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class { children: any[] = []; addChild(c: any) { this.children.push(c); } clear() { this.children = []; } },
  Input: class { onSubmit: (() => void) | null = null; focused = false; getValue() { return ""; } handleInput(_k: string) {} },
  Spacer: class {},
  Text: class {},
  fuzzyFilter: (items: any[], _query: string, _fn: any) => items,
  getKeybindings: () => ({ matches: () => false }),
}));

vi.mock("../src/model-selector.js", () => ({ ModelSelectorDialog: class {} }));
vi.mock("../src/model-precedence.js", () => ({
  resolveModel: vi.fn((_type: any, _config: any, _cfg: any, parentModel: string) => parentModel),
}));
vi.mock("../src/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  discoverNewAgents: vi.fn(),
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

vi.mock("../src/shell.js", () => ({
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
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("inline-stop-agent — module structure", () => {
  it("src/stop-agent-tool.ts has been deleted", () => {
    expect(fs.existsSync("src/stop-agent-tool.ts")).toBe(false);
  });

  it("executeStopAgentTool is exported from tool-execution.ts", async () => {
    const mod = await import("../src/tool-execution.js");
    expect(typeof mod.executeStopAgentTool).toBe("function");
  });

  it("index.ts imports executeStopAgentTool from tool-execution.ts", () => {
    const indexSrc = fs.readFileSync("src/index.ts", "utf-8");
    const hasImportFromToolExecution = indexSrc.includes("executeStopAgentTool") &&
      (indexSrc.includes('from "./tool-execution.js"') || indexSrc.includes("from './tool-execution.js'"));
    const hasImportFromStopAgent = indexSrc.includes('from "./stop-agent-tool.js"') ||
                                    indexSrc.includes("from './stop-agent-tool.js'");
    expect(hasImportFromToolExecution).toBe(true);
    expect(hasImportFromStopAgent).toBe(false);
  });
});

describe("inline-stop-agent — behavior preserved", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("returns error when agent_id is missing", async () => {
    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_1", {}, undefined, undefined, {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("agent_id is required");
  });

  it("stops a running agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", lifecycle: { status: "running" } });
    mockAbort.mockReturnValue(true);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_2", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any,
    );

    expect(mockAbort).toHaveBeenCalledWith("abc123def456ghi");
    expect(result.content[0].text).toBe("Stopped agent abc123de");
    expect(result.isError).toBeFalsy();
  });

  it("returns error when agent not found, with running agents list", async () => {
    mockGetRecord.mockReturnValue(undefined);
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
    ]);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_3", { agent_id: "nonexistent" }, undefined, undefined, {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent not found");
    expect(result.content[0].text).toContain("builder·aaa111bb");
  });

  it("returns info (not error) when agent already completed", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", type: "builder", lifecycle: { status: "completed" } });
    mockListAgents.mockReturnValue([]);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_4", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
  });

  it("running agents list shows only running/queued agents", async () => {
    mockGetRecord.mockReturnValue({ id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "completed" } });
    mockListAgents.mockReturnValue([
      { id: "r1", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "r2", display: { type: "reviewer" }, lifecycle: { status: "queued" } },
      { id: "r3", display: { type: "explore" }, lifecycle: { status: "completed" } },
    ]);

    const { executeStopAgentTool } = await import("../src/tool-execution.js");

    const result = await executeStopAgentTool(
      "call_5", { agent_id: "abc123def456ghi" }, undefined, undefined, {} as any,
    );

    expect(result.content[0].text).toContain("builder·r1");
    expect(result.content[0].text).toContain("reviewer·r2");
    expect(result.content[0].text).not.toContain("explore·r3");
  });
});
