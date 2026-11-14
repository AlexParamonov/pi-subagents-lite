/**
 * conversation-viewer-compact.test.ts — Compact tool-call presentation.
 *
 * Drives the viewer's public render seam with the marking theme below, so each
 * content row is asserted as (background, text) — the exact painted sequence,
 * which pins grouping, summaries, separators, padding and result bodies at once.
 */

/* The marking theme below marks each row's colors with control characters, so the
   helpers match them on purpose. */
/* oxlint-disable no-control-regex */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { MarkdownTheme, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "../../src/ui/types.js";
import type { AgentRecord } from "../../src/types.js";
import type { ToolDisplayOptions } from "../../src/ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../../src/ui/viewer-keys.js";
import { asAgentSession, asTui } from "../pi-boundaries.js";
import { defaultTheme } from "../mock-utils.js";

const mockSubscribe = vi.fn<(listener: (event?: unknown) => void) => () => void>(() => () => {});
const mockRequestRender = vi.fn();

vi.mock("@earendil-works/pi-tui", () => {
  // Width is screen width: real ANSI and the marking theme's \u0001<bg>\u0001 and
  // \u0002<fg>\u0002 row markers cost nothing, so every rule below segments a row the
  // same way - including the wrap, which must never cut through a marker.
  const SEGMENTS = /\u0001[^\u0001]*\u0001|\u0002[^\u0002]*\u0002|\x1b\[[0-9;]*m|[\s\S]/g;
  const segmentsOf = (s: string) => s.match(SEGMENTS) ?? [];
  /** A color marker is a multi-char segment; everything else is one screen cell. */
  const cell = (seg: string) => seg.length === 1;
  const visible = (s: string) => segmentsOf(s).filter(cell).join("");
  return {
    matchesKey: vi.fn((data: string, key: string) => {
      const map: Record<string, string[]> = {
        up: ["\x1b[A", "k"],
        down: ["\x1b[B", "j"],
        pageUp: ["\x1b[5~"],
        pageDown: ["\x1b[6~"],
        home: ["\x1b[H"],
        end: ["\x1b[F"],
        enter: ["\r"],
        escape: ["\x1b"],
        q: ["q"],
        s: ["s"],
        ctrlT: ["\x14"],
      };
      return (map[key] ?? [key]).includes(data);
    }),
    Input: class {
      focused = false;
      onSubmit: ((v: string) => void) | undefined;
      onEscape: (() => void) | undefined;
      private text = "";
      handleInput(data: string) {
        if (data === "\x1b") this.onEscape?.();
        else if (data === "\r") this.onSubmit?.(this.text);
        else this.text += data;
      }
      render(_w: number): string[] {
        return ["> " + this.text];
      }
    },
    Markdown: class {
      constructor(
        text: string,
        _padX: number,
        _padY: number,
        _theme: MarkdownTheme,
        overrides?: { color?: (t: string) => string },
      ) {
        this._text = text;
        this._color = overrides?.color ?? ((t: string) => t);
      }
      _text: string;
      _color: (t: string) => string;
      setText(text: string) {
        this._text = text;
      }
      render(width: number): string[] {
        // pi's Markdown paints nothing for blank text, so a blank block cannot be a
        // run boundary; the mock has to agree or the viewer's boundary rule is untestable.
        if (this._text.trim() === "") return [];
        return this._text
          .split("\n")
          .map((line) => (line.length > width ? line.slice(0, width) : line))
          .map(this._color);
      }
    },
    truncateToWidth: vi.fn((s: string, w: number) => (visible(s).length > w ? visible(s).slice(0, w - 3) + "..." : s)),
    visibleWidth: vi.fn((s: string) => visible(s).length),
    wrapTextWithAnsi: vi.fn((text: string, width: number) => {
      const rows: string[] = [];
      for (const line of text.split("\n")) {
        let row = "";
        let used = 0;
        for (const seg of segmentsOf(line)) {
          if (cell(seg)) {
            if (used === width) {
              rows.push(row);
              row = "";
              used = 0;
            }
            used++;
          }
          row += seg;
        }
        rows.push(row);
      }
      return rows;
    }),
  };
});
vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

import { getHideThinkingBlock } from "../../src/pi-settings.js";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { expectNoTerminalControls } from "../fixtures.js";

// --- Fixtures ---

/**
 * Marks the background and the foreground token each row was painted with, so
 * status fills and neutral styling are both observable. The markers are control
 * characters, so a frame-wide control check needs defaultTheme.
 */
const markingTheme: Theme = {
  fg: (color: string, text: string) => `${text}\u0002${color}\u0002`,
  bg: (color: string, text: string) => `\u0001${color}\u0001${text}`,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

interface TestContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
interface TestMessage {
  role: string;
  content: string | TestContentBlock[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
}

/** One assistant message carrying these tool calls, in this order. */
function callsOf(...calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>): TestMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args })),
  };
}
function resultOf(
  id: string,
  opts: { name?: string; text?: string; isError?: boolean; durationMs?: number } = {},
): TestMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: opts.name ?? "uniqtool",
    isError: opts.isError ?? false,
    content: [{ type: "text", text: opts.text ?? "" }],
    durationMs: opts.durationMs,
  };
}
function textOf(text: string): TestMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function thinkingOf(thinking: string): TestMessage {
  return { role: "assistant", content: [{ type: "thinking", thinking }] };
}
function userOf(text: string): TestMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** The viewer's session subscriber, captured so a test can deliver live events. */
let emit: (event?: unknown) => void = () => {};

