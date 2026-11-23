/**
 * record-details.test.ts — Opening a record's details from the widget or from `/agents`.
 *
 * The seam is `openRecordDetails` driven through a `ui.custom` that hands back the component it was
 * given, with a theme that names the colour role each row was painted with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";
import type { Theme } from "../../src/ui/types.js";
import { makeAgentRecord, shellMock } from "../fixtures.js";
import { asAgentSession, asTui, asUiCustom } from "../pi-boundaries.js";
import { openRecordDetails } from "../../src/ui/record-details.js";

const { viewerOptions } = vi.hoisted(() => ({ viewerOptions: [] as unknown[] }));

vi.mock("../../src/ui/conversation-viewer.js", () => ({
  ConversationViewer: class MockConversationViewer {
    constructor(...args: unknown[]) {
      viewerOptions.push(args[5]);
    }
    setModelDisplayStyle(): void {}
  },
}));

vi.mock("../../src/shell.js", () => shellMock({ manager: { steer: vi.fn(), abort: vi.fn() } }));

/** Roles a run's own rows are painted with; the pane's chrome stays plain enough to find its rows. */
const MARKED = new Set(["accent", "warning", "error", "dim", "toolOutput"]);

/** A theme that names the role it was asked for, so a row shows the colour it was painted with. */
const markingTheme: Theme = {
  fg: (color, text) => (MARKED.has(color) ? `${color}:${text}` : text),
  bg: (_color, text) => text,
  bold: (text) => text,
};

interface PaneComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

const requestRender = vi.fn<() => void>();
const done = vi.fn<(result: undefined) => void>();
let pane: PaneComponent | undefined;

const ui = {
  custom: asUiCustom(async (factory: unknown, _options?: unknown) => {
    pane = (factory as (tui: unknown, theme: Theme, kb: unknown, close: (r: undefined) => void) => PaneComponent)(
      asTui({ terminal: { rows: 40, cols: 120 }, requestRender }),
      markingTheme,
      undefined,
      done,
    );
    return undefined;
  }),
} as unknown as ExtensionUIContext;

/** The pane's viewport rows, borders and padding removed. */
function shownRows(): string[] {
  const frame = pane!.render(120).map((line) => line.replace(/^│ /, "").replace(/ │$/, "").trimEnd());
  const separator = frame.findIndex((line) => /^(dim:)?─+$/.test(line));
  const rows = frame.slice(separator + 1, frame.length - 2);
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

const SNAPSHOT: WorkflowDisplayItem[] = [
  { type: "node-status", node: "analysis", status: "dispatched" },
  { type: "activity", node: "analysis", activity: "read_file" },
  { type: "text", node: "analysis", text: "Inspecting the diff." },
  { type: "node-status", node: "report", status: "retry" },
  { type: "text", node: null, text: "a chunk naming no node" },
];

/** A Workflow run record: no session, and the snapshot the monitor last published. */
function runRecord(items: WorkflowDisplayItem[] = SNAPSHOT, status: AgentRecord["lifecycle"]["status"] = "running") {
  return makeAgentRecord({
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    display: { type: "audit" as AgentRecord["display"]["type"], description: "http://127.0.0.1:4100" },
    lifecycle: { status, startedAt: 1000, started: true, ...(status === "completed" ? { completedAt: 9000 } : {}) },
    execution: { settled: false, settlementCount: 0 },
    workflow: {
      name: "audit",
      remoteId: "wf-remote-1",
      progress: ["\u25b6 analysis dispatched"],
      items,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  pane = undefined;
  viewerOptions.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a Workflow run's details", () => {
  it("shows each entry the client observed, named by its node and coloured by that node's state", async () => {
    const opened = openRecordDetails(ui, runRecord());

    expect(shownRows()).toEqual([
      "accent:\u25b6 analysis dispatched",
      "accent:  analysis tool read_file",
      "accent:  Inspecting the diff.",
      "warning:\u25b6 report retrying",
      "toolOutput:  a chunk naming no node",
    ]);
    await opened;
  });

  it("names the run and its id on the title row", async () => {
    const opened = openRecordDetails(ui, runRecord());

    expect(pane!.render(120)[1]).toContain("audit workflow \u00b7 a1b2c3d4");
    await opened;
  });

  it("shows no line at all for a run whose connection delivered nothing", async () => {
    const opened = openRecordDetails(ui, runRecord([]));

    expect(shownRows()).toEqual([]);
    await opened;
  });

  it("shows the settled record's own entries, and claims no outcome of its own", async () => {
    const settled = runRecord(SNAPSHOT, "completed");
    settled.result = "two findings, one nit";
    const opened = openRecordDetails(ui, settled);

    expect(shownRows()).toEqual([
      "accent:\u25b6 analysis dispatched",
      "accent:  analysis tool read_file",
      "accent:  Inspecting the diff.",
      "warning:\u25b6 report retrying",
      "toolOutput:  a chunk naming no node",
    ]);
    await opened;
  });

  it("shows the same entries whole when the theme paints no colour", async () => {
    const monochrome: Theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
    const plain = asUiCustom(async (factory: unknown) => {
      pane = (factory as (tui: unknown, theme: Theme, kb: unknown, close: (r: undefined) => void) => PaneComponent)(
        asTui({ terminal: { rows: 40, cols: 120 }, requestRender }),
        monochrome,
        undefined,
        done,
      );
      return undefined;
    });

    const opened = openRecordDetails({ custom: plain } as unknown as ExtensionUIContext, runRecord());

    expect(shownRows()).toEqual([
      "\u25b6 analysis dispatched",
      "  analysis tool read_file",
      "  Inspecting the diff.",
      "\u25b6 report retrying",
      "  a chunk naming no node",
    ]);
    await opened;
  });

  it("shows the newest snapshot the record carries, in place of the one it showed", async () => {
    const record = runRecord();
    const opened = openRecordDetails(ui, record);
    pane!.render(120);

    record.workflow!.items = [{ type: "node-status", node: "analysis", status: "completed" }];
    vi.advanceTimersByTime(2_000);

    expect(shownRows()).toEqual(["dim:\u2713 analysis completed"]);
    await opened;
  });

  it("asks for a repaint when the record gained a snapshot the pane has not shown yet", async () => {
    const record = runRecord();
    const opened = openRecordDetails(ui, record);
    pane!.render(120);
    requestRender.mockClear();

    record.workflow!.items = [{ type: "node-status", node: "analysis", status: "completed" }];
    vi.advanceTimersByTime(2_000);

    expect(requestRender).toHaveBeenCalled();
    await opened;
  });

  it("offers no steering and no local stop for a remote run", async () => {
    const opened = openRecordDetails(ui, runRecord());
    pane!.render(120);

    pane!.handleInput("steer me\r");
    pane!.handleInput("s");
    pane!.handleInput("s");

    expect(done).not.toHaveBeenCalled();
    expect(pane!.render(120).join("\n")).not.toMatch(/steer|stop/i);
    await opened;
  });
});

describe("every other record", () => {
  it("opens its conversation in the viewer", async () => {
    const record = makeAgentRecord({
      execution: {
        settled: false,
        settlementCount: 0,
        session: asAgentSession({ messages: [], subscribe: () => () => {} }),
      },
    });

    const opened = openRecordDetails(ui, record);
    await opened;

    expect(viewerOptions).toHaveLength(1);
  });

  it("fails when a record has nothing to show, so the caller reports it", async () => {
    await expect(
      openRecordDetails(ui, makeAgentRecord({ execution: { settled: false, settlementCount: 0 } })),
    ).rejects.toThrow(/11111111 has no session to show/);
  });
});
