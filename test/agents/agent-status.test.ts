/** Behavior tests for AgentStatus list selection. */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentRecord } from "../../src/types.js";
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

interface FixtureRecord {
  id: string;
  type: string;
  status: AgentRecord["lifecycle"]["status"];
  note?: string;
  workflow?: boolean;
}

/** A record as the manager holds it: workflow runs carry `workflow`, subagents do not. */
function makeRecord(fixture: FixtureRecord): AgentRecord {
  return {
    id: fixture.id,
    display: { type: fixture.type, description: "" },
    lifecycle: { status: fixture.status, startedAt: 100, started: true },
    execution: { settled: false, settlementCount: 0 },
    stats: { toolUses: 0, compactionCount: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } },
    ...(fixture.workflow === false
      ? {}
      : {
          workflow: {
            name: fixture.type,
            remoteId: `wf-${fixture.id.slice(0, 8)}`,
            progress: [],
            ...(fixture.note ? { note: fixture.note } : {}),
          },
        }),
  };
}

const WORKFLOW_RECORD: FixtureRecord = { id: "aaaa1111aaaa1111", type: "audit", status: "running" };
const SUBAGENT_RECORD: FixtureRecord = {
  id: "bbbb2222bbbb2222",
  type: "researcher",
  status: "running",
  workflow: false,
};

function statusText(records: AgentRecord[], receivesCompletionNotifications = true): Promise<string> {
  mockListAgents.mockReturnValue(records);
  return executeAgentStatusTool(
    "call",
    {},
    undefined,
    undefined,
    asExtensionContext({}),
    receivesCompletionNotifications,
  ).then((result) => result.content[0].text);
}

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

  it("names a workflow record by the run and its state instead of calling it Agent", async () => {
    const output = await statusText([makeRecord(WORKFLOW_RECORD)]);

    expect(output).toMatch(/aaaa1111 \(audit workflow\) running/);
    expect(output).not.toContain("(Agent)");
  });

  it("prints a record's live note as written", async () => {
    const note = [
      "Workflow run aaaa1111 is still running remotely.",
      "The state is unknown after 5 observations: nothing was stopped, and observation was handed back.",
      "Check it later with AgentStatus using id aaaa1111.",
    ].join("\n");

    const output = await statusText([makeRecord({ ...WORKFLOW_RECORD, note })]);

    expect(output).toContain(note);
  });

  it("gives every listed record its own line, so a multi-line note cannot swallow the next id", async () => {
    const note = [
      "Workflow run aaaa1111 is still running remotely.",
      "Check it later with AgentStatus using id aaaa1111.",
    ].join("\n");

    const output = await statusText([
      makeRecord({ ...WORKFLOW_RECORD, note }),
      makeRecord({ ...WORKFLOW_RECORD, id: "bbbb2222bbbb2222" }),
    ]);
    const listing = output.split("\n\n")[0];

    expect(listing.split("\n")).toEqual([
      "aaaa1111 (audit workflow) running Workflow run aaaa1111 is still running remotely.",
      "Check it later with AgentStatus using id aaaa1111.",
      "bbbb2222 (audit workflow) running",
    ]);
  });

  it("states one delivery rule for every list shape", async () => {
    const texts = await Promise.all([
      statusText([makeRecord(SUBAGENT_RECORD)]),
      statusText([makeRecord(WORKFLOW_RECORD)]),
      statusText([makeRecord(SUBAGENT_RECORD), makeRecord(WORKFLOW_RECORD)]),
      statusText([makeRecord({ ...WORKFLOW_RECORD, note: "Workflow run aaaa1111 finished." })]),
    ]);

    for (const text of texts) {
      expect(text.split("\n").at(-1)).toBe(texts[0].split("\n").at(-1));
    }
    expect(texts[0]).toContain("Don't poll");
    expect(texts[0].split("\n").at(-1)).not.toMatch(/subagent|workflow/i);
  });

  it("states the parent-agent rule when the agent cannot notify its caller", async () => {
    const output = await statusText([makeRecord(SUBAGENT_RECORD)], false);

    expect(output.split("\n").at(-1)).toMatch(/parent agent/i);
  });
});