interface CompactView {
  /** pi's global tool-output flag, in a holder the test flips. */
  flag?: { expanded: boolean };
  /** Tools the viewer keeps individually; defaults to the shipped default list. */
  ungrouped?: string[];
  /** false opens the ordinary viewer, with the preferences still carried in. */
  compact?: boolean;
  toolDisplay?: ToolDisplayOptions;
  keybindings?: ViewerKeybindings;
  rows?: number;
  /** Identity theme, for tests that inspect the frame's own characters. */
  plain?: boolean;
}

function openCompactView(messages: TestMessage[], view: CompactView = {}): ConversationViewer {
  const session = asAgentSession({ messages, subscribe: mockSubscribe });
  mockSubscribe.mockImplementation((listener: (event?: unknown) => void) => {
    emit = listener;
    return () => {};
  });
  const record = {
    id: "abc12345",
    lifecycle: { status: "running", startedAt: Date.now() - 30000, started: true },
    display: { type: "builder", description: "test agent", invocation: { modelName: "sonnet" } },
    stats: {
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0 },
      toolUses: 5,
      turnCount: 10,
      compactionCount: 0,
    },
    execution: { settled: false, settlementCount: 0, session },
  } as unknown as AgentRecord;
  const tui = asTui({ terminal: { rows: view.rows ?? 40, cols: 120 }, requestRender: mockRequestRender });
  return new ConversationViewer(tui, session, record, view.plain ? defaultTheme : markingTheme, vi.fn(), {
    compactToolCalls: view.compact !== false,
    ungroupedTools: view.ungrouped ?? ["write", "edit", "replace", "bash"],
    keybindings: view.keybindings,
    toolDisplay: { isExpanded: () => view.flag?.expanded ?? false, ...view.toolDisplay },
  });
}

/** A content row: the status background it was painted on and its text. */
interface PaintedRow {
  bg: string;
  text: string;
}

/** Width on screen: ANSI and the test theme's color markers cost nothing there. */
function visibleWidthOf(line: string): number {
  return stripMarkers(line).length;
}

const BG_MARKER = /\u0001[^\u0001]*\u0001/g;
const FG_MARKER = /\u0002[^\u0002]*\u0002/g;
const BG_TOKEN = /\u0001([^\u0001]*)\u0001/;

/** A line with the marking theme's color markers removed. */
function stripMarkers(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(BG_MARKER, "")
    .replace(FG_MARKER, "");
}

/** The text between a frame line's borders, color markers left in place. */
function frameContent(line: string): string {
  return line.replace(/^\u2502(?:\u0002[^\u0002]*\u0002)? /, "").replace(/ \u2502(?:\u0002[^\u0002]*\u0002)?$/, "");
}

