import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { Component } from "@earendil-works/pi-tui";
import { defaultTheme } from "../mock-utils.js";

/* ------------------------------------------------------------------ */
/*  Mock setup — capture Text content for assertions                  */
/* ------------------------------------------------------------------ */

/** Every row the pi-tui mock builds, in build order, so tests can pin a card's full layout. */
interface RenderedRow {
  kind: "Spacer" | "Text" | "TruncatedText";
  text: string;
}
const renderedRows: RenderedRow[] = [];

/** Every Box's background, in build order, spelled by the theme that painted it. */
const boxFills: string[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: Component[] = [];
    addChild(c: Component) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
  },
  Spacer: class {
    constructor(_count?: number) {
      renderedRows.push({ kind: "Spacer", text: "" });
    }
  },
  Text: class {
    constructor(text: string, _x?: number, _y?: number) {
      renderedRows.push({ kind: "Text", text });
    }
  },
  TruncatedText: class {
    constructor(text: string, _x?: number, _y?: number) {
      renderedRows.push({ kind: "TruncatedText", text });
    }
  },
  Box: class {
    constructor(_paddingX?: number, _paddingY?: number, bgFn?: (text: string) => string) {
      boxFills.push(bgFn ? bgFn("") : "");
    }
    children: Component[] = [];
    addChild(c: Component) {
      this.children.push(c);
    }
  },
  visibleWidth: (text: string) => text.length,
}));

beforeEach(() => {
  renderedRows.length = 0;
  boxFills.length = 0;
});

vi.mock("../../src/shell.js", () => ({
  getManager: vi.fn(() => null),
  getStore: vi.fn(() => ({
    agent: {
      showAgentColors: true,
      outputTranscript: false,
      outputThinkingBufferSize: 0,
      showCompletionCards: true,
      agentStatusLimit: 0,
      modelDisplayStyle: "name" as const,
      modelThinkingPlacement: "header" as const,
      statusBarFormat: "full" as const,
    },
  })),
}));

vi.mock("../../src/ui/format.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/ui/format.js");
  return {
    ...actual,
    buildStatsParts: vi.fn(() => ["5 uses", "3 turns"]),
    formatMs: vi.fn(() => "1m0s"),
    getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
    buildModelThinkingTag: vi.fn((m: string | undefined, t: string | undefined) => {
      const p = [m, t].filter(Boolean);
      return p.length ? `(${p.join(" • ")})` : "";
    }),
    resolveModelLabel: vi.fn(
      (style: "id" | "name", name?: string, id?: string) => (style === "name" ? name : id)?.trim() || undefined,
    ),
  };
});

// Import after mocks are set up
import type { AgentLifecycle, AgentRecord } from "../../src/types.js";
import { SHORT_ID_LENGTH } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import { buildAgentDetails, formatResultContent } from "../../src/record-result.js";
import { makeAgentRecord } from "../fixtures.js";
import {
  renderSubagentResult,
  renderAgentToolCall,
  renderAgentToolResult,
  registerAgentInvalidation,
  invalidateAgentRow,
  cleanupInvalidations,
} from "../../src/ui/renderer.js";
import { getManager } from "../../src/shell.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const SHOW_COST = false;

/** Text of the rows the renderer built as width-truncated single rows, i.e. the collapsed reply preview rows. */
const truncatedRows = () => renderedRows.filter((r) => r.kind === "TruncatedText").map((r) => r.text);

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("renderSubagentResult — completion visibility", () => {
  it("renders by default", () => {
    const result = renderSubagentResult({ content: "Result" }, { expanded: false }, defaultTheme, SHOW_COST);

    expect(result.children).not.toHaveLength(0);
  });

  it.each([{ expanded: false }, { expanded: true }, {}])(
    "returns an empty component when hiding is enabled (%j)",
    (options) => {
      const result = renderSubagentResult(
        {
          content: '[Subagent "builder" a1b2c3d4 completed]\n\nVendor fetch fails on the first attempt.',
          details: { type: "builder", description: "Fix the flaky fetch test", status: "completed", turnCount: 3 },
        },
        options,
        defaultTheme,
        SHOW_COST,
        "id",
        true,
      );

      expect(result.children).toHaveLength(0);
      expect(renderedRows).toHaveLength(0);
    },
  );
});

