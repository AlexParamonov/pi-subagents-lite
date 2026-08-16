/**
 * agent-status.test.ts — Execute behavior tests for the AgentStatus tool.
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

const { mockListAgents, mockStore } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  // Resolved store projection the tool reads. The limit arrives pre-resolved;
  // the auto derivation (2 × default concurrency) lives in ConfigStore.
  mockStore: {
    agent: { agentStatusLimit: 8 },
  },
}));

/* ------------------------------------------------------------------ */
/*  Global mocks                                                      */
/* ------------------------------------------------------------------ */

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: { listAgents: mockListAgents },
    store: mockStore,
  }),
);

/* ------------------------------------------------------------------ */
/*  Execute behavior tests                                            */
/* ------------------------------------------------------------------ */

import { executeAgentStatusTool } from "../../src/agents/agent-status.js";
describe("AgentStatus tool execute behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty state message when no agents exist", async () => {
    mockListAgents.mockReturnValue([]);

    const result = await executeAgentStatusTool("call_1", {}, undefined, undefined, undefined, {} as any);

    expect(result.content[0].text).toContain("No agents");
    expect(result.content[0].text).toContain("Don't poll");
    expect(result.isError).toBeUndefined();
  });

  it("formats each agent as {shortId} ({type}) {status}", async () => {
    mockListAgents.mockReturnValue([
      { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running" } },
    ]);

    const result = await executeAgentStatusTool("call_2", {}, undefined, undefined, undefined, {} as any);

    const text = result.content[0].text;
    // Contract: agent entries use "{shortId} ({type}) {status}" — this regex
    // matches an 8-char id run but does not pin truncation (see the dedicated
    // truncation test below).
    expect(text).toMatch(/[a-z0-9]{8} \(builder\) running/);
    expect(text).toContain("Don't poll");
  });

  it("separates multiple agents with commas", async () => {
    mockListAgents.mockReturnValue([
      { id: "aaa111bbb222ccc", display: { type: "builder" }, lifecycle: { status: "running" } },
      { id: "ddd333eee444fff", display: { type: "reviewer" }, lifecycle: { status: "completed" } },
    ]);

    const result = await executeAgentStatusTool("call_3", {}, undefined, undefined, undefined, {} as any);

    const text = result.content[0].text;
    // Contract: multiple agents comma-separated, each entry matching the
    // "{id} ({type}) {status}" format (truncation not pinned here).
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

    const result = await executeAgentStatusTool("call_4", {}, undefined, undefined, undefined, {} as any);

    const text = result.content[0].text;
    expect(text).toMatch(/id1 \(a\) running/);
    expect(text).toMatch(/id2 \(b\) queued/);
    expect(text).toMatch(/id3 \(c\) completed/);
    expect(text).toMatch(/id4 \(d\) stopped/);
    expect(text).toMatch(/id5 \(e\) error/);
    expect(text).toContain("Don't poll");
  });

  it("always includes nudge message", async () => {
    mockListAgents.mockReturnValue([]);

    const result = await executeAgentStatusTool("call_5", {}, undefined, undefined, {} as any);

    expect(result.content[0].text).toContain("Don't poll — you'll receive notifications when agents complete.");
  });

  it("truncates long IDs to 8 characters", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "a-very-long-agent-id-that-exceeds-short-length",
        display: { type: "reviewer" },
        lifecycle: { status: "completed" },
      },
    ]);

    const result = await executeAgentStatusTool("call_6", {}, undefined, undefined, undefined, {} as any);

    const text = result.content[0].text;
    // Contract: short ID is always 8 characters
    expect(text).toContain("a-very-l (reviewer) completed");
    expect(text).not.toContain("a-very-long");
  });

  it("returns no error flag on success", async () => {
    mockListAgents.mockReturnValue([]);

    const result = await executeAgentStatusTool("call_7", {}, undefined, undefined, {} as any);

    expect(result.isError).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Limit-bounded output (issue: limit-agent-status)                   */
/* ------------------------------------------------------------------ */

describe("AgentStatus limit-bounded output", () => {
  beforeEach(() => {
    // Default store projection: auto limit 8.
    mockStore.agent.agentStatusLimit = 8;
  });

  it("lists every active agent even when settled agents are truncated", async () => {
    mockStore.agent.agentStatusLimit = 2;
    mockListAgents.mockReturnValue([
      { id: "aaa11111aaa11111", display: { type: "a" }, lifecycle: { status: "running", startedAt: 100 } },
      { id: "bbb22222bbb22222", display: { type: "b" }, lifecycle: { status: "queued", startedAt: 90 } },
      {
        id: "ccc33333ccc33333",
        display: { type: "c" },
        lifecycle: { status: "completed", startedAt: 80, completedAt: 100 },
      },
      {
        id: "ddd44444ddd44444",
        display: { type: "d" },
        lifecycle: { status: "completed", startedAt: 70, completedAt: 90 },
      },
      {
        id: "eee55555eee55555",
        display: { type: "e" },
        lifecycle: { status: "error", startedAt: 60, completedAt: 80 },
      },
      {
        id: "fff66666fff66666",
        display: { type: "f" },
        lifecycle: { status: "stopped", startedAt: 50, completedAt: 70 },
      },
      {
        id: "ggg77777ggg77777",
        display: { type: "g" },
        lifecycle: { status: "turn_limited", startedAt: 40, completedAt: 60 },
      },
    ]);

    const result = await executeAgentStatusTool("call_l1", {}, undefined, undefined, undefined, {} as any);
    const text = result.content[0].text;

    // All in-progress agents appear regardless of the limit.
    expect(text).toMatch(/aaa11111 \(a\) running/);
    expect(text).toMatch(/bbb22222 \(b\) queued/);
    // Only the two most-recently-settled appear; the rest are summarized.
    expect(text).toMatch(/ccc33333 \(c\) completed/);
    expect(text).toMatch(/ddd44444 \(d\) completed/);
    expect(text).not.toMatch(/eee55555/);
    expect(text).not.toMatch(/fff66666/);
    expect(text).not.toMatch(/ggg77777/);
    expect(text).toContain("and 3 more settled agents");
    expect(text).toContain("Don't poll");
  });

  it("orders settled agents most-recently-settled first", async () => {
    mockListAgents.mockReturnValue([
      {
        id: "aaaa1111aaaa1111",
        display: { type: "a" },
        lifecycle: { status: "completed", startedAt: 300, completedAt: 100 },
      },
      {
        id: "bbbb2222bbbb2222",
        display: { type: "b" },
        lifecycle: { status: "completed", startedAt: 200, completedAt: 300 },
      },
      {
        id: "cccc3333cccc3333",
        display: { type: "c" },
        lifecycle: { status: "completed", startedAt: 100, completedAt: 200 },
      },
    ]);

    const result = await executeAgentStatusTool("call_l2", {}, undefined, undefined, undefined, {} as any);
    const text = result.content[0].text;

    // Manager returns newest-started first (a, b, c); settlement order is b(300), c(200), a(100).
    expect(text.indexOf("bbbb2222")).toBeLessThan(text.indexOf("cccc3333"));
    expect(text.indexOf("cccc3333")).toBeLessThan(text.indexOf("aaaa1111"));
  });

  it("keeps the exact legacy output when nothing is hidden", async () => {
    mockListAgents.mockReturnValue([
      { id: "abc123def456ghi", display: { type: "builder" }, lifecycle: { status: "running", startedAt: 1 } },
      {
        id: "ddd333eee444fff",
        display: { type: "reviewer" },
        lifecycle: { status: "completed", startedAt: 2, completedAt: 3 },
      },
    ]);

    const result = await executeAgentStatusTool("call_l3", {}, undefined, undefined, undefined, {} as any);

    expect(result.content[0].text).toBe(
      "abc123de (builder) running, ddd333ee (reviewer) completed\n\n" +
        "Don't poll — you'll receive notifications when agents complete.",
    );
  });

  it("applies the store-resolved auto limit (2 × default concurrency)", async () => {
    mockStore.agent.agentStatusLimit = 8;
    mockListAgents.mockReturnValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        display: { type: "t" },
        lifecycle: { status: "completed", startedAt: i, completedAt: i },
      })),
    );

    const result = await executeAgentStatusTool("call_l4", {}, undefined, undefined, undefined, {} as any);
    const text = result.content[0].text;

    expect(text).toContain("and 2 more settled agents");
    expect(text).toContain("a9 (t) completed"); // newest settled kept
    expect(text).not.toContain("a0 (t)");
    expect(text).not.toContain("a1 (t)");
  });
});