/** The content rows of one painted frame, without the viewport's trailing pad. */
function contentRows(viewer: ConversationViewer, width = 80): PaintedRow[] {
  const lines = viewer.render(width);
  const separator = `\u2502 ${"\u2500".repeat(width - 4)} \u2502`;
  const clean = lines.map(stripMarkers);
  const rows = lines.slice(clean.indexOf(separator) + 1, clean.lastIndexOf(separator)).map((line) => {
    const content = frameContent(line);
    const [, bg] = content.match(BG_TOKEN) ?? [];
    return { bg: bg ?? "", text: stripMarkers(content).trim() };
  });
  while (rows.length > 0 && rows[rows.length - 1]!.text === "") rows.pop();
  return rows;
}

/** The foreground token the first row holding `needle` was painted with. */
function paintedFg(viewer: ConversationViewer, needle: string, width = 80): string {
  const line = viewer.render(width).find((l) => l.includes(needle));
  expect(line, `no painted row holds ${needle}`).toBeDefined();
  const content = frameContent(line!).replace(BG_MARKER, "");
  const tokens = content.match(/\u0002([^\u0002]*)\u0002/g) ?? [];
  // Markers are suffixes, so the outermost color's marker is the last one in the row.
  const [, fg] = tokens[tokens.length - 1]?.match(/\u0002([^\u0002]*)\u0002/) ?? [];
  return fg ?? "";
}

/** Frame rows holding `needle` — a locator for a click, not an assertion. */
function rowsHolding(viewer: ConversationViewer, needle: string, width = 80): number[] {
  const indexes: number[] = [];
  viewer.render(width).forEach((line, index) => {
    if (line.includes(needle)) indexes.push(index);
  });
  return indexes;
}

