/** Behavior tests for AgentStatus list selection. */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { asExtensionContext } from "../pi-boundaries.js";
import { shellMock } from "../fixtures.js";

const { mockListAgents, mockStore } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockStore: { agent: { agentStatusLimit: 8 } },
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    manager: { listAgents: mockListAgents },
    store: mockStore,
  }),
);

import { executeAgentStatusTool } from "../../src/agents/agent-status.js";

describe("AgentStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.agent.agentStatusLimit = 8;
  });

  it("returns a text result for an empty agent list", async () => {
    mockListAgents.mockReturnValue([]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));

    expect(result.content[0].type).toBe("text");
    expect(result.isError).toBeUndefined();
  });

  it("keeps every active agent and the newest settled agents within the configured limit", async () => {
    mockStore.agent.agentStatusLimit = 2;
    mockListAgents.mockReturnValue([
      { id: "aaa11111aaa11111", display: { type: "builder" }, lifecycle: { status: "running", startedAt: 100 } },
      { id: "bbb22222bbb22222", display: { type: "reviewer" }, lifecycle: { status: "queued", startedAt: 90 } },
      {
        id: "ccc33333ccc33333",
        display: { type: "worker" },
        lifecycle: { status: "completed", startedAt: 80, completedAt: 100 },
      },
      {
        id: "ddd44444ddd44444",
        display: { type: "worker" },
        lifecycle: { status: "error", startedAt: 70, completedAt: 90 },
      },
      {
        id: "eee55555eee55555",
        display: { type: "worker" },
        lifecycle: { status: "stopped", startedAt: 60, completedAt: 80 },
      },
    ]);

    const result = await executeAgentStatusTool("call", {}, undefined, undefined, asExtensionContext({}));
    const output = result.content[0].text;

    expect(output).toContain("aaa11111");
    expect(output).toContain("running");
    expect(output).toContain("bbb22222");
    expect(output).toContain("queued");
    expect(output.indexOf("bbb22222")).toBeLessThan(output.indexOf("ccc33333"));
    expect(output).toContain("ccc33333");
    expect(output).toContain("ddd44444");
    expect(output.indexOf("ccc33333")).toBeLessThan(output.indexOf("ddd44444"));
    expect(output).not.toContain("eee55555");
    expect(result.isError).toBeUndefined();
  });
});