describe("renderSubagentResult — worktree path display", () => {
  it("shows worktree path in details pane for a completed agent with stats", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        worktreePath: "/wt/feature",
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("worktree: /wt/feature");
  });

  it("shows worktree path in fallback result line (no turnCount)", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        worktreePath: "/wt/feature/packages/web",
      },
    };

    renderSubagentResult(message, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("worktree: /wt/feature/packages/web");
  });

  it("does not render worktree line when worktreePath is absent", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).not.toContain("worktree:");
  });
});

describe("renderSubagentResult — status icon", () => {
  it.each([
    ["queued", "◆"],
    ["running", "◈"],
    ["completed", "✓"],
    ["turn_limited", "✓"],
    ["error", "✗"],
    ["aborted", "✗"],
    ["stopped", "■"],
    ["unknown-status", "▸"],
  ])("shows %s icon for status %s", (status, icon) => {
    renderSubagentResult(
      {
        content: "Agent output",
        details: { type: "builder", description: "Build something", turnCount: 5, status },
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain(icon);
  });
});

/* ------------------------------------------------------------------ */
/*  Both collapsed result surfaces — the reply preview row            */
/* ------------------------------------------------------------------ */

/** Marks the color of every span, so a test can see which color a row carries. */
const markingTheme: Theme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `*${text}*`,
  italic: (text: string) => text,
};

/** The card's rendered lines, in order, blank rows included. */
const cardLines = () => renderedRows.flatMap((r) => (r.kind === "Spacer" ? [""] : r.text.split("\n")));

/**
 * A settled background agent's nudge exactly as emitIndividualNudge sends it: the envelope line over
 * formatResultContent output, details from buildAgentDetails.
 */
function nudge(
  result: string,
  lifecycle: Partial<AgentLifecycle>,
  opts: { error?: string; worktreePath?: string } = {},
) {
  const record = makeAgentRecord({
    result,
    ...(opts.error === undefined ? {} : { error: opts.error }),
    display: {
      description: "Fix the flaky fetch test",
      outputFile: "/tmp/pi-out.log",
      ...(opts.worktreePath === undefined ? {} : { worktreePath: opts.worktreePath }),
    },
    lifecycle: { startedAt: 1000, started: true, ...lifecycle },
  });
  return {
    content:
      `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]\n\n` +
      formatResultContent(record),
    details: buildAgentDetails(record, { includeStats: true, includeStatus: true }),
  };
}

/** A settled foreground Agent call's tool result, built the way executeAgentTool builds it. */
function foreground(result: string, lifecycle: Partial<AgentLifecycle>) {
  const record = makeAgentRecord({
    result,
    display: { description: "Fix the flaky fetch test" },
    lifecycle: { startedAt: 1000, completedAt: 61000, started: true, ...lifecycle },
    stats: { toolUses: 5, turnCount: 3 },
  });
  return {
    content: [{ type: "text", text: formatResultContent(record) }],
    details: buildAgentDetails(record, { includeStats: true }),
  };
}

/** The same details bag an older session file holds: everything but the field added in this version. */
function withoutPreview(details: Record<string, unknown>): Record<string, unknown> {
  const { replyPreview: _preview, ...stored } = details;
  return stored;
}

describe("renderSubagentResult — the tool call's row treatment", () => {
  // The card is injected at settlement, so these are the only statuses one can carry.
  it.each([
    ["completed", "toolSuccessBg"],
    ["turn_limited", "toolSuccessBg"],
    ["stopped", "toolSuccessBg"],
    ["error", "toolErrorBg"],
    ["aborted", "toolErrorBg"],
  ] as [AgentLifecycle["status"], string][])(
    "shows status %s on the %s fill a tool call's own row gets",
    (status, fill) => {
      renderSubagentResult(nudge("Done.", { status }), { expanded: false }, markingTheme, SHOW_COST);

      expect(boxFills).toEqual([`[${fill}:]`]);
    },
  );

  it("paints a settled run's card on the fill its own status names", () => {
    renderSubagentResult(workflowNudge("error"), { expanded: false }, markingTheme, SHOW_COST);

    expect(boxFills).toEqual(["[toolErrorBg:]"]);
  });

  it("paints a stopped run's Workflow card on the finished fill, not the in-flight one", () => {
    renderSubagentResult(workflowNudge("stopped"), { expanded: false }, markingTheme, SHOW_COST);

    expect(boxFills).toEqual(["[toolSuccessBg:]"]);
  });

  it("paints a message with no status on the completed fill its own icon claims", () => {
    renderSubagentResult(
      { content: "Done.", details: { type: "builder" } },
      { expanded: false },
      markingTheme,
      SHOW_COST,
    );

    expect(boxFills).toEqual(["[toolSuccessBg:]"]);
  });

  it("paints a status it does not know as a finished run, since nothing reports an error", () => {
    renderSubagentResult(
      { content: "Done.", details: { type: "builder", status: "no-such-status" } },
      { expanded: false },
      markingTheme,
      SHOW_COST,
    );

    expect(boxFills).toEqual(["[toolSuccessBg:]"]);
  });

  it("paints the card's title with the tool-call title role", () => {
    renderSubagentResult(nudge("Done.", { status: "completed" }), { expanded: false }, markingTheme, SHOW_COST);

    expect(renderedRows[0]).toEqual({ kind: "Text", text: "[toolTitle:*Subagent Result*]" });
  });
});

describe("renderSubagentResult — collapsed reply preview row", () => {
  it("shows the reply's opening line between the description and the path rows", () => {
    renderSubagentResult(
      nudge(
        "Vendor fetch fails on the first attempt.\n\nIt retries twice, then writes the log.",
        {
          status: "completed",
        },
        { worktreePath: "/wt/feature" },
      ),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "Subagent Result" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: "✓ Builder·5 uses·3 turns·1m0s\n  Fix the flaky fetch test" },
      { kind: "TruncatedText", text: "  Vendor fetch fails on the first attempt." },
      { kind: "Text", text: "  tail -f /tmp/pi-out.log\n  worktree: /wt/feature" },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
    ]);
  });

  it.each([
    ["completed", {}],
    ["error", {}],
    ["stopped", { stoppedBy: "user" }],
    ["aborted", {}],
    ["turn_limited", {}],
  ] as const)("shows the reply line for a %s agent", (status, lifecycle) => {
    renderSubagentResult(
      nudge("Stopping after two failed edits.", { status, ...lifecycle }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Stopping after two failed edits."]);
  });

  it.each([
    ["stopped", { stoppedBy: "user" }],
    ["aborted", {}],
    ["turn_limited", {}],
  ] as const)("keeps the status note off a one-line reply (%s)", (status, lifecycle) => {
    renderSubagentResult(nudge("Done.", { status, ...lifecycle }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(truncatedRows()).toEqual(["  Done."]);
  });

  it("shows the reply line when it opens with the appended error note's prefix", () => {
    renderSubagentResult(
      nudge("Error: the fixture never ran, so the suite is still red.", { status: "error" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Error: the fixture never ran, so the suite is still red."]);
  });

  it("keeps a reply that opens with a parenthetical", () => {
    renderSubagentResult(
      nudge("(nothing to do)", { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  (nothing to do)"]);
  });

  it("shows the reply line above an appended error note", () => {
    renderSubagentResult(
      nudge(
        "Stopped at the second fixture.\n\nError: looked like mine but was not.",
        { status: "error" },
        {
          error: "gave up",
        },
      ),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Stopped at the second fixture."]);
  });

  it.each([
    ["error note", "error", "spawn EACCES", {}],
    ["stop note", "stopped", undefined, { stoppedBy: "watchdog" }],
    ["no note at all", "completed", undefined, {}],
  ] as const)("adds no row when the agent said nothing (%s)", (_label, status, error, lifecycle) => {
    renderSubagentResult(nudge("", { status, ...lifecycle }, { error }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(truncatedRows()).toEqual([]);
  });

  it("adds no row when the error note carries an Error: paragraph of its own", () => {
    renderSubagentResult(
      nudge("", { status: "error" }, { error: "provider stream reset\n\nError: the retry failed too" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual([]);
  });

  it("hands a long first line to the width-truncating row component", () => {
    const longLine = "Attempted ".repeat(40).trim();

    renderSubagentResult(
      nudge(`${longLine}\n\nSecond paragraph.`, { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual([`  ${longLine}`]);
  });

  it("keeps the collapsed card unchanged when the agent said nothing", () => {
    renderSubagentResult(nudge("", { status: "completed" }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(cardLines()).toEqual([
      "Subagent Result",
      "",
      "✓ Builder·5 uses·3 turns·1m0s",
      "  Fix the flaky fetch test",
      "  tail -f /tmp/pi-out.log",
      "",
      "",
    ]);
  });

  it("renders no preview row for a message stored before the field existed", () => {
    const message = nudge("Vendor fetch fails on the first attempt.", { status: "completed" });

    renderSubagentResult(
      { content: message.content, details: withoutPreview(message.details) },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "Subagent Result" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: "✓ Builder·5 uses·3 turns·1m0s\n  Fix the flaky fetch test" },
      { kind: "Text", text: "  tail -f /tmp/pi-out.log" },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
    ]);
  });

  it("keeps the expanded card showing the whole reply with the envelope line", () => {
    renderSubagentResult(
      nudge("Line one.\n\nLine two.", { status: "completed" }),
      { expanded: true },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "Subagent Result" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: "✓ Builder·5 uses·3 turns·1m0s\n  Fix the flaky fetch test" },
      { kind: "Text", text: "  tail -f /tmp/pi-out.log" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: '  [Subagent "builder" 11111111 completed]\n  \n  Line one.\n  \n  Line two.' },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
    ]);
  });

  it("shows the reply body a nudge without stats carries", () => {
    const message = nudge("Line one.\n\nLine two.", { status: "completed" });
    const { turnCount: _turnCount, ...detailsWithoutStats } = message.details;

    renderSubagentResult(
      { content: message.content, details: detailsWithoutStats },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "Subagent Result" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: "✓ Builder\n  Fix the flaky fetch test" },
      { kind: "TruncatedText", text: "  Line one." },
      { kind: "Text", text: "  tail -f /tmp/pi-out.log" },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  The card a settlement message with no usage accounting gets        */
/* ------------------------------------------------------------------ */

/**
 * A Workflow run's settlement message exactly as the Nudge batch sends it: the run's own header over
 * the one text it published, details from the snapshot built without stats.
 */
function workflowNudge(status: AgentLifecycle["status"], text = "two findings, one nit") {
  const record = makeAgentRecord({
    id: "aaaaaaaa1111",
    ...(status === "completed" ? { result: text } : { error: text }),
    display: { type: "audit" as AgentRecord["display"]["type"], description: "audit the diff" },
    lifecycle: { status, startedAt: 1000, completedAt: 61_000, started: true },
    workflow: { name: "audit", remoteId: "wf-1", progress: [] },
  });
  return {
    content: `[Workflow "audit" ${record.id.slice(0, SHORT_ID_LENGTH)} ${status}]\n\n${text}`,
    details: { ...buildAgentDetails(record, { includeStatus: true, includeStats: false }), kind: "workflow" },
  };
}

describe("renderSubagentResult — a run with no usage accounting", () => {
  it.each([
    ["error", "✗"],
    ["stopped", "■"],
    ["aborted", "✗"],
  ] as [AgentLifecycle["status"], string][])(
    "shows the %s icon and the message body for a subagent message that reaches this branch",
    (status, icon) => {
      const { turnCount: _turnCount, ...detailsWithoutStats } = nudge("The run did not finish cleanly.", {
        status,
      }).details;
      const content = `[Subagent "builder" 11111111 ${status}]\n\nThe run did not finish cleanly.`;

      renderSubagentResult({ content, details: detailsWithoutStats }, { expanded: true }, defaultTheme, SHOW_COST);

      const card = cardLines();
      expect(card[2]).toContain(icon);
      expect(card).toContain("  The run did not finish cleanly.");
      expect(card.join("\n")).not.toMatch(/\d+ uses|\d+ turns/);
    },
  );

  it("labels the card for the run, and shows its status and body", () => {
    renderSubagentResult(workflowNudge("completed"), { expanded: true }, defaultTheme, SHOW_COST);

    // This file mocks getDisplayName, so a name here pins field pass-through, never the real
    // registry's naming: model-thinking-tag.test.ts owns the production name.
    expect(cardLines()).toEqual([
      "Workflow Result",
      "",
      "✓ audit workflow",
      "  audit the diff",
      "",
      '  [Workflow "audit" aaaaaaaa completed]',
      "  ",
      "  two findings, one nit",
      "",
      "",
    ]);
  });

  it("paints the icon the run's own status names, and invents no stats", () => {
    renderSubagentResult(
      workflowNudge("stopped", "the caller stopped the run"),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const card = cardLines().join("\n");
    expect(card).toContain("■ audit workflow");
    expect(card).not.toMatch(/\d+ uses|\d+ turns/);
  });

  it("collapses to the reply preview the snapshot carries", () => {
    renderSubagentResult(workflowNudge("completed"), { expanded: false }, defaultTheme, SHOW_COST);

    expect(truncatedRows()).toEqual(["  two findings, one nit"]);
  });

  it("moves only the label between a workflow message and a subagent one", () => {
    const message = workflowNudge("completed");
    renderSubagentResult(message, { expanded: true }, defaultTheme, SHOW_COST);
    const workflowCard = cardLines();

    renderedRows.length = 0;
    renderSubagentResult(
      { content: message.content, details: { ...message.details, kind: "agent" } },
      { expanded: true },
      defaultTheme,
      SHOW_COST,
    );
    const agentCard = cardLines();

    expect(workflowCard[0]).toBe("Workflow Result");
    expect(agentCard[0]).toBe("Subagent Result");
    expect(agentCard.slice(1)).toEqual(workflowCard.slice(1));
  });
});

describe("renderAgentToolResult — collapsed reply preview row", () => {
  it("shows the reply's opening line after the stats and description rows", () => {
    renderAgentToolResult(
      foreground("Vendor fetch fails on the first attempt.\n\nIt retries twice.", { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "  5 uses·3 turns·1m0s\n  Fix the flaky fetch test" },
      { kind: "TruncatedText", text: "  Vendor fetch fails on the first attempt." },
    ]);
  });

  it.each([
    ["stopped", { stoppedBy: "user" }],
    ["aborted", {}],
    ["turn_limited", {}],
  ] as const)("keeps the status note off a one-line reply (%s)", (status, lifecycle) => {
    renderAgentToolResult(foreground("Done.", { status, ...lifecycle }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(truncatedRows()).toEqual(["  Done."]);
  });

  it("shows the reply line when it opens with the error note's prefix", () => {
    renderAgentToolResult(
      foreground("Error: I could not reach the fixture server.", { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Error: I could not reach the fixture server."]);
  });

  it("adds no row when the agent produced no reply text", () => {
    renderAgentToolResult(foreground("", { status: "completed" }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(renderedRows).toEqual([{ kind: "Text", text: "  5 uses·3 turns·1m0s\n  Fix the flaky fetch test" }]);
  });

  it("adds no row when the settled text is only the glued status note", () => {
    renderAgentToolResult(foreground("", { status: "turn_limited" }), { expanded: false }, defaultTheme, SHOW_COST);

    expect(renderedRows).toEqual([{ kind: "Text", text: "  5 uses·3 turns·1m0s\n  Fix the flaky fetch test" }]);
  });

  it("keeps a reply whose first line opens like the card's envelope line", () => {
    renderAgentToolResult(
      foreground('[Subagent "builder" a1b2c3d4 completed]\n\nThat message was not mine.', { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(['  [Subagent "builder" a1b2c3d4 completed]']);
  });

  it("hands a long first line to the width-truncating row component", () => {
    const longLine = "Attempted ".repeat(40).trim();

    renderAgentToolResult(
      foreground(`${longLine}\n\nSecond paragraph.`, { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual([`  ${longLine}`]);
  });

  it("renders no preview row for a tool result stored before the field existed", () => {
    const result = foreground("Vendor fetch fails on the first attempt.", { status: "stopped", stoppedBy: "user" });

    renderAgentToolResult(
      { content: result.content, details: withoutPreview(result.details) },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([{ kind: "Text", text: "  5 uses·3 turns·1m0s\n  Fix the flaky fetch test" }]);
  });

  it("previews the same line on the card and on the foreground row for one settled reply", () => {
    const record = makeAgentRecord({
      result: "Vendor fetch fails on the first attempt.\n\nIt retries twice.",
      display: { description: "Fix the flaky fetch test" },
      lifecycle: { status: "stopped", stoppedBy: "user", startedAt: 1000, completedAt: 61000, started: true },
      stats: { toolUses: 5, turnCount: 3 },
    });
    const text = formatResultContent(record);

    renderAgentToolResult(
      { content: [{ type: "text", text }], details: buildAgentDetails(record, { includeStats: true }) },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );
    const foregroundRows = truncatedRows();
    renderedRows.length = 0;

    renderSubagentResult(
      {
        content: `[Subagent "builder" ${record.id.slice(0, SHORT_ID_LENGTH)} stopped]\n\n${text}`,
        details: buildAgentDetails(record, { includeStats: true, includeStatus: true }),
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(foregroundRows).toEqual(["  Vendor fetch fails on the first attempt."]);
    expect(truncatedRows()).toEqual(foregroundRows);
  });

  it("paints the preview row on the tool-output color on both surfaces", () => {
    const marked = "  [toolOutput:Vendor fetch fails on the first attempt.]";

    renderSubagentResult(
      nudge("Vendor fetch fails on the first attempt.", { status: "completed" }),
      { expanded: false },
      markingTheme,
      SHOW_COST,
    );
    const cardRows = truncatedRows();
    renderedRows.length = 0;

    renderAgentToolResult(
      foreground("Vendor fetch fails on the first attempt.", { status: "completed" }),
      { expanded: false },
      markingTheme,
      SHOW_COST,
    );

    expect(cardRows).toEqual([marked]);
    expect(truncatedRows()).toEqual([marked]);
  });

  it("adds no reply line to a background spawn's result row", () => {
    renderAgentToolResult(
      {
        content: [{ type: "text", text: "[Agent running] Success! You delegated to an agent." }],
        details: { type: "builder", description: "Fix vendor approach", agentId: "agent-abc-123", status: "running" },
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([{ kind: "Text", text: "  Fix vendor approach" }]);
  });

  it("keeps the expanded result showing the whole reply body after the description, with no preview row", () => {
    renderAgentToolResult(
      foreground("Line one.\n\nLine two.", { status: "completed" }),
      { expanded: true },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      {
        kind: "Text",
        text: "  5 uses·3 turns·1m0s\n  Fix the flaky fetch test\n  Line one.\n  \n  Line two.",
      },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolResult — icon tests                                */
/* ------------------------------------------------------------------ */

describe("renderAgentToolResult — error icon", () => {
  const baseResult = {
    content: [{ type: "text", text: "Agent output" }],
    details: {
      type: "builder",
      description: "Test agent",
      turnCount: 3,
      toolUses: 5,
      input: 100,
      output: 50,
      contextPercent: 10,
      durationMs: 60000,
    },
  };

  it("shows stats + description for foreground agent with error", () => {
    renderAgentToolResult({ ...baseResult, isError: true }, { expanded: false }, defaultTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows stats + description for foreground agent without error", () => {
    renderAgentToolResult({ ...baseResult, isError: false }, { expanded: false }, defaultTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows stats + description for foreground agent when isError is undefined", () => {
    renderAgentToolResult(baseResult, { expanded: false }, defaultTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows model tag before stats in the foreground result line", () => {
    renderAgentToolResult(
      { ...baseResult, details: { ...baseResult.details, modelName: "Sonnet", modelId: "claude-sonnet-4-5" } },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
      "id",
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("(claude-sonnet-4-5)·");
  });

  it("does not lead with a separator when the model tag is empty", () => {
    renderAgentToolResult(baseResult, { expanded: false }, defaultTheme, SHOW_COST, "id");

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("3 turns");
    expect(allText).not.toContain("  ·");
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolResult — background agent status indicators        */
/* ------------------------------------------------------------------ */

describe("renderAgentToolResult — background agent status indicators", () => {
  beforeEach(() => {
    cleanupInvalidations();
  });

  const backgroundResult = {
    content: [{ type: "text", text: "[Agent queued] Success! You delegated to an agent." }],
    details: {
      type: "builder",
      description: "Fix vendor approach",
      agentId: "agent-abc-123",
      status: "queued",
    },
  };

  it("shows only description when status is queued", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    // Icon and status are in the call line
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("✗");
  });

  it("shows only description when status is running", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "running" } },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◈");
    expect(allText).not.toContain("(running)");
    expect(allText).not.toContain("Builder");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("✗");
  });

  it("shows only description when status is completed", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "completed" } },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("(running)");
  });

  it.each(["error", "aborted", "stopped"])("shows only description when status is %s", (status) => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status } },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("✗");
    expect(allText).not.toContain("◇");
  });

  it("result renderer shows only description for background agents", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
  });

  it("result renderer shows description when manager returns null", () => {
    vi.mocked(getManager).mockReturnValue(null);

    renderAgentToolResult(backgroundResult, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description
    expect(allText).toContain("Fix vendor approach");
  });

  it("result renderer shows only description when agent is queued", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, defaultTheme, SHOW_COST);

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
  });

  it("result renderer shows only description when agent is running", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "running" } },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    const allText = renderedRows.map((r) => r.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◈");
    expect(allText).not.toContain("(running)");
    expect(allText).not.toContain("Builder");
  });
});

/* ------------------------------------------------------------------ */
/*  registerAgentInvalidation / invalidateAgentRow                    */
/* ------------------------------------------------------------------ */

describe("agent invalidation map", () => {
  beforeEach(() => {
    cleanupInvalidations();
  });

  it("registerAgentInvalidation stores and invalidateAgentRow calls the function", () => {
    const fn = vi.fn();
    registerAgentInvalidation("agent-1", fn);
    invalidateAgentRow("agent-1");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("invalidateAgentRow is a no-op for unknown agent ids", () => {
    const fn = vi.fn();
    registerAgentInvalidation("agent-1", fn);
    invalidateAgentRow("agent-unknown");
    expect(fn).not.toHaveBeenCalled();
  });

  it("cleanupInvalidations clears all entries", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerAgentInvalidation("agent-1", fn1);
    registerAgentInvalidation("agent-2", fn2);
    cleanupInvalidations();
    invalidateAgentRow("agent-1");
    invalidateAgentRow("agent-2");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it("registerAgentInvalidation overwrites previous entry for same agent", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerAgentInvalidation("agent-1", fn1);
    registerAgentInvalidation("agent-1", fn2);
    invalidateAgentRow("agent-1");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolCall — background agent icon                        */
/* ------------------------------------------------------------------ */

describe("renderAgentToolCall — background agent icon", () => {
  it("shows ▸ icon for foreground agents", () => {
    renderAgentToolCall({ agent: "builder" }, defaultTheme);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("▸");
    expect(allText).toContain("Builder");
  });

  it("shows ◆ icon for background agents (queued state)", () => {
    renderAgentToolCall({ agent: "builder", run_in_background: true }, defaultTheme);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("◆");
    expect(allText).toContain("Builder");
    expect(allText).not.toContain("◇");
  });

  it("shows ▸ icon when run_in_background is false", () => {
    renderAgentToolCall({ agent: "builder", run_in_background: false }, defaultTheme);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("▸");
  });

  it("shows model override when present", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "claude-3" }, defaultTheme);

    const allText = renderedRows.map((r) => r.text).join("\n");
    expect(allText).toContain("(claude-3)");
  });
});
