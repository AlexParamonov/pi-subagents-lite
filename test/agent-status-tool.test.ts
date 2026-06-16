/**
 * agent-status-tool.test.ts — Execute behavior tests for the AgentStatus tool.
 *
 * Tests the executeAgentStatusTool handler with a mocked manager.
 * Schema tests live in index.test.ts (which doesn't mock index.js).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { shellMock } from "./fixtures";

/* ------------------------------------------------------------------ */
/*  Module-level mock variables — defined before vi.mock calls so they  */
/*  are available when hoisted mock factories run.                      */
/* ------------------------------------------------------------------ */

const mockListAgents = vi.fn();

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("../src/shell.js", () => shellMock({
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

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_1",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toBe(
      "No agents running or completed.\n\nDon't poll — you'll receive notifications when agents complete.",
    );
    expect(result.isError).toBeUndefined();
  });

  it("returns single agent with type, short_id, and status", async () => {
    mockListAgents.mockReturnValue([
      { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" } },
    ]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_2",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toBe(
      "builder·abc123de·running\n\nDon't poll — you'll receive notifications when agents complete.",
    );
  });

  it("returns multiple agents separated by commas", async () => {
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
      { id: "ggg555hhh666iii", display: { type: "explorer" }, lifecycle: { status: "queued" } },
    ]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_3",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toBe(
      "builder·aaa111bb·running, reviewer·ddd333ee·completed, explorer·ggg555hh·queued\n\nDon't poll — you'll receive notifications when agents complete.",
    );
  });

  it("includes all status types (running, queued, completed, stopped, error)", async () => {
    mockListAgents.mockReturnValue([
      { id: "id1", display: { type: "a" }, lifecycle: { status: "running" } },
      { id: "id2", display: { type: "b" }, lifecycle: { status: "queued" } },
      { id: "id3", display: { type: "c" }, lifecycle: { status: "completed" } },
      { id: "id4", display: { type: "d" }, lifecycle: { status: "stopped" } },
      { id: "id5", display: { type: "e" }, lifecycle: { status: "error" } },
    ]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_4",
      {},
      undefined,
      undefined,
      {} as any,
    );

    const text = result.content[0].text;
    expect(text).toContain("a·id1·running");
    expect(text).toContain("b·id2·queued");
    expect(text).toContain("c·id3·completed");
    expect(text).toContain("d·id4·stopped");
    expect(text).toContain("e·id5·error");
    expect(text).toContain("Don't poll");
  });

  it("always includes nudge message", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_5",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("Don't poll — you'll receive notifications when agents complete.");
  });

  it("handles agents with different ID lengths", async () => {
    mockListAgents.mockReturnValue([
      { id: "short", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "a-very-long-agent-id-that-exceeds-short-length", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

    const result = await executeAgentStatusTool(
      "call_6",
      {},
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0].text).toContain("builder·short·running");
    expect(result.content[0].text).toContain("reviewer·a-very-l·completed");
  });

  it("returns no error flag on success", async () => {
    mockListAgents.mockReturnValue([]);

    const { executeAgentStatusTool } = await import("../src/agent-status.js");

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