function click(y: number): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 5,
    y,
    screenX: 10,
    screenY: 10 + y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function wheel(delta: number): TuiMouseEvent {
  return { ...click(0), type: "wheel", button: "none", wheelDelta: delta };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ConversationViewer compact tool calls", () => {
  it("summarizes consecutive eligible calls as one count-and-names row", () => {
    const viewer = openCompactView([callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" })]);

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
  });

  it("counts every call and lists unique names in first-seen order", () => {
    const viewer = openCompactView(
      [
        callsOf(
          { id: "t1", name: "read" },
          { id: "t2", name: "read" },
          { id: "t3", name: "grep" },
          { id: "t4", name: "bash" },
          { id: "t5", name: "read" },
        ),
      ],
      { ungrouped: [] },
    );

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "5 tool calls (read, grep, bash)" }]);
  });

  it("paints the summary on the pending background, with no timing", () => {
    const transcript = [
      callsOf({ id: "t1", name: "read", args: { path: "/a.md" } }, { id: "t2", name: "grep" }),
      resultOf("t1", { durationMs: 1000, isError: true, text: "fixture-failure" }),
      resultOf("t2", { durationMs: 200 }),
    ];

    const summarized = openCompactView(transcript);
    expect(contentRows(summarized)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
    expect(paintedFg(summarized, "2 tool calls")).toBe("toolTitle"); // painted like any other call row

    // Shown one by one, the same calls carry their own status colors.
    expect(contentRows(openCompactView(transcript, { flag: { expanded: true } }))).toEqual([
      { bg: "toolErrorBg", text: 'read("/a.md")  Took 1.0s' },
      { bg: "", text: "" },
      { bg: "toolSuccessBg", text: "grep  Took 0.2s" },
    ]);
  });

  it("shows a lone eligible call as its own call row", () => {
    const viewer = openCompactView([callsOf({ id: "t1", name: "read", args: { path: "/notes.md" } })]);

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: 'read("/notes.md")' }]);
  });

  it("keeps an excluded call whole between a summarized run and a compact call", () => {
    const viewer = openCompactView([
      callsOf(
        { id: "t1", name: "read" },
        { id: "t2", name: "read" },
        { id: "t3", name: "grep" },
        { id: "t4", name: "bash", args: { command: "ls -la" } },
        { id: "t5", name: "read" },
      ),
    ]);

    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "3 tool calls (read, grep)" },
      { bg: "toolPendingBg", text: "" },
      { bg: "toolPendingBg", text: 'bash("ls -la")' },
      { bg: "toolPendingBg", text: "" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "read" },
    ]);
  });

  it("shows an excluded call with its result, and splits the run around it", () => {
    const viewer = openCompactView([
      callsOf(
        { id: "t1", name: "read" },
        { id: "t2", name: "grep" },
        { id: "t3", name: "write", args: { path: "/notes.md", content: "hello" } },
        { id: "t4", name: "read" },
        { id: "t5", name: "grep" },
      ),
      resultOf("t3", { name: "write", durationMs: 1200, text: "fixture-write-result" }),
    ]);

    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "2 tool calls (read, grep)" },
      { bg: "toolSuccessBg", text: "" },
      { bg: "toolSuccessBg", text: 'write("/notes.md", 5 chars)  Took 1.2s' },
      { bg: "toolSuccessBg", text: "fixture-write-result" },
      { bg: "toolSuccessBg", text: "" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "2 tool calls (read, grep)" },
    ]);
  });

  it.each([false, true])("renders excluded calls exactly as the ordinary viewer with tools expanded=%s", (expanded) => {
    const flag = { expanded };
    const transcript = [
      callsOf(
        { id: "t1", name: "write", args: { path: "/a.md", content: "hello" } },
        { id: "t2", name: "bash", args: { command: "ls -la" } },
      ),
      resultOf("t1", { name: "write", text: "fixture-write-result" }),
      resultOf("t2", { name: "bash", text: "fixture-bash-result" }),
      textOf("end"),
    ];

    expect(contentRows(openCompactView(transcript, { flag }))).toEqual(
      contentRows(openCompactView(transcript, { compact: false, flag })),
    );
  });

  it("refreshes an excluded call's whole block when its result lands", () => {
    const messages = [callsOf({ id: "t1", name: "write", args: { path: "/a.md", content: "hi" } }), textOf("end")];
    const viewer = openCompactView(messages);
    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "" },
      { bg: "toolPendingBg", text: 'write("/a.md", 2 chars)' },
      { bg: "toolPendingBg", text: "" },
      { bg: "", text: "" },
      { bg: "", text: "end" },
    ]);

    messages.push(resultOf("t1", { name: "write", durationMs: 500, text: "fixture-write-result" }));
    expect(contentRows(viewer)).toEqual([
      { bg: "toolSuccessBg", text: "" },
      { bg: "toolSuccessBg", text: 'write("/a.md", 2 chars)  Took 0.5s' },
      { bg: "toolSuccessBg", text: "fixture-write-result" },
      { bg: "toolSuccessBg", text: "" },
      { bg: "", text: "" },
      { bg: "", text: "end" },
    ]);
  });

  it("matches excluded names exactly, so a custom name stays and a differently cased one groups", () => {
    const custom = openCompactView(
      [callsOf({ id: "t1", name: "mcp__search" }, { id: "t2", name: "mcp__search" }), textOf("end")],
      { ungrouped: ["mcp__search"] },
    );
    expect(contentRows(custom)).toEqual([
      { bg: "toolPendingBg", text: "" },
      { bg: "toolPendingBg", text: "mcp__search" },
      { bg: "toolPendingBg", text: "" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "" },
      { bg: "toolPendingBg", text: "mcp__search" },
      { bg: "toolPendingBg", text: "" },
      { bg: "", text: "" },
      { bg: "", text: "end" },
    ]);

    const cased = openCompactView([callsOf({ id: "t1", name: "Read" }, { id: "t2", name: "Read" })], {
      ungrouped: ["read"],
    });
    expect(contentRows(cased)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (Read)" }]);
  });

  it("groups consecutive calls from different turns", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read" }),
      resultOf("t1"),
      callsOf({ id: "t2", name: "grep" }),
      resultOf("t2"),
    ]);

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
  });

  it("does not group across visible assistant text", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read" }),
      textOf("fixture-visible-answer"),
      callsOf({ id: "t2", name: "grep" }),
    ]);

    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "fixture-visible-answer" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
    ]);
  });

  it("groups across a blank text block, because it paints no row at all", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read" }),
      textOf("\n"),
      callsOf({ id: "t2", name: "grep" }),
    ]);

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
  });

  it("does not group across a user turn, whose own presentation is untouched", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read" }),
      userOf("fixture-user-turn"),
      callsOf({ id: "t2", name: "grep" }),
    ]);

    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "userMessageBg", text: "" },
      { bg: "userMessageBg", text: "fixture-user-turn" },
      { bg: "userMessageBg", text: "" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
    ]);
  });

  it("keeps a call and the text of one message in the order the viewer already paints them", () => {
    const viewer = openCompactView([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "read" },
          { type: "text", text: "answer" },
        ],
      },
    ]);

    expect(contentRows(viewer)).toEqual([
      { bg: "", text: "answer" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "read" },
    ]);
  });

  it("renders a conversation with no calls, and an empty one, unchanged", () => {
    expect(contentRows(openCompactView([textOf("fixture-only-text")]))).toEqual([
      { bg: "", text: "fixture-only-text" },
    ]);
    expect(contentRows(openCompactView([]))).toEqual([{ bg: "", text: "(waiting for first message...)" }]);
  });

  it("keeps a result out of the frame whether calls are summarized or shown one by one", () => {
    const transcript = [
      callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" }),
      resultOf("t1", { text: "fixture-result-detail" }),
      resultOf("t2", { text: "fixture-second-result" }),
    ];

    expect(contentRows(openCompactView(transcript))).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
    expect(contentRows(openCompactView(transcript, { flag: { expanded: true } }))).toEqual([
      { bg: "toolSuccessBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolSuccessBg", text: "grep" },
    ]);
  });

  it("keeps arguments, timing and per-call color on one row per individually shown call", () => {
    const viewer = openCompactView(
      [
        callsOf(
          { id: "t1", name: "write", args: { path: "/a.md", content: "hello" } },
          { id: "t2", name: "write", args: { path: "/b.md", content: "hello" } },
        ),
        resultOf("t1", { durationMs: 4200, text: "fixture-result-detail" }),
        resultOf("t2", { durationMs: 100, isError: true, text: "fixture-failure-detail" }),
      ],
      { flag: { expanded: true }, ungrouped: [] },
    );

    expect(contentRows(viewer)).toEqual([
      { bg: "toolSuccessBg", text: 'write("/a.md", 5 chars)  Took 4.2s' },
      { bg: "", text: "" },
      { bg: "toolErrorBg", text: 'write("/b.md", 5 chars)  Took 0.1s' },
    ]);
  });

  it("wraps a long call over several rows of its own color without passing the frame width", () => {
    const viewer = openCompactView([callsOf({ id: "t1", name: "bash", args: { command: "x".repeat(120) } })], {
      ungrouped: [],
    });

    const rows = contentRows(viewer, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.bg === "toolPendingBg" && row.text !== "")).toBe(true);
    expect(rows.map((row) => row.text).join("")).toContain("x".repeat(120));
    expect(viewer.render(40).every((line) => visibleWidthOf(line) <= 40)).toBe(true);
  });

  it("wraps a long run summary inside the frame without losing the names", () => {
    const viewer = openCompactView([
      callsOf(
        { id: "t1", name: "mcp_server_read_file" },
        { id: "t2", name: "mcp_server_list_dir" },
        { id: "t3", name: "read" },
      ),
    ]);

    const rows = contentRows(viewer, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.bg === "toolPendingBg")).toBe(true);
    // Wrapping may split the row anywhere, but it must not drop or garble a name.
    expect(rows.map((row) => row.text).join("")).toBe("3 tool calls (mcp_server_read_file, mcp_server_list_dir, read)");
    expect(viewer.render(40).every((line) => visibleWidthOf(line) <= 40)).toBe(true);
  });

  it("puts exactly one blank row between adjacent compact rows, and none at either end", () => {
    const three = openCompactView(
      [callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" }, { id: "t3", name: "find" })],
      { flag: { expanded: true } },
    );
    expect(contentRows(three)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "find" },
    ]);

    const beforeText = openCompactView(
      [callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" }), textOf("answer")],
      { flag: { expanded: true } },
    );
    expect(contentRows(beforeText)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
      { bg: "", text: "answer" },
    ]);
  });

  it("counts a tool-result message as no separator of its own", () => {
    const viewer = openCompactView(
      [
        callsOf({ id: "t1", name: "read" }),
        resultOf("t1", { text: "fixture-result-detail" }),
        callsOf({ id: "t2", name: "grep" }),
      ],
      { flag: { expanded: true } },
    );

    expect(contentRows(viewer)).toEqual([
      { bg: "toolSuccessBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
    ]);
  });

  it("shows no thinking at all while it is hidden, collapsed or expanded", () => {
    vi.mocked(getHideThinkingBlock).mockReturnValue(true);
    const transcript = [thinkingOf("fixture-hidden-thought"), callsOf({ id: "t1", name: "read" }), textOf("answer")];

    expect(contentRows(openCompactView(transcript))).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "answer" },
    ]);
    expect(contentRows(openCompactView(transcript, { flag: { expanded: true } }))).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "answer" },
    ]);
  });

  it("never shows the live thinking indicator either, until thinking is revealed", () => {
    vi.mocked(getHideThinkingBlock).mockReturnValue(true);
    const viewer = openCompactView([callsOf({ id: "t1", name: "read" })]);

    emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "fixture-live-thought" } });
    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "read" }]);

    viewer.handleInput("\x14");
    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "fixture-live-thought" },
    ]);
  });

  it("splits a cross-turn run when thinking is revealed and joins it again when hidden", () => {
    vi.mocked(getHideThinkingBlock).mockReturnValue(true);
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read" }),
      thinkingOf("fixture-hidden-thought"),
      callsOf({ id: "t2", name: "grep" }),
    ]);

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);

    viewer.handleInput("\x14"); // reveal thinking: the run splits at the visible block
    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "fixture-hidden-thought" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
    ]);

    viewer.handleInput("\x14"); // hide it again: the same two calls are one run
    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
  });

  it("regroups as calls are appended and settle, without dropping or repeating one", () => {
    const messages = [callsOf({ id: "t1", name: "read" }), resultOf("t1")];
    const viewer = openCompactView(messages, { ungrouped: [] });
    expect(contentRows(viewer)).toEqual([{ bg: "toolSuccessBg", text: "read" }]);

    messages.push(callsOf({ id: "t2", name: "grep" }, { id: "t3", name: "bash" }));
    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "3 tool calls (read, grep, bash)" }]);

    messages.push(resultOf("t2"), resultOf("t3"));
    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "3 tool calls (read, grep, bash)" }]);
  });

  it("groups a call that arrives in the streaming message, whose object is replaced in place", () => {
    const messages = [callsOf({ id: "t1", name: "read" })];
    const viewer = openCompactView(messages);
    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "read" }]);

    // pi replaces the last array slot as the partial message grows: same reference, same length.
    const grew = callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" });
    messages[messages.length - 1] = grew;
    emit({ type: "message_end", message: grew });

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (read, grep)" }]);
  });

  it("leaves a collapsed summary untouched when it is clicked", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "read", args: { path: "/a.md" } }, { id: "t2", name: "grep" }),
      resultOf("t1"),
      resultOf("t2"),
    ]);
    const summary = { bg: "toolPendingBg", text: "2 tool calls (read, grep)" };
    const [summaryRow] = rowsHolding(viewer, "2 tool calls");

    expect(contentRows(viewer)).toEqual([summary]);
    expect(viewer.handleMouse(click(summaryRow!))).toBeUndefined();
    expect(contentRows(viewer)).toEqual([summary]);
  });

  it("has no click target on a call that has not settled", () => {
    const viewer = openCompactView([callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" })], {
      flag: { expanded: true },
    });
    const [pendingRow] = rowsHolding(viewer, "read");

    expect(viewer.handleMouse(click(pendingRow!))).toBeUndefined();
    expect(contentRows(viewer)).toEqual([
      { bg: "toolPendingBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolPendingBg", text: "grep" },
    ]);
  });

  it("keeps clicking the right call when revealing thinking splits a run", () => {
    vi.mocked(getHideThinkingBlock).mockReturnValue(true);
    const long = "y".repeat(400);
    const viewer = openCompactView(
      [
        callsOf({ id: "t1", name: "bash", args: { command: `echo ${long} ONE` } }),
        resultOf("t1"),
        thinkingOf("fixture-hidden-thought"),
        callsOf({ id: "t2", name: "bash", args: { command: `ls ${long} TWO` } }),
        resultOf("t2"),
      ],
      { ungrouped: [] },
    );
    const shown = () =>
      contentRows(viewer)
        .map((row) => row.text)
        .join("");

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (bash)" }]);
    expect(viewer.handleMouse(click(rowsHolding(viewer, "2 tool calls")[0]!))).toBeUndefined();

    viewer.handleInput("\x14"); // reveal thinking: the run splits into two compact rows around the block
    expect(shown()).toContain("fixture-hidden-thought");
    const [secondCall] = rowsHolding(viewer, "ls ");
    expect(viewer.handleMouse(click(secondCall!))).toEqual({ handled: true });

    expect(shown()).toContain(`ls ${long} TWO`); // the call under the pointer opened its own arguments
    expect(shown()).not.toContain(`echo ${long} ONE`);
  });

  it("expands only the clicked call's arguments, keeps pi's flag alone, and still shows no result", () => {
    const long = "y".repeat(400);
    const flag = { expanded: false };
    const viewer = openCompactView(
      [
        callsOf({ id: "t1", name: "bash", args: { command: `echo ${long}` } }),
        textOf("between"),
        callsOf({ id: "t2", name: "bash", args: { command: `ls ${long}` } }),
        resultOf("t1", { text: "fixture-result-detail" }),
        resultOf("t2", { text: "fixture-other-result" }),
      ],
      { flag, ungrouped: [] },
    );
    const collapsed = contentRows(viewer).map((row) => row.text);
    expect(collapsed.filter((text) => text.includes("echo"))).toHaveLength(1);

    const [firstCall] = rowsHolding(viewer, "echo");
    expect(viewer.handleMouse(click(firstCall!))).toEqual({ handled: true });

    const texts = contentRows(viewer).map((row) => row.text);
    expect(texts.join("")).toContain(`echo ${long}`); // the clicked call now shows its whole argument
    expect(texts.filter((text) => text.includes("ls"))).toHaveLength(1); // the other one stays collapsed
    expect(texts.join("")).not.toContain("fixture-result-detail");
    expect(flag.expanded).toBe(false); // a per-call choice leaves pi's flag alone
  });

  it("opens an excluded call's result when it is clicked, exactly as in the ordinary viewer", () => {
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "write", args: { path: "/a.md", content: "hello" } }),
      resultOf("t1", { name: "write", text: "line1\nline2\nline3\nline4\nline5" }),
    ]);
    const shown = () =>
      contentRows(viewer)
        .map((row) => row.text)
        .join(" ");

    expect(shown()).toContain("line3");
    expect(shown()).toContain("2 more lines"); // the collapsed preview the normal viewer shows
    expect(shown()).not.toContain("line5");

    const [writeRow] = rowsHolding(viewer, "write(");
    expect(viewer.handleMouse(click(writeRow!))).toEqual({ handled: true });

    expect(shown()).toContain("line5");
    expect(shown()).not.toContain("more lines");
  });

  it("keeps a clicked call's whole block when a later timing tick rebuilds the frame", () => {
    const long = "y".repeat(400);
    const viewer = openCompactView([
      callsOf({ id: "t1", name: "write", args: { path: `/notes/${long}.md`, content: "hello" } }),
      resultOf("t1", { name: "write", text: "line1\nline2\nline3\nline4\nline5" }),
      callsOf({ id: "t2", name: "grep" }),
    ]);
    const shown = () =>
      contentRows(viewer)
        .map((row) => row.text)
        .join("");

    expect(shown()).toContain("2 more lines");
    const [writeRow] = rowsHolding(viewer, "write(");
    expect(viewer.handleMouse(click(writeRow!))).toEqual({ handled: true });
    expect(shown()).toContain("line5");

    emit({ type: "tool_execution_start", toolCallId: "t2" }); // the 1s elapsed tick of another call

    expect(shown()).toContain("line5"); // the rebuild keeps the block the click opened
    expect(shown()).not.toContain("more lines");
  });

  it("groups every call once the exclusion list is emptied", () => {
    const viewer = openCompactView(
      [callsOf({ id: "t1", name: "write", args: { path: "/a.md", content: "hi" } }, { id: "t2", name: "edit" })],
      { ungrouped: [] },
    );

    expect(contentRows(viewer)).toEqual([{ bg: "toolPendingBg", text: "2 tool calls (write, edit)" }]);
  });

  it("maps a click to the frame it saw, after scrolling moved the grouped transcript", () => {
    const long = "y".repeat(400);
    const notes = Array.from({ length: 12 }, (_unused, index) => userOf(`note${index + 1}`));
    const viewer = openCompactView(
      [
        ...notes,
        callsOf(
          { id: "t1", name: "bash", args: { command: `echo ${long} ONETOKEN` } },
          { id: "t2", name: "bash", args: { command: `ls ${long} TWOTOKEN` } },
        ),
        resultOf("t1"),
        resultOf("t2"),
      ],
      { rows: 24, flag: { expanded: true }, ungrouped: [] },
    );
    const scroll = (delta: number) => {
      viewer.handleMouse(wheel(delta));
      viewer.render(80);
    };
    const shown = () =>
      contentRows(viewer)
        .map((row) => row.text)
        .join("");

    scroll(999);
    const [secondCall] = rowsHolding(viewer, "TWOTOKEN");
    expect(secondCall).toBeGreaterThan(0); // the second call is the one on screen

    viewer.handleMouse(wheel(-999)); // scrolled, not yet repainted: the paint decides what a click hits
    expect(viewer.handleMouse(click(secondCall!))).toEqual({ handled: true });

    scroll(999);
    expect(shown()).toContain("ONETOKEN"); // the other call kept pi's expanded argument
    expect(shown()).not.toContain("TWOTOKEN"); // the call under the pointer collapsed its own
  });

  it("keeps its grouping decision to itself when compact mode is off", () => {
    const transcript = [
      callsOf({ id: "t1", name: "read", args: { path: "/a.md" } }, { id: "t2", name: "grep" }),
      resultOf("t1", { text: "fixture-result-detail" }),
      resultOf("t2"),
    ];
    const rows = contentRows(openCompactView(transcript, { compact: false, ungrouped: [] }));

    expect(rows.some((row) => row.text === "fixture-result-detail")).toBe(true); // results come back
    expect(rows.some((row) => row.bg === "toolSuccessBg" && row.text === "")).toBe(true); // so do the fill bars
    expect(rows.some((row) => row.text.includes("tool calls"))).toBe(false); // and no summary is ever built
  });

  it("renders no terminal control from a hostile tool name in a summary", () => {
    const hostile = "grep\u009b31mred\u001b]0;window-title\u0007";
    const viewer = openCompactView(
      [callsOf({ id: "t1", name: hostile, args: { path: "A\u009b?1049hB done" } }, { id: "t2", name: hostile })],
      { plain: true },
    );

    const frame = viewer.render(80);
    expectNoTerminalControls(frame);
    expect(frame.join("\n")).toContain("2 tool calls (grepred)");
    expect(frame.join("\n")).not.toContain("window-title");
  });

  it("summarizes again under a remapped expansion key, after telling pi to expand", () => {
    const flag = { expanded: false };
    const toggleExpanded = vi.fn(() => {
      flag.expanded = !flag.expanded;
    });
    const viewer = openCompactView(
      [callsOf({ id: "t1", name: "read" }, { id: "t2", name: "grep" }), resultOf("t1"), resultOf("t2")],
      {
        flag,
        toolDisplay: { toggleExpanded },
        keybindings: { matches: (data, id) => id === "app.tools.expand" && data === "\u001be" },
      },
    );

    viewer.handleInput("\u000f"); // pi's default key: not bound here, so nothing moves
    expect(toggleExpanded).not.toHaveBeenCalled();

    viewer.handleInput("\u001be");
    expect(toggleExpanded).toHaveBeenCalledOnce(); // the host's own setter, so pi's chat follows too
    expect(contentRows(viewer)).toEqual([
      { bg: "toolSuccessBg", text: "read" },
      { bg: "", text: "" },
      { bg: "toolSuccessBg", text: "grep" },
    ]);
  });

  it("drops a per-call choice when pi's flag flips back to summaries", () => {
    const long = "y".repeat(400);
    const flag = { expanded: false };
    const viewer = openCompactView(
      [
        callsOf(
          { id: "t1", name: "bash", args: { command: `echo ${long}` } },
          { id: "t2", name: "grep", args: { pattern: long, path: "/src" } },
        ),
        resultOf("t1"),
        resultOf("t2"),
      ],
      { flag, ungrouped: [] },
    );
    const summary = { bg: "toolPendingBg", text: "2 tool calls (bash, grep)" };
    expect(contentRows(viewer)).toEqual([summary]);

    flag.expanded = true;
    const [firstCall] = rowsHolding(viewer, "echo");
    expect(viewer.handleMouse(click(firstCall!))).toEqual({ handled: true });
    expect(contentRows(viewer).filter((row) => row.text.includes("echo"))).toHaveLength(1);

    flag.expanded = false;
    expect(contentRows(viewer)).toEqual([summary]);
  });
});
