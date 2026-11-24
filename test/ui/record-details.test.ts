/**
 * record-details.test.ts — Opening a record's details from the widget or from `/agents`.
 *
 * The seam is `openRecordDetails` driven through a `ui.custom` that keeps the component pi was given,
 * with a theme that records the colour role each row was painted with. A Workflow run has no session,
 * so what it gets is the viewer's own scroll, keys and footer over one coloured row per node of its
 * snapshot: the same viewer an agent record opens in.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, AgentStatus } from "../../src/types.js";
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

/**
 * Colour as these surfaces apply it: a theme that answers with the text alone and records the role it
 * was asked for, so a row's text and its colour are pinned apart (and no role is an escape sequence).
 */
const paint: { roles: string[]; theme: Theme } = {
  roles: [],
  theme: {
    fg: (role, text) => {
      paint.roles.push(`fg ${role} ${text.trimEnd()}`);
      return text;
    },
    bg: (role, text) => {
      paint.roles.push(`bg ${role} ${text.trimEnd()}`);
      return text;
    },
    bold: (text) => text,
  },
};

/** The roles a run's own rows are painted with: a node's state background, its title, its output. */
const RUN_ROLES = /\b(toolPendingBg|toolSuccessBg|toolErrorBg|toolTitle|toolOutput)\b/;

const requestRender = vi.fn<() => void>();
let shown: ConversationViewer | undefined;
let closed = 0;
let customOptions: unknown[] = [];
/** pi's global tool-output flag, in the holder the viewer reads, and the setter it calls. */
const expandFlag = { expanded: false, set: vi.fn<(expanded: boolean) => void>() };

