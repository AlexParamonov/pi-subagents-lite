/**
 * stop-agent-tool.test.ts — Execute behavior tests for the StopAgent tool.
 *
 * Tests the executeStopAgentTool handler with a mocked manager.
 * Schema tests live in index.test.ts (which doesn't mock index.js).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "./fixtures";

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

vi.mock("../src/shell.js", () => shellMock({
  manager: {
    abort: mockAbort,
    getRecord: mockGetRecord,
    listAgents: mockListAgents,
  },
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
