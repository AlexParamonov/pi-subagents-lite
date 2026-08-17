/**
 * stop-agent.test.ts — Tests for executeStopAgentTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "../fixtures.ts";
import { asExtensionContext } from "../pi-boundaries.ts";

const { mockAbort, mockGetRecord, mockListAgents } = vi.hoisted(() => ({
  mockAbort: vi.fn(),
  mockGetRecord: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: {
      abort: mockAbort,
      getRecord: mockGetRecord,
      listAgents: mockListAgents,
    },
  }),
);

import { executeStopAgentTool } from "../../src/agents/tool-execution.js";

describe("executeStopAgentTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns error when agent_id is missing", async () => {
    const result = await executeStopAgentTool("call_1", {}, undefined, undefined, asExtensionContext({}));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("agent_id is required");
  });

  it("stops a running agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "running" },
      execution: {},
      stats: {},
    });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool(
      "call_2",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(mockAbort).toHaveBeenCalledWith("abc123def456ghi", "agent");
    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("stops a queued agent and returns truncated ID", async () => {
    mockGetRecord.mockReturnValue({
      id: "xyz789xyz789abc",
      display: { type: "reviewer" },
      lifecycle: { status: "queued" },
      execution: {},
      stats: {},
    });
    mockAbort.mockReturnValue(true);

    const result = await executeStopAgentTool(
      "call_3",
      { agent_id: "xyz789xyz789abc" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.content[0].text).toMatch(/^Stopped agent [a-z0-9]{8}$/);
    expect(result.isError).toBeFalsy();
  });

  it("returns error when abort fails on a running agent", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "running" },
      execution: {},
      stats: {},
    });
    mockAbort.mockReturnValue(false);

    const result = await executeStopAgentTool(
      "call_9",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Failed to stop agent abc123def456ghi");
  });

  it("returns error when agent ID not found, with running agents list", async () => {
    mockGetRecord.mockReturnValue(undefined);
    mockAbort.mockReturnValue(false);
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "running" } },
    ]);

    const result = await executeStopAgentTool(
      "call_4",
      { agent_id: "nonexistent-id" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("nonexistent-id not found");
    expect(result.content[0].text).toContain("Running agents:");
    expect(result.content[0].text).toContain("aaa111bb (builder)");
  });

  it("returns info when agent already completed", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "completed" },
      execution: {},
      stats: {},
    });
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "explorer" }, lifecycle: { status: "running" } },
    ]);

    const result = await executeStopAgentTool(
      "call_5",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
  });

  it("returns info when agent already stopped", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "stopped" },
      execution: {},
      stats: {},
    });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool(
      "call_6",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already stopped");
  });

  it("returns info when agent already aborted", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "aborted" },
      execution: {},
      stats: {},
    });
    mockListAgents.mockReturnValue([]);

    const result = await executeStopAgentTool(
      "call_7",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already aborted");
  });

  it("running agents list shows only running/queued agents", async () => {
    mockGetRecord.mockReturnValue({
      id: "abc123def456ghi",
      display: { type: "builder" },
      lifecycle: { status: "completed" },
      execution: {},
      stats: {},
    });
    mockListAgents.mockReturnValue([
      { id: "r1", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "r2", display: { type: "reviewer" }, lifecycle: { status: "queued" } },
      { id: "r3", display: { type: "explore" }, lifecycle: { status: "completed" } },
      { id: "r4", display: { type: "code" }, lifecycle: { status: "stopped" } },
    ]);

    const result = await executeStopAgentTool(
      "call_8",
      { agent_id: "abc123def456ghi" },
      undefined,
      undefined,
      asExtensionContext({}),
    );

    expect(result.content[0].text).toContain("r1 (builder)");
    expect(result.content[0].text).toContain("r2 (reviewer)");
    expect(result.content[0].text).not.toContain("r3 (explore)");
    expect(result.content[0].text).not.toContain("r4 (code)");
  });
});
