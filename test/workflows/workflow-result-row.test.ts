/**
 * workflow-result-row.test.ts — The Workflow call's row: which text a record of each state puts on it.
 *
 * The row is the only place a handed-back run is described after its call returned, so it reads the
 * record, never the call's own returned text, for a run that is still live. Its entries are the run's
 * own, one flat row each: the details view groups the same entries under each node's coloured row,
 * while this card stays flat inside the fill pi paints behind the whole call.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentRecord } from "../../src/types.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";
import type { Theme } from "../../src/ui/types.js";
import { progressLines } from "../../src/workflows/stream-view.js";
import { shellMock } from "../fixtures.js";
import { defaultTheme } from "../mock-utils.js";

const { mockGetRecord } = vi.hoisted(() => ({
  mockGetRecord: vi.fn<(_id: string) => AgentRecord | undefined>(() => undefined),
}));

vi.mock("../../src/shell.js", () => shellMock({ manager: { getRecord: mockGetRecord } }));

import { renderWorkflowResult } from "../../src/workflows/workflow-tool.js";

/** The roles a run's rows and the card's own rows are painted with. */
const MARKED = new Set(["accent", "warning", "error", "dim", "toolOutput"]);

/** A theme that names the role it was asked for, so a row shows the colour it was painted with. */
const MARKING: Theme = {
  fg: (color, text) => (MARKED.has(color) ? `${color}:${text}` : text),
  bg: (_color, text) => text,
  bold: (text) => text,
};

const SHORT_ID = "a1b2c3d4";
const NOTE = [
  `Workflow run ${SHORT_ID} is still running remotely.`,
  `Check it later with AgentStatus using id ${SHORT_ID}.`,
].join("\n");

interface RunFixture {
  status: AgentRecord["lifecycle"]["status"];
  note?: string;
  /** The record's display snapshot; `progress` is the same snapshot in its flat spelling. */
  items?: WorkflowDisplayItem[];
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
      remoteId: "wf-remote-1",
      progress: progressLines(fixture.items ?? []),
      ...(fixture.items ? { items: fixture.items } : {}),
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
  theme?: Theme;
}): string[] {
  const text = renderWorkflowResult(
    { content: paint.content, details: { agentId: `${SHORT_ID}-e5f6-4a7b-8c9d-0e1f2a3b4c5d`, ...paint.details } },
    { expanded: true },
    paint.theme ?? defaultTheme,
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
    mockGetRecord.mockReturnValue(
      liveRecord({ status: "running", items: [{ type: "node-status", node: "analysis", status: "dispatched" }] }),
    );

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

  it("keeps the launch receipt of a background run whose note arrived later", () => {
    mockGetRecord.mockReturnValue(liveRecord({ status: "running", launched: true, note: NOTE }));
    const receipt = `Workflow ${SHORT_ID} is running remotely (server workflow_id wf-remote-1).`;

    expect(rowRows({ content: [{ type: "text", text: receipt }] })).toEqual([
      `a1b2c3d4 (audit workflow) running Workflow run ${SHORT_ID} is still running remotely. Check it later with AgentStatus using id ${SHORT_ID}.`,
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

  it("paints the call's own lines as the flat lines they are once the record is gone", () => {
    const progress = ["\u25b6 analysis dispatched", "  Inspecting the diff."];

    expect(rowRows({ content: [], details: { progress }, theme: MARKING })).toEqual([
      "toolOutput:\u25b6 analysis dispatched",
      "toolOutput:  Inspecting the diff.",
    ]);
  });

  const SNAPSHOT: WorkflowDisplayItem[] = [
    { type: "node-status", node: "analysis", status: "dispatched" },
    { type: "activity", node: "analysis", activity: "read_file" },
    { type: "text", node: "analysis", text: "Inspecting the diff." },
    { type: "text", node: null, text: "a chunk naming no node" },
  ];

  it("paints the entries the run's details view paints: the same rows, order and colours", () => {
    mockGetRecord.mockReturnValue(
      liveRecord({ status: "completed", result: "two findings, one nit", items: SNAPSHOT }),
    );

    expect(rowRows({ content: [], theme: MARKING })).toEqual([
      "accent:\u25b6 analysis dispatched",
      "accent:  analysis toolOutput:tool read_file",
      "accent:  analysis  toolOutput:Inspecting the diff.",
      "toolOutput:  a chunk naming no node",
      "toolOutput:two findings, one nit",
    ]);
  });

  it("paints the same rows uncoloured under a theme that paints no colour", () => {
    mockGetRecord.mockReturnValue(
      liveRecord({ status: "completed", result: "two findings, one nit", items: SNAPSHOT }),
    );

    expect(rowRows({ content: [] })).toEqual([
      "\u25b6 analysis dispatched",
      "analysis tool read_file",
      "analysis  Inspecting the diff.",
      "a chunk naming no node",
      "two findings, one nit",
    ]);
  });
});
