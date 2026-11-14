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
    children: Component[] = [];
    addChild(c: Component) {
      this.children.push(c);
    }
  },
  visibleWidth: (text: string) => text.length,
}));

beforeEach(() => {
  renderedRows.length = 0;
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
import type { AgentLifecycle } from "../../src/types.js";
import { SHORT_ID_LENGTH } from "../../src/types.js";
import { formatResultContent } from "../../src/agents/tool-execution.js";
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
/*  renderSubagentResult — reply first line on the collapsed card     */
/* ------------------------------------------------------------------ */

describe("renderSubagentResult — reply first line", () => {
  const nudgeDetails = {
    type: "builder",
    description: "Fix the flaky fetch test",
    status: "completed",
    turnCount: 3,
    outputFile: "/tmp/pi-out.log",
  };

  /** A settled agent's nudge as emitIndividualNudge sends it: envelope line over formatResultContent output. */
  const nudge = (result: string, lifecycle: Partial<AgentLifecycle>, error?: string) => {
    const record = makeAgentRecord({
      result,
      ...(error === undefined ? {} : { error }),
      lifecycle: { startedAt: 1000, started: true, ...lifecycle },
    });
    const status = record.lifecycle.status;
    return {
      content:
        `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${status}]\n\n` +
        formatResultContent(record),
      details: { ...nudgeDetails, status },
    };
  };

  /** Text of the rows the card built as width-truncated single rows, i.e. the reply preview rows. */
  const truncatedRows = () => renderedRows.filter((r) => r.kind === "TruncatedText").map((r) => r.text);
  /** The card's rendered lines, in order, blank rows included. */
  const cardLines = () => renderedRows.flatMap((r) => (r.kind === "Spacer" ? [""] : r.text.split("\n")));

  it("shows the reply's first line while tool output is collapsed", () => {
    renderSubagentResult(
      {
        content:
          '[Subagent "builder" a1b2c3d4 completed]\n\nVendor fetch fails on the first attempt.\n\nIt retries twice, then writes the log.',
        details: nudgeDetails,
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Vendor fetch fails on the first attempt."]);
  });

  it("skips the envelope line and the blank lines that follow it", () => {
    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 completed]\n\n\n   \n  Heading line\n\nBody sentence.',
        details: nudgeDetails,
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Heading line"]);
  });

  it.each([
    ["completed", undefined, {}],
    ["error", "spawn EACCES", {}],
    ["stopped", undefined, { stoppedBy: "user" }],
  ] as const)("shows the reply line for a %s agent", (status, error, lifecycle) => {
    renderSubagentResult(
      nudge("Stopping after two failed edits.", { status, ...lifecycle }, error),
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

  it("keeps a reply that opens with a parenthetical", () => {
    renderSubagentResult(
      nudge("(nothing to do)", { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  (nothing to do)"]);
  });

  it("keeps a prose parenthetical at the end of a one-line reply under a status note", () => {
    renderSubagentResult(
      nudge("Fixed the flake (see notes.md)", { status: "stopped", stoppedBy: "user" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Fixed the flake (see notes.md)"]);
  });

  it("keeps a parenthetical in a completed one-line reply untouched", () => {
    renderSubagentResult(
      nudge("Fixed the flake (see notes.md)", { status: "completed" }),
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual(["  Fixed the flake (see notes.md)"]);
  });

  it.each([
    ["error note", "error", "spawn EACCES", {}],
    ["stop note", "stopped", undefined, { stoppedBy: "watchdog" }],
    ["envelope only", "completed", undefined, {}],
  ] as const)("adds no row when the agent said nothing (%s)", (_label, status, error, lifecycle) => {
    renderSubagentResult(nudge("", { status, ...lifecycle }, error), { expanded: false }, defaultTheme, SHOW_COST);

    expect(truncatedRows()).toEqual([]);
  });

  it("adds no row for a reply line that reads exactly like the error note", () => {
    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 error]\n\nError: the fixtures are already red',
        details: { ...nudgeDetails, status: "error" },
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual([]);
  });

  it("hands a long first line to the width-truncating row component", () => {
    const longLine = "Attempted ".repeat(40).trim();
    renderSubagentResult(
      {
        content: `[Subagent "builder" a1b2c3d4 completed]\n\n${longLine}\n\nSecond paragraph.`,
        details: nudgeDetails,
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(truncatedRows()).toEqual([`  ${longLine}`]);
  });

  it("keeps the collapsed card unchanged when the agent said nothing", () => {
    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 completed]\n\n\n  ',
        details: { ...nudgeDetails, status: "completed" },
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

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

  it("puts the reply line between the description and the output file row", () => {
    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 completed]\n\nVendor fetch fails on the first attempt.\n\nDetails.',
        details: { ...nudgeDetails, worktreePath: "/wt/feature" },
      },
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

  it("keeps the expanded card showing the whole reply with the envelope line", () => {
    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 completed]\n\nLine one.\n\nLine two.',
        details: nudgeDetails,
      },
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
      { kind: "Text", text: '  [Subagent "builder" a1b2c3d4 completed]\n  \n  Line one.\n  \n  Line two.' },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
    ]);
  });

  it("keeps the fallback line unchanged for a nudge without stats", () => {
    const { turnCount: _turnCount, ...detailsWithoutStats } = nudgeDetails;

    renderSubagentResult(
      {
        content: '[Subagent "builder" a1b2c3d4 completed]\n\nLine one.\n\nLine two.',
        details: detailsWithoutStats,
      },
      { expanded: false },
      defaultTheme,
      SHOW_COST,
    );

    expect(renderedRows).toEqual([
      { kind: "Text", text: "Subagent Result" },
      { kind: "Spacer", text: "" },
      { kind: "Text", text: "✓ Builder\n  Fix the flaky fetch test\n  tail -f /tmp/pi-out.log" },
      { kind: "Spacer", text: "" },
      { kind: "Spacer", text: "" },
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
