/**
 * stop-agent.test.ts — Tests for executeStopAgentTool.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { makeAgentRecord, shellMock } from "../fixtures.js";
import { asExtensionContext } from "../pi-boundaries.js";
import type { AgentRecord, AgentStatus } from "../../src/types.js";

const { mockAbort, mockMatchAgents, mockListAgents } = vi.hoisted(() => ({
  mockAbort: vi.fn(),
  mockMatchAgents: vi.fn(),
  mockListAgents: vi.fn(),
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: {
      abort: mockAbort,
      matchAgents: mockMatchAgents,
      listAgents: mockListAgents,
    },
  }),
);

import { executeStopAgentTool } from "../../src/agents/tool-execution.js";

/** Stored ids are 17 characters; tool output shows the first 8. */
const ID = "abc123de-4000-400";
const SHORT_ID = "abc123de";

function agent(status: AgentStatus, id = ID, type = "builder"): AgentRecord {
  return makeAgentRecord({ id, display: { type }, lifecycle: { status } });
}

/** A remote run: `workflow` presence is the kind tag, and a note is the state the endpoint left unclear. */
function workflowRun(status: AgentStatus, note?: string): AgentRecord {
  return makeAgentRecord({
    id: ID,
    display: { type: "audit" },
    lifecycle: { status },
    workflow: {
      name: "audit",
      remoteId: "wf-1",
      progress: [],
      ...(note ? { note } : {}),
    },
  });
}

function stop(params: Record<string, unknown>) {
  return executeStopAgentTool("call_1", params, undefined, undefined, asExtensionContext({}));
}

