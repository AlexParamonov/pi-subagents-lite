/**
 * record-details.test.ts — Opening a record's details from the widget or from `/agents`.
 *
 * The seam is `openRecordDetails` driven through a `ui.custom` that keeps the component pi was given,
 * with a theme that names the colour role each row was painted with. A Workflow run has no session, so
 * what it gets is the viewer's own scroll, keys and footer over rows of its snapshot: the same viewer
 * an agent record opens in.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";
import type { Theme } from "../../src/ui/types.js";
import type { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { makeAgentRecord, shellMock } from "../fixtures.js";
import { asAgentSession, asTui, asUiCustom } from "../pi-boundaries.js";
import { openRecordDetails } from "../../src/ui/record-details.js";

const { mockSteer, mockAbort } = vi.hoisted(() => ({ mockSteer: vi.fn(), mockAbort: vi.fn() }));

vi.mock("../../src/shell.js", () => shellMock({ manager: { steer: mockSteer, abort: mockAbort } }));
vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

/** The roles a run's rows and the viewer's own separator are painted with. */
const MARKED = new Set(["accent", "warning", "error", "dim", "toolOutput"]);

/** A theme that names the role it was asked for, so a row shows the colour it was painted with. */
const MARKING: Theme = {
  fg: (color, text) => (MARKED.has(color) ? `${color}:${text}` : text),
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** A monochrome theme: the same roles answer with the text alone. */
const MONOCHROME: Theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

const requestRender = vi.fn<() => void>();
let shown: ConversationViewer | undefined;
let closed = 0;
let customOptions: unknown[] = [];

/** The `ui.custom` the open path is handed: it keeps the component pi was given. */
function uiWith(theme: Theme): ExtensionUIContext {
  return {
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    custom: asUiCustom(async (factory: unknown, options?: unknown) => {
      customOptions = [factory, options];
      shown = (factory as (tui: unknown, th: Theme, kb: unknown, done: () => void) => ConversationViewer)(
        asTui({ terminal: { rows: 40, cols: 120 }, requestRender }),
        theme,
        undefined,
        () => {
          closed += 1;
        },
      );
      return undefined;
    }),
  } as unknown as ExtensionUIContext;
}

/** The viewer's own content rows: border and padding removed, blank viewport rows dropped. */
function contentRows(): string[] {
  const frame = shown!.render(120).map((line) =>
    line
      .replace(/^\u2502 /, "")
      .replace(/ \u2502$/, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trimEnd(),
  );
  // A separator is a run of rules, however the marking theme dressed it or the truncator cut it.
  const separators = frame.flatMap((line, index) => (/^(dim:)?\u2500{10,}/.test(line) ? [index] : []));
  return frame.slice(separators[0]! + 1, separators[1]).filter((line) => line !== "");
}

const frame = () => shown!.render(120).join("\n");

const SNAPSHOT: WorkflowDisplayItem[] = [
  { type: "node-status", node: "analysis", status: "dispatched" },
  { type: "activity", node: "analysis", activity: "read_file" },
  { type: "text", node: "analysis", text: "Inspecting the diff." },
  { type: "node-status", node: "report", status: "retry" },
  { type: "text", node: null, text: "a chunk naming no node" },
];

const SNAPSHOT_ROWS = [
  "accent:\u25b6 analysis dispatched",
  "accent:  analysis tool read_file",
  "accent:  analysis  Inspecting the diff.",
  "warning:\u25b6 report retrying",
  "toolOutput:  a chunk naming no node",
];

/**
 * A live Workflow run: no session, the snapshot the monitor last published, and the watch its own
 * publish path attaches. `publish` changes the snapshot the way that path does.
 */
function liveRun(items: WorkflowDisplayItem[] = SNAPSHOT) {
  const watchers = new Set<() => void>();
  const record = makeAgentRecord({
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    display: { type: "audit" as AgentRecord["display"]["type"], description: "http://127.0.0.1:4100" },
    lifecycle: { status: "running", startedAt: 1000, started: true },
    execution: { settled: false, settlementCount: 0 },
    workflow: { name: "audit", remoteId: "wf-remote-1", progress: ["\u25b6 analysis dispatched"], items },
  });
  record.execution.watchSnapshot = (onChange) => {
    watchers.add(onChange);
    return () => {
      watchers.delete(onChange);
    };
  };
  return {
    record,
    watchers,
    publish(next: WorkflowDisplayItem[]): void {
      record.workflow!.items = next;
      for (const watch of watchers) watch();
    },
  };
}

/** A record whose agent has a session of its own, with the transcript the viewer reads. */
function sessionRecord(messages: unknown[] = [{ role: "user", content: "review the diff" }]): AgentRecord {
  const session = asAgentSession({ messages, subscribe: () => () => {} });
  return makeAgentRecord({ execution: { settled: false, settlementCount: 0, session: session as AgentSession } });
}

beforeEach(() => {
  vi.clearAllMocks();
  shown = undefined;
  closed = 0;
  customOptions = [];
});

/** Hand the viewer the keys a reader presses, one at a time as the terminal does. */
function press(...keys: string[]): void {
  for (const key of keys.join("")) shown!.handleInput(key);
}

describe("a Workflow run's details", () => {
  it("shows each entry the client observed, named by its node and coloured by that node's state", async () => {
    const opened = openRecordDetails(uiWith(MARKING), liveRun().record);

    expect(contentRows()).toEqual(SNAPSHOT_ROWS);
    await opened;
  });

  it("names the record it was opened for", async () => {
    const opened = openRecordDetails(uiWith(MARKING), liveRun().record);

    expect(frame()).toContain("audit workflow");
    await opened;
  });

  it("shows nothing but its empty line for a run whose connection delivered nothing", async () => {
    const opened = openRecordDetails(uiWith(MARKING), liveRun([]).record);

    expect(contentRows()).toEqual(["dim:(waiting for first message...)"]);
    await opened;
  });

  it("replaces the rows it showed when the record carries a newer snapshot", async () => {
    const run = liveRun();
    const opened = openRecordDetails(uiWith(MARKING), run.record);
    contentRows();
    requestRender.mockClear();

    run.publish([{ type: "node-status", node: "analysis", status: "completed" }]);

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(contentRows()).toEqual(["dim:\u2713 analysis completed"]);
    await opened;
  });

  it("hears the run no more once the reader has left", async () => {
    const run = liveRun();
    const opened = openRecordDetails(uiWith(MARKING), run.record);
    contentRows();
    expect(run.watchers, "the view watches the run it shows").toHaveLength(1);
    requestRender.mockClear();

    shown!.handleInput("q");
    run.publish([{ type: "node-status", node: "analysis", status: "completed" }]);
    expect(requestRender).not.toHaveBeenCalled();
    expect(closed, "q answers the reader's close").toBe(1);

    shown!.dispose();
    expect(run.watchers).toHaveLength(0);
    await opened;
  });

  it("shows the settled run's entries, and no outcome of its own", async () => {
    const run = liveRun();
    run.record.lifecycle.status = "completed";
    run.record.lifecycle.completedAt = 9000;
    run.record.result = "two findings, one nit";
    const opened = openRecordDetails(uiWith(MARKING), run.record);

    expect(contentRows()).toEqual(SNAPSHOT_ROWS);
    expect(frame()).not.toContain("two findings, one nit");
    await opened;
  });

  it("shows the same entries whole when the theme paints no colour", async () => {
    const opened = openRecordDetails(uiWith(MONOCHROME), liveRun().record);

    expect(contentRows()).toEqual(SNAPSHOT_ROWS.map((row) => row.replace(/^[a-zA-Z]+:/, "")));
    await opened;
  });

  it("shows over the surface that asked for it, and in its place for the one that did not", async () => {
    const inPlace = openRecordDetails(uiWith(MARKING), liveRun().record);
    expect(customOptions[1]).toBeUndefined();

    const overMenu = openRecordDetails(uiWith(MARKING), liveRun().record, { overlay: true });
    expect(customOptions[1]).toEqual({ overlay: true });

    await Promise.all([inPlace, overMenu]);
  });

  it("offers no steering and no local stop for a remote run", async () => {
    const opened = openRecordDetails(uiWith(MARKING), liveRun().record);
    shown!.render(120);

    press("\r", "steer me\r", "s", "s");

    expect(mockSteer).not.toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
    expect(frame()).not.toMatch(/steer|\bstop\b/i);
    await opened;
  });
});

describe("every other record", () => {
  it("opens its conversation in the same viewer, steerable and stoppable", async () => {
    const record = sessionRecord();
    const opened = openRecordDetails(uiWith(MARKING), record);

    expect(frame()).toContain("review the diff");

    press("\r", "keep going\r", "s", "s");

    expect(mockSteer).toHaveBeenCalledWith(record.id, "keep going");
    expect(mockAbort).toHaveBeenCalledWith(record.id, "user");
    await opened;
  });

  it("fails when a record has nothing to show, so the caller reports it", async () => {
    const empty = makeAgentRecord({ execution: { settled: false, settlementCount: 0 } });

    await expect(openRecordDetails(uiWith(MARKING), empty)).rejects.toThrow(/11111111 has nothing to show/);
  });
});
