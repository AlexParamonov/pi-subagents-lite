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
const SETTLED: AgentStatus[] = ["completed", "stopped", "error"];

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

  it("steers a running agent and reports the steered distinction", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running" })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toContain("steered");
  });

  it("continues every settled status through its live session, including one the user stopped", async () => {
    for (const status of SETTLED) {
      mockMatchAgents.mockReturnValue([target({ status })]);
      mockSteer.mockClear();

      const result = await message();

      expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
      expect(result.content[0].text).toContain("continued");
    }
  });

  it("accepts a message for a running agent whose session does not exist yet", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running", session: false })]);

    const result = await message();

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
    expect(result.content[0].text).toContain("steered");
  });

  it("reports a settled target with no live session without sending anything", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "completed", session: false })]);

    const result = await message();

    expect(mockSteer).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("completed");
    expect(result.content[0].text).toContain("not sent");
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
      /Ambiguous agent id aaaa1111[\s\S]*aaaa1111-bbbb-400[\s\S]*aaaa1111-cccc-400/,
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
      /ffffffff not found[\s\S]*ddd333ee \(builder\) completed/,
    );
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it("errors when the manager refuses delivery", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "completed" })]);
    mockSteer.mockResolvedValue(false);

    await expect(message()).rejects.toThrow(`Failed to send message to agent ${SHORT_ID}`);
  });

  it("rejects a missing or blank message without resolving the target", async () => {
    for (const value of [undefined, "   "]) {
      await expect(message({ agent_id: ID, message: value })).rejects.toThrow("message is required");
    }
    expect(mockMatchAgents).not.toHaveBeenCalled();
    expect(mockSteer).not.toHaveBeenCalled();
  });

  it("rejects a missing or blank agent_id without resolving it", async () => {
    for (const value of [undefined, "  "]) {
      await expect(message({ agent_id: value, message: MESSAGE })).rejects.toThrow("agent_id is required");
    }
    expect(mockMatchAgents).not.toHaveBeenCalled();
  });

  it("delivers the message text trimmed", async () => {
    mockMatchAgents.mockReturnValue([target({ status: "running" })]);

    await message({ agent_id: ID, message: `  ${MESSAGE}\n` });

    expect(mockSteer).toHaveBeenCalledWith(ID, MESSAGE);
  });
});