describe("executeStopAgentTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockListAgents.mockReturnValue([]);
  });

  it("returns error when agent_id is missing", async () => {
    await expect(stop({})).rejects.toThrow("agent_id is required");
  });

  it("rejects a whitespace-only agent_id without resolving it", async () => {
    await expect(stop({ agent_id: "   " })).rejects.toThrow("agent_id is required");
    expect(mockMatchAgents).not.toHaveBeenCalled();
  });

  it("stops a running agent and returns the short ID", async () => {
    mockMatchAgents.mockReturnValue([agent("running")]);
    mockAbort.mockReturnValue(true);

    const result = await stop({ agent_id: ID });

    expect(mockAbort).toHaveBeenCalledWith(ID, "agent");
    expect(result.content[0].text).toBe(`Stopped agent ${SHORT_ID}`);
    expect(result.isError).toBeFalsy();
  });

  it("stops a queued agent", async () => {
    mockMatchAgents.mockReturnValue([agent("queued")]);
    mockAbort.mockReturnValue(true);

    const result = await stop({ agent_id: SHORT_ID });

    expect(result.content[0].text).toBe(`Stopped agent ${SHORT_ID}`);
    expect(result.isError).toBeFalsy();
  });

  it("acts on the matched record when the input is the short id form", async () => {
    mockMatchAgents.mockReturnValue([agent("running")]);
    mockAbort.mockReturnValue(true);

    await stop({ agent_id: SHORT_ID });

    expect(mockMatchAgents).toHaveBeenCalledWith(SHORT_ID);
    expect(mockAbort).toHaveBeenCalledWith(ID, "agent");
  });

  it("returns error when abort fails on a running agent", async () => {
    mockMatchAgents.mockReturnValue([agent("running")]);
    mockAbort.mockReturnValue(false);

    await expect(stop({ agent_id: ID })).rejects.toThrow(`Failed to stop agent ${SHORT_ID}`);
  });

  it("returns error when no agent matches, with the running agents list", async () => {
    mockMatchAgents.mockReturnValue([]);
    mockListAgents.mockReturnValue([
      agent("running", "aaa111bbb222cccdd", "builder"),
      agent("running", "ddd333eee444fffdd", "reviewer"),
    ]);

    await expect(stop({ agent_id: "nonexistent-id" })).rejects.toThrow(
      /nonexistent-id not found.*Running agents:.*aaa111bb \(builder\)/s,
    );
  });

  it("refuses an ambiguous prefix, naming every candidate by full id and stopping none", async () => {
    mockMatchAgents.mockReturnValue([agent("running", "aaaa1111-bbbb-400"), agent("running", "aaaa1111-cccc-400")]);

    await expect(stop({ agent_id: "aaaa1111" })).rejects.toThrow(
      /Ambiguous agent id aaaa1111[\s\S]*aaaa1111-bbbb-400[\s\S]*aaaa1111-cccc-400/,
    );
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("returns info when agent already completed", async () => {
    mockMatchAgents.mockReturnValue([agent("completed")]);

    const result = await stop({ agent_id: ID });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already completed");
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it("returns info when agent already stopped", async () => {
    mockMatchAgents.mockReturnValue([agent("stopped")]);

    const result = await stop({ agent_id: ID });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already stopped");
  });

  it("returns info when agent already aborted", async () => {
    mockMatchAgents.mockReturnValue([agent("aborted")]);

    const result = await stop({ agent_id: ID });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("already aborted");
  });

  it("running agents list shows only running/queued agents", async () => {
    mockMatchAgents.mockReturnValue([agent("completed")]);
    mockListAgents.mockReturnValue([
      agent("running", "r11111111aaaaaaa", "builder"),
      agent("queued", "r22222222bbbbbbb", "reviewer"),
      agent("completed", "r33333333ccccccc", "explore"),
      agent("stopped", "r44444444ddddddd", "code"),
    ]);

    const result = await stop({ agent_id: ID });

    expect(result.content[0].text).toContain("r1111111 (builder)");
    expect(result.content[0].text).toContain("r2222222 (reviewer)");
    expect(result.content[0].text).not.toContain("r3333333 (explore)");
    expect(result.content[0].text).not.toContain("r4444444 (code)");
  });
});

describe("executeStopAgentTool on a workflow run", () => {
  const UNKNOWN_NOTE = `Workflow run ${SHORT_ID} is still running remotely. Its state is unknown after 5 observations.`;

  beforeEach(() => {
    vi.resetAllMocks();
    mockListAgents.mockReturnValue([]);
  });

  it("reports the request and no outcome", async () => {
    mockMatchAgents.mockReturnValue([workflowRun("running")]);
    mockAbort.mockReturnValue(true);

    const result = await stop({ agent_id: ID });

    expect(mockAbort).toHaveBeenCalledWith(ID, "agent");
    expect(result.content[0].text).toContain(`Stop requested for workflow run ${SHORT_ID}`);
    expect(result.content[0].text, "the endpoint's answer, not this call, decides the status").not.toMatch(
      /\bstopp?ed\b/i,
    );
  });

  it("stops a run whose state the endpoint left unclear instead of refusing it", async () => {
    mockMatchAgents.mockReturnValue([workflowRun("running", UNKNOWN_NOTE)]);
    mockAbort.mockReturnValue(true);

    const result = await stop({ agent_id: ID });

    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(`Stop requested for workflow run ${SHORT_ID}`);
  });

  it("takes a second request for a run whose first stop the endpoint refused", async () => {
    const refused = workflowRun("running", `Workflow "audit" ${SHORT_ID}: stop failed - HTTP 409: not running.`);
    mockMatchAgents.mockReturnValue([refused]);
    mockAbort.mockReturnValue(true);

    const first = await stop({ agent_id: ID });
    const retry = await stop({ agent_id: ID });

    expect(mockAbort).toHaveBeenCalledTimes(2);
    expect(retry.content[0].text).toBe(first.content[0].text);
  });

  it("names the settled record as the run it is", async () => {
    mockMatchAgents.mockReturnValue([workflowRun("stopped")]);

    const result = await stop({ agent_id: ID });

    expect(result.content[0].text).toContain(`Workflow run ${SHORT_ID} is already stopped`);
    expect(mockAbort).not.toHaveBeenCalled();
  });
});
