/**
 * agent-status-tool.test.ts — Execute behavior tests for the AgentStatus tool.
 *
 * Tests the executeAgentStatusTool handler with a mocked manager.
 * Schema tests live in index.test.ts (which doesn't mock index.js).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Module-level mock variables — defined before vi.mock calls so they  */
/*  are available when hoisted mock factories run.                      */
/* ------------------------------------------------------------------ */

const mockListAgents = vi.fn();

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("../../src/shell.js", () => shellMock({
  manager: { listAgents: mockListAgents },
}));

/* ------------------------------------------------------------------ */
/*  Execute behavior tests                                            */
/* ------------------------------------------------------------------ */

describe("AgentStatus tool execute behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty state message when no agents exist", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_1",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("No agents");
    expect(result.content[0].text).toContain("Don't poll");
    expect(result.isError).toBeUndefined();
  });

  it("formats each agent as {shortId} ({type}) {status}", async () => {
    mockListAgents.mockReturnValue([
      { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_2",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    // Contract: agent entries use "id (type) status" format, short ID is 8 chars
    expect(text).toMatch(/[a-z0-9]{8} \(builder\) running/);
    expect(text).toContain("Don't poll");
  });

  it("separates multiple agents with commas", async () => {
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_3",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    // Contract: multiple agents comma-separated, each matching the format
    expect(text).toMatch(/[a-z0-9]{8} \(builder\) running, [a-z0-9]{8} \(reviewer\) completed/);
    expect(text).toContain("Don't poll");
  });

  it("renders all status types in the output", async () => {
    mockListAgents.mockReturnValue([
      { id: "id1", display: { type: "a" }, lifecycle: { status: "running" } },
      { id: "id2", display: { type: "b" }, lifecycle: { status: "queued" } },
      { id: "id3", display: { type: "c" }, lifecycle: { status: "completed" } },
      { id: "id4", display: { type: "d" }, lifecycle: { status: "stopped" } },
      { id: "id5", display: { type: "e" }, lifecycle: { status: "error" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_4",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    // Contract: each agent entry matches the format pattern with its status
    expect(text).toMatch(/id1 \(a\) running/);
    expect(text).toMatch(/id2 \(b\) queued/);
    expect(text).toMatch(/id3 \(c\) completed/);
    expect(text).toMatch(/id4 \(d\) stopped/);
    expect(text).toMatch(/id5 \(e\) error/);
    expect(text).toContain("Don't poll");
  });

  it("always includes nudge message", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_5",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("Don't poll — you'll receive notifications when agents complete.");
  });

  it("truncates long IDs to 8 characters", async () => {
    mockListAgents.mockReturnValue([
      { id: "a-very-long-agent-id-that-exceeds-short-length", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_6",
      {},
      undefined,
      undefined,
      undefined,
      {} as any,
    );

    // Contract: short ID is always 8 characters
    expect(result.content[0].text).toMatch(/[a-z0-9-]{8} \(reviewer\) completed/);
  });

  it("returns no error flag on success", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../../src/agents/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_7",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBeUndefined();
  });
});
