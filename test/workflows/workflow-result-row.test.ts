/**
 * workflow-result-row.test.ts — The Workflow call's row: which text a record of each state puts on it.
 *
 * The row is the only place a handed-back run is described after its call returned, so it reads the
 * record, never the call's own returned text, for a run that is still live.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentRecord } from "../../src/types.js";
import { shellMock } from "../fixtures.js";
import { defaultTheme } from "../mock-utils.js";

const { mockGetRecord } = vi.hoisted(() => ({
  mockGetRecord: vi.fn<(_id: string) => AgentRecord | undefined>(() => undefined),
}));

vi.mock("../../src/shell.js", () => shellMock({ manager: { getRecord: mockGetRecord } }));

import { renderWorkflowResult } from "../../src/workflows/workflow-tool.js";

const SHORT_ID = "a1b2c3d4";
const NOTE = [
  `Workflow run ${SHORT_ID} is still running remotely.`,
  `Check it later with AgentStatus using id ${SHORT_ID}.`,
].join("\n");

interface RunFixture {
  status: AgentRecord["lifecycle"]["status"];
  note?: string;
  progress?: string[];
  result?: string;
  error?: string;
  launched?: boolean;
}

function liveRecord(fixture: RunFixture): AgentRecord {
  return {
    id: `${SHORT_ID}-e5f6-4a7b-8c9d-0e1f2a3b4c5d`,
    display: {
      type: "audit" as AgentRecord["display"]["type"],
      description: "audit the diff",
      ...(fixture.launched ? { invocation: { runInBackground: true } } : {}),
    },
    lifecycle: { status: fixture.status, startedAt: 100, started: true },
    execution: { settled: false, settlementCount: 0 },
    workflow: {
      name: "audit",
      endpoint: "lab",
      url: "http://127.0.0.1:8099",
      remoteId: "wf-remote-1",
      progress: fixture.progress ?? [],
      ...(fixture.note ? { note: fixture.note } : {}),
    },
    stats: { toolUses: 0, compactionCount: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } },
    ...(fixture.result === undefined ? {} : { result: fixture.result }),
    ...(fixture.error === undefined ? {} : { error: fixture.error }),
  };
}

/** The row's rows, as a reader sees them. */
function rowRows(paint: {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}): string[] {
  const text = renderWorkflowResult(
    { content: paint.content, details: { agentId: `${SHORT_ID}-e5f6-4a7b-8c9d-0e1f2a3b4c5d`, ...paint.details } },
    { expanded: true },
    defaultTheme,
    { isError: paint.isError ?? false, invalidate: () => {} },
  );
  return text
    .render(240)
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("the Workflow row's outcome line", () => {
  beforeEach(() => {
    mockGetRecord.mockReset();
    mockGetRecord.mockReturnValue(undefined);
  });

  it("names the run and its state while the record runs", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "running", progress: ["\u25b6 analysis dispatched"] }));

    expect(rowRows({ content: [] })).toEqual(["\u25b6 analysis dispatched", `a1b2c3d4 (audit workflow) running`]);
  });

  it("rides the whole note on that one row", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "running", note: NOTE }));

    expect(rowRows({ content: [] })).toEqual([
      `a1b2c3d4 (audit workflow) running Workflow run ${SHORT_ID} is still running remotely. Check it later with AgentStatus using id ${SHORT_ID}.`,
    ]);
  });

  it("never paints a waiting call's own text as a live run's health", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "running" }));

    expect(rowRows({ content: [{ type: "text", text: NOTE }] })).toEqual([`a1b2c3d4 (audit workflow) running`]);
  });

  it("keeps the launch receipt of a run that was launched in the background", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "running", launched: true }));
    const receipt = `Workflow ${SHORT_ID} is running remotely (server workflow_id wf-remote-1).`;

    expect(rowRows({ content: [{ type: "text", text: receipt }] })).toEqual([
      `a1b2c3d4 (audit workflow) running`,
      receipt,
    ]);
  });

  it("shows the text a settled run ended with", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "completed", result: "two findings, one nit" }));

    expect(rowRows({ content: [{ type: "text", text: "a note the call handed back" }] })).toEqual([
      "two findings, one nit",
    ]);
  });

  it("shows the error a failed run ended with", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "error", error: "the endpoint refused the run" }));

    expect(rowRows({ content: [] })).toEqual(["the endpoint refused the run"]);
  });

  it("keeps the call's own text when the record is gone", () => {
    expect(rowRows({ content: [{ type: "text", text: "cleared after the call returned" }] })).toEqual([
      "cleared after the call returned",
    ]);
  });
});