/** The `ui.custom` the open path is handed: it keeps the component pi was given. */
function uiWith(theme: Theme): ExtensionUIContext {
  return {
    getToolsExpanded: () => expandFlag.expanded,
    setToolsExpanded: (expanded: boolean) => {
      expandFlag.expanded = expanded;
      expandFlag.set(expanded);
    },
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

/** The frame at `width`: border, padding and colour removed, trailing padding trimmed. */
function plainFrame(width: number): string[] {
  return shown!.render(width).map((line) =>
    line
      .replace(/^\u2502 /, "")
      .replace(/ \u2502$/, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .trimEnd(),
  );
}

/** A separator is a run of rules, however the truncator cut it. */
function separatorsOf(frame: string[]): number[] {
  return frame.flatMap((line, index) => (/^\u2500{10,}/.test(line) ? [index] : []));
}

/**
 * The viewer's own content rows at the width pi renders it at: border and padding removed, blank
 * viewport rows dropped. 120 is the width most of these pins are read at.
 */
function contentRows(width = 120): string[] {
  const frame = plainFrame(width);
  const separators = separatorsOf(frame);
  return frame.slice(separators[0]! + 1, separators[1]).filter((line) => line !== "");
}

/** The viewer's own rows around its content window: borders, header rows, separators, footer. */
function chromeRows(width: number): string[] {
  const frame = plainFrame(width);
  const separators = separatorsOf(frame);
  return [...frame.slice(0, separators[0]! + 1), ...frame.slice(separators[1]!)];
}

const frame = () => shown!.render(120).join("\n");

/** A line wide enough for the wide overlay, yet long enough to break at 60 columns. */
const LONG_LINE = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
/** A node name long enough that the node's own row breaks at 60 columns, yet fits the wide overlay. */
const LONG_NODE = "summarise-every-open-pull-request-in-the-monorepo";
/** A record description that overflows 60 columns in the viewer's header. */
const LONG_DESCRIPTION = "http://127.0.0.1:4100/runs/wf-remote-1/summarise-everything";
/** Where that line breaks: a node's body has 54 cells at 60 columns, a row nothing groups has 56. */
const WRAP_HEAD = "alpha beta gamma delta epsilon zeta eta theta iota";
const WRAP_TAIL = "kappa lambda mu";

/** A theme that paints with real colour codes, so a row's colour is visible in the rows it wraps into. */
const colouring = {
  theme: {
    fg: (_role: string, text: string) => `\u001b[32m${text}\u001b[39m`,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme,
};

const SNAPSHOT: WorkflowDisplayItem[] = [
  { type: "node-status", node: "analysis", status: "dispatched" },
  { type: "activity", node: "analysis", activity: "read_file" },
  { type: "text", node: "analysis", text: "Inspecting the diff." },
  { type: "node-status", node: "report", status: "retry" },
  { type: "text", node: null, text: "a chunk naming no node" },
];

const SNAPSHOT_ROWS = [
  " ▶ analysis dispatched",
  " tool read_file",
  " Inspecting the diff.",
  " ▶ report retrying",
  "  a chunk naming no node",
];

/**
 * A live Workflow run: no session, the snapshot the monitor last published, and the watch its own
 * publish path attaches. `publish` changes the snapshot the way that path does.
 */
function liveRun(items: WorkflowDisplayItem[] = SNAPSHOT, description = "http://127.0.0.1:4100") {
  const watchers = new Set<() => void>();
  const record = makeAgentRecord({
    id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    display: { type: "audit" as AgentRecord["display"]["type"], description },
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
    /** What the run's settlement writes, and tells: an error settlement carries its reason. */
    settle(status: AgentStatus = "completed", reason?: string): void {
      record.lifecycle.status = status;
      record.lifecycle.completedAt = 9000;
      if (status === "error") record.error = reason;
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
  expandFlag.expanded = false;
});

/** Hand the viewer the keys a reader presses, one at a time as the terminal does. */
function press(...keys: string[]): void {
  for (const key of keys.join("")) shown!.handleInput(key);
}

describe("a Workflow run's details", () => {
  it("shows one row per node the client observed, coloured by its state, with its entries under it", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);

    expect(contentRows()).toEqual(SNAPSHOT_ROWS);
    await opened;
  });

  it("names the record it was opened for", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);

    expect(frame()).toContain("audit workflow");
    await opened;
  });

  it("shows the viewer's own waiting line for a running run that has shown nothing", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun([]).record);

    expect(contentRows()).toEqual(["(waiting for first message...)"]);
    await opened;
  });

  it("says in the record's own words that a settled run showed nothing, rather than waiting", async () => {
    const run = liveRun([]);
    run.settle();
    const opened = openRecordDetails(uiWith(paint.theme), run.record);

    expect(contentRows()).toEqual(["(this run delivered no entries)"]);
    expect(frame()).not.toContain("waiting");
    await opened;
  });

  it("shows the reason a run failed as its own row, after the rows its snapshot published", async () => {
    const run = liveRun();
    run.settle("error", "Workflow run failed: connection refused");
    const opened = openRecordDetails(uiWith(paint.theme), run.record);

    expect(contentRows()).toEqual([...SNAPSHOT_ROWS, "Workflow run failed: connection refused"]);
    expect(paint.roles).toContain("fg error Workflow run failed: connection refused");
    await opened;
  });

  it("shows the reason instead of the empty-run line when a failed run published nothing", async () => {
    const run = liveRun([]);
    run.settle("error", "Workflow run failed: Stream failed\ntransport: connection refused");
    const opened = openRecordDetails(uiWith(paint.theme), run.record);

    expect(contentRows()).toEqual(["Workflow run failed: Stream failed", "transport: connection refused"]);
    expect(frame()).not.toContain("delivered no entries");
    await opened;
  });

  it("says so when the run settles while the view is open on nothing", async () => {
    const run = liveRun([]);
    const opened = openRecordDetails(uiWith(paint.theme), run.record);
    expect(contentRows()).toEqual(["(waiting for first message...)"]);
    requestRender.mockClear();

    run.settle();

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(contentRows()).toEqual(["(this run delivered no entries)"]);
    await opened;
  });

  it("repaints a snapshot handed over in the array it already holds", async () => {
    const items: WorkflowDisplayItem[] = [];
    const run = liveRun(items);
    const opened = openRecordDetails(uiWith(paint.theme), run.record);
    items.push({ type: "node-status", node: "analysis", status: "dispatched" });
    requestRender.mockClear();

    run.publish(items);

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(contentRows()).toEqual([" ▶ analysis dispatched"]);
    await opened;
  });

  it("replaces the rows it showed when the record carries a newer snapshot", async () => {
    const run = liveRun();
    const opened = openRecordDetails(uiWith(paint.theme), run.record);
    contentRows();
    requestRender.mockClear();

    run.publish([{ type: "node-status", node: "analysis", status: "completed" }]);

    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(contentRows()).toEqual([" ✓ analysis completed"]);
    await opened;
  });

  it("hears the run no more once the reader has left", async () => {
    const run = liveRun();
    const opened = openRecordDetails(uiWith(paint.theme), run.record);
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
    run.settle();
    run.record.result = "two findings, one nit";
    const opened = openRecordDetails(uiWith(paint.theme), run.record);

    expect(contentRows()).toEqual(SNAPSHOT_ROWS);
    expect(frame()).not.toContain("two findings, one nit");
    await opened;
  });

  it("paints each node's row on the background its state is shown with, and its text as tool output", async () => {
    const states: WorkflowDisplayItem[] = [
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "node-status", node: "fetch", status: "retry" },
      { type: "node-status", node: "report", status: "completed" },
      { type: "node-status", node: "writer", status: "failed" },
      { type: "text", node: "writer", text: "the endpoint refused it" },
      { type: "text", node: null, text: "a chunk naming no node" },
    ];
    paint.roles.length = 0;
    const opened = openRecordDetails(uiWith(paint.theme), liveRun(states).record);

    shown!.render(120);

    expect(paint.roles.filter((role) => RUN_ROLES.test(role))).toEqual([
      // The row nothing groups is coloured once, as the snapshot is read; the viewer paints it as it stands.
      "fg toolOutput   a chunk naming no node",
      "fg toolTitle  ▶ analysis dispatched",
      "bg toolPendingBg  ▶ analysis dispatched",
      "fg toolTitle  ▶ fetch retrying",
      "bg toolPendingBg  ▶ fetch retrying",
      "fg toolTitle  ✓ report completed",
      "bg toolSuccessBg  ✓ report completed",
      "fg toolTitle  ✗ writer failed",
      "bg toolErrorBg  ✗ writer failed",
      "fg toolOutput the endpoint refused it",
      "bg toolErrorBg  the endpoint refused it",
    ]);
    await opened;
  });

  it("gives a node's row no click target, because a node is no tool call the reader can open", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);
    const rows = shown!.render(120);
    const y = rows.findIndex((line) => line.includes("analysis dispatched"));
    expect(y, "the node's own row is on screen").toBeGreaterThan(0);

    const click = shown!.handleMouse({
      type: "click",
      button: "left",
      x: 5,
      y,
      screenX: 5,
      screenY: y,
      width: 120,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    });

    expect(click, "a node row opens nothing and expands nothing of its own").toBeUndefined();
    await opened;
  });

  it("folds a node's long text under its row, and unfolds it with the tool-output key", async () => {
    const long: WorkflowDisplayItem[] = [
      { type: "node-status", node: "report", status: "completed" },
      { type: "text", node: "report", text: "one\ntwo\nthree\nfour\nfive" },
    ];
    const opened = openRecordDetails(uiWith(paint.theme), liveRun(long).record);
    const head = [" ✓ report completed", " one", " two", " three"];

    expect(contentRows()).toEqual([...head, " ... (2 more lines, ctrl+o to expand)"]);

    press("\u000f");

    expect(contentRows()).toEqual([...head, " four", " five"]);
    await opened;
  });

  it("wraps a long line at the width it is rendered at, on every row kind it paints", async () => {
    const long: WorkflowDisplayItem[] = [
      { type: "node-status", node: "report", status: "completed" },
      { type: "text", node: "report", text: LONG_LINE },
      { type: "text", node: null, text: LONG_LINE },
      { type: "node-status", node: LONG_NODE, status: "completed" },
    ];
    const opened = openRecordDetails(uiWith(paint.theme), liveRun(long).record);

    expect(contentRows(120), "one row each where the wide overlay fits the whole line").toEqual([
      " ✓ report completed",
      ` ${LONG_LINE}`,
      `  ${LONG_LINE}`,
      ` ✓ ${LONG_NODE} completed`,
    ]);

    // 60 columns gives a node's own row and its body 54 cells, a row nothing groups 56, so each breaks
    // at the word where the width runs out.
    expect(contentRows(60), "and every kind splits at the word where the width runs out").toEqual([
      " ✓ report completed",
      ` ${WRAP_HEAD}`,
      ` ${WRAP_TAIL}`,
      `  ${WRAP_HEAD}`,
      WRAP_TAIL,
      ` ✓ ${LONG_NODE}`,
      "completed",
    ]);
    await opened;
  });

  it("paints every wrapped row in the colour that row is painted with", async () => {
    const long: WorkflowDisplayItem[] = [
      { type: "node-status", node: "report", status: "completed" },
      { type: "text", node: "report", text: LONG_LINE },
      { type: "node-status", node: LONG_NODE, status: "completed" },
    ];
    const opened = openRecordDetails(uiWith(paint.theme), liveRun(long).record);
    paint.roles.length = 0;

    shown!.render(60);

    expect(paint.roles.filter((role) => role.startsWith("fg toolOutput"))).toEqual([
      `fg toolOutput ${WRAP_HEAD}`,
      `fg toolOutput ${WRAP_TAIL}`,
    ]);
    expect(paint.roles.filter((role) => role.startsWith("fg toolTitle"))).toEqual([
      "fg toolTitle  ✓ report completed",
      `fg toolTitle  ✓ ${LONG_NODE}`,
      "fg toolTitle completed",
    ]);
    await opened;
  });

  it("keeps the colour on the continuation lines of a coloured row that wrapped", async () => {
    const long: WorkflowDisplayItem[] = [{ type: "text", node: null, text: LONG_LINE }];
    const opened = openRecordDetails(uiWith(colouring.theme), liveRun(long).record);

    const continuation = shown!.render(60).find((line) => line.includes(WRAP_TAIL));

    expect(continuation, "the wrapped continuation line carries the row's colour").toContain(`\u001b[32m${WRAP_TAIL}`);
    await opened;
  });

  it("keeps its own header, separators and footer to one row each when the record's text is long", async () => {
    const run = liveRun(SNAPSHOT, LONG_DESCRIPTION);
    run.settle();
    const opened = openRecordDetails(uiWith(paint.theme), run.record);

    // 60 columns: 56 cells inside the borders, the stats row the fixture's own 1 turn and 8s.
    expect(chromeRows(60)).toEqual([
      `╭${"─".repeat(58)}╮`,
      "✓ audit workflow  http://127.0.0.1:4100/runs/wf-remot...",
      "1⟳ ·8s",
      "─".repeat(56),
      "─".repeat(56),
      expect.stringContaining("Esc/q close"),
      `╰${"─".repeat(58)}╯`,
    ]);
    await opened;
  });

  it("unfolds through pi's own tool-output flag, so the transcript behind the view follows", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);

    press("\u000f");

    expect(expandFlag.set).toHaveBeenCalledWith(true);
    await opened;
  });

  it("names the key that unfolds a node's text, and ignores the thinking key it cannot answer", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);
    shown!.render(120);
    expect(frame()).toContain("C-o text");
    expect(frame()).not.toContain("thinking");
    requestRender.mockClear();

    press("\u0014");

    expect(requestRender, "the thinking key answers nothing a run's view has").not.toHaveBeenCalled();
    await opened;
  });

  it("offers no steering and no local stop for a remote run", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), liveRun().record);
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
    const opened = openRecordDetails(uiWith(paint.theme), record);

    expect(frame()).toContain("review the diff");

    press("\r", "keep going\r", "s", "s");

    expect(mockSteer).toHaveBeenCalledWith(record.id, "keep going");
    expect(mockAbort).toHaveBeenCalledWith(record.id, "user");
    await opened;
  });

  it("advertises the thinking and tool toggles a session's own view can answer", async () => {
    const opened = openRecordDetails(uiWith(paint.theme), sessionRecord());
    shown!.render(120);

    expect(frame()).toContain("C-t thinking");
    expect(frame()).toContain("C-o tools");
    await opened;
  });

  it("fails when a record has nothing to show, so the caller reports it", async () => {
    const empty = makeAgentRecord({ execution: { settled: false, settlementCount: 0 } });

    await expect(openRecordDetails(uiWith(paint.theme), empty)).rejects.toThrow(/11111111 has nothing to show/);
  });

  it("shows the reason for a record that failed before it had a session", async () => {
    const failed = makeAgentRecord({
      lifecycle: { status: "error", startedAt: 1000, started: true, completedAt: 9000 },
      execution: { settled: true, settlementCount: 0 },
      error: "Agent failed: unknown model ai.lan/nope",
    });
    const opened = openRecordDetails(uiWith(paint.theme), failed);

    expect(contentRows()).toEqual(["Agent failed: unknown model ai.lan/nope"]);
    await opened;
  });
});

describe("how a record is opened", () => {
  it("opens every record as an overlay twice pi's default width, whichever surface asked", async () => {
    // pi's own default is `min(80, terminal width)`; twice it is 160 columns, and pi clamps the
    // result to the space a narrow terminal has, so no width rule is needed for that case.
    const wide = { overlay: true, overlayOptions: { width: 160 } };

    const fromWidget = openRecordDetails(uiWith(paint.theme), liveRun().record);
    expect(customOptions[1], "a run opens over the conversation instead of in the editor's place").toEqual(wide);

    const fromMenu = openRecordDetails(uiWith(paint.theme), sessionRecord());
    expect(customOptions[1], "a session's own conversation opens the same way").toEqual(wide);

    await Promise.all([fromWidget, fromMenu]);
  });
});
