/**
 * message-agent.test.ts — Tests for executeMessageAgentTool.
 *
 * One case per id-resolution outcome, plus the two success reports. Delivery
 * itself is the manager's steer/continue seam; it is faked at that port.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAgentRecord, shellMock } from "../fixtures.js";
import { asAgentSession, asExtensionContext } from "../pi-boundaries.js";
import type { AgentRecord, AgentStatus } from "../../src/types.js";

const { mockSteer, mockMatchAgents, mockListAgents, mockStore } = vi.hoisted(() => ({
  mockSteer: vi.fn(),
  mockMatchAgents: vi.fn(),
  mockListAgents: vi.fn(),
  mockStore: { agent: { agentStatusLimit: 8 } },
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: {
      matchAgents: mockMatchAgents,
      steer: mockSteer,
      listAgents: mockListAgents,
      abort: vi.fn(),
    },
    store: mockStore,
  }),
);

import { executeMessageAgentTool } from "../../src/agents/tool-execution.js";

/** Stored ids are 17 characters; tool output shows the first 8. */
const ID = "abc123de-4000-400";
const SHORT_ID = "abc123de";
const MESSAGE = "use the second index, not the first";

function target(
  overrides: { status: AgentStatus; session?: boolean; id?: string } = { status: "running" },
): AgentRecord {
  return makeAgentRecord({
    id: overrides.id ?? ID,
    lifecycle: { status: overrides.status, completedAt: overrides.status === "running" ? undefined : 5000 },
    execution: {
      settled: overrides.status !== "running",
      settlementCount: overrides.status === "running" ? 0 : 1,
      session: overrides.session === false ? undefined : asAgentSession({ isStreaming: false }),
    },
  });
}

function message(params: Record<string, unknown> = { agent_id: ID, message: MESSAGE }) {
  return executeMessageAgentTool("call_1", params, undefined, undefined, asExtensionContext({}));
}

describe("executeMessageAgentTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockListAgents.mockReturnValue([]);
    mockSteer.mockResolvedValue(true);
    mockStore.agent.agentStatusLimit = 8;
  });

  it("steers a running agent and reports what it queued", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running" })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toBe("Sent (steered)");
  });

  it("continues a settled agent through its live session", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "completed" })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toBe("Sent (continued)");
  });

  it("restarts an agent the user stopped", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "stopped" })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toBe("Sent (continued)");
  });

  it("accepts a message for a running agent whose session does not exist yet", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running", session: false })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toBe("Sent (steered)");
  });

  it("reports a settled target with no live session without sending anything", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "completed", session: false })]);

    const result = await message();

    expect(mockSteer).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe(`Agent ${SHORT_ID} is completed with no live session. Message not sent.`);
  });

  it("acts on the matched record when the input is the short id form", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running" })]);

    await message({ agent_id: SHORT_ID, message: MESSAGE });

    expect(mockMatchAgents).toHaveBeenCalledWith(SHORT_ID);
    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
  });

  it("refuses an ambiguous prefix, naming every candidate by full id and messaging none", async () => {
    mockMatchAgents.mockReturnValue([
      target({ status: "running", id: "aaaa1111-bbbb-400" }),
      target({ status: "running", id: "aaaa1111-cccc-400" }),
    ]);

    await expect(message({ agent_id: "aaaa1111", message: MESSAGE })).rejects.toThrow(
      "Ambiguous agent id aaaa1111. Matching agents: aaaa1111-bbbb-400, aaaa1111-cccc-400. Use a longer id.",
    );
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it("reports an unknown id with a bounded list that includes settled agents", async () => {
    mockMatchAgents.mockReturnValue([]);
    mockListAgents.mockReturnValue([
      target({ status: "running", id: "aaa111bbb222cccdd" }),
      target({ status: "completed", id: "ddd333eee444fffdd" }),
    ]);

    await expect(message({ agent_id: "ffffffff", message: MESSAGE })).rejects.toThrow(
      "Agent ffffffff not found. Known agents: aaa111bb (builder) running, ddd333ee (builder) completed",
    );
  });

  it("bounds the settled agents it lists for an unknown id", async () => {
    mockMatchAgents.mockReturnValue([]);
    mockStore.agent.agentStatusLimit = 1;
    mockListAgents.mockReturnValue([
      target({ status: "completed", id: "ccc333ccc333cccdd" }),
      target({ status: "completed", id: "ddd444ddd444dddde" }),
    ]);

    await expect(message({ agent_id: "ffffffff", message: MESSAGE })).rejects.toThrow(
      "Agent ffffffff not found. Known agents: ccc333cc (builder) completed\nand 1 more settled agents",
    );
  });

  it("lists no agents for an unknown id when none exist", async () => {
    mockMatchAgents.mockReturnValue([]);

    await expect(message({ agent_id: "ffffffff", message: MESSAGE })).rejects.toThrow(
      "Agent ffffffff not found. Known agents: none",
    );
  });

  it("errors when the manager refuses delivery", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "completed" })]);
    mockSteer.mockResolvedValue(false);

    await expect(message()).rejects.toThrow(
      `Failed to send message to agent ${SHORT_ID}. It may still be settling or its concurrency slot is full. Try again.`,
    );
  });

  it("rejects a missing message before resolving the target", async () => {
    await expect(message({ agent_id: ID })).rejects.toThrow("message is required");
    expect(mockMatchAgents).not.toHaveBeenCalled();
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it("rejects a blank message before any delivery", async () => {
    await expect(message({ agent_id: ID, message: "   " })).rejects.toThrow("message is required");
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it("rejects a missing agent_id", async () => {
    await expect(message({ message: MESSAGE })).rejects.toThrow("agent_id is required");
  });

  it("rejects a whitespace-only agent_id without resolving it", async () => {
    await expect(message({ agent_id: "  ", message: MESSAGE })).rejects.toThrow("agent_id is required");
    expect(mockMatchAgents).not.toHaveBeenCalled();
  });

  it("delivers the message text trimmed", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running" })]);

    await message({ agent_id: ID, message: `  ${MESSAGE}\n` });

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
  });
});
