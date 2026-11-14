/**
 * conversation-viewer.test.ts — Tests for ConversationViewer.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { MarkdownTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import type { ViewerKeybindings } from "../../src/ui/viewer-keys.js";
import { asAgentSession } from "../pi-boundaries.js";

// --- Mocks ---

const mockSubscribe = vi.fn<(listener: (event?: unknown) => void) => () => void>(() => () => {});
const mockRequestRender = vi.fn();

vi.mock("@earendil-works/pi-tui", () => ({
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
      const lines = this._text.split("\n");
      const result: string[] = [];
      for (const line of lines) {
        let wrapped = line.length > width ? line.slice(0, width) : line;
        result.push(this._color(wrapped));
      }
      return result;
    }
  },
  truncateToWidth: vi.fn((s: string, w: number) => {
    // ANSI color sequences intentionally match ESC.
    // oxlint-disable-next-line no-control-regex
    const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
    return plain.length > w ? plain.slice(0, w - 3) + "..." : s;
  }),
  visibleWidth: vi.fn((s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length),
  wrapTextWithAnsi: vi.fn((text: string, width: number) => {
    const lines = text.split("\n");
    const result: string[] = [];
    for (const line of lines) {
      if (line.length <= width) {
        result.push(line);
      } else {
        let remaining = line;
        while (remaining.length > 0) {
          result.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
      }
    }
    return result;
  }),
}));
vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

// --- Import after mocks ---

import { getHideThinkingBlock } from "../../src/pi-settings.js";
import { ConversationViewer, type ToolDisplayOptions } from "../../src/ui/conversation-viewer.js";

// --- Test helpers ---

const noopTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

/** Minimal message shape the viewer renders: role, content blocks, tool-result metadata. */
interface TestContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  data?: string;
}
interface TestMessage {
  role: string;
  content: string | TestContentBlock[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
}

function makeMockSession(messages: TestMessage[] = []) {
  return asAgentSession({
    messages,
    subscribe: mockSubscribe,
  });
}

function makeMockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "abc12345",
    lifecycle: {
      status: "running",
      startedAt: Date.now() - 30000,
      completedAt: undefined,
      started: true,
    },
    display: {
      type: "builder",
      description: "test agent",
      invocation: { modelName: "sonnet" },
    },
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 5,
      turnCount: 10,
      compactionCount: 0,
    },
    execution: { settled: false, settlementCount: 0, session: makeMockSession() },
    ...overrides,
  };
}

function frameLines(viewer: ConversationViewer, width = 80): string[] {
  return viewer.render(width);
}

/** Transcript values are app-produced data, not UI copy. */
function frameText(viewer: ConversationViewer, width = 80): string {
  return frameLines(viewer, width).join("\n");
}

/** The tool-output trust boundary: no terminal controls may reach the TUI. */
function expectNoUnsafeControls(frame: string[]): void {
  // oxlint-disable-next-line no-control-regex -- asserting no control character survives is the point
  expect(frame.join("\n")).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFF9-\uFFFB\p{Bidi_Control}]/u);
}

/** Assert a fake TUI at the boundary: the viewer reads only requestRender and terminal.rows. */
function asTui<S extends object>(fake: S): TUI & S {
  return fake as TUI & S;
}

function makeTui(rows = 40): TUI {
  return asTui({
    terminal: { rows, cols: 120 },
    requestRender: mockRequestRender,
  });
}

interface ViewerOptions {
  rows?: number;
  onClose?: () => void;
  onStop?: () => void;
  keybindings?: ViewerKeybindings;
  onSteer?: (message: string) => void;
  toolDisplay?: ToolDisplayOptions;
}

function openViewer(
  session: ReturnType<typeof makeMockSession>,
  record: AgentRecord,
  options: ViewerOptions = {},
): ConversationViewer {
  return new ConversationViewer(
    makeTui(options.rows),
    session,
    record,
    noopTheme,
    options.onClose ?? vi.fn(),
    options.onStop,
    options.keybindings,
    options.onSteer,
    options.toolDisplay,
  );
}

// --- Tests ---

describe("ConversationViewer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("subscription", () => {
    it("requests render on session events", () => {
      vi.useFakeTimers();
      try {
        let subscriber: (event?: unknown) => void;
        mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
          subscriber = cb;
          return () => {};
        });

        const session = makeMockSession([{ role: "user", content: "hi" }]);
        const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
        const viewer = openViewer(session, record);

        subscriber!({ type: "other" });
        vi.runAllTimers();
        expect(mockRequestRender).not.toHaveBeenCalled();

        subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
        vi.runAllTimers();
        expect(mockRequestRender).toHaveBeenCalled();

        subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
        subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!" } });
        vi.runAllTimers();
        expect(frameText(viewer)).toContain("hello world!");

        mockRequestRender.mockClear();
        subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "done" } });
        vi.runAllTimers();
        expect(mockRequestRender).toHaveBeenCalled();
        expect(frameText(viewer)).not.toContain("hello world!");
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops processing events after close", () => {
      vi.useFakeTimers();
      try {
        let subscriber: (event?: unknown) => void;
        mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
          subscriber = cb;
          return () => {};
        });

        const session = makeMockSession();
        const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
        const viewer = openViewer(session, record);

        viewer.handleInput("q");
        subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
        vi.runAllTimers();

        expect(mockRequestRender).not.toHaveBeenCalled();
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("close", () => {
    it.each([
      ["q", "q"],
      ["Escape", "\x1b"],
    ])("closes on %s", (_key, input) => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record, { onClose: done });

      viewer.handleInput(input);
      expect(done).toHaveBeenCalled();
    });
  });

  describe("stop two-press confirmation", () => {
    it("requires two 's' presses to stop", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const viewer = openViewer(session, record, { onClose: done, onStop });

      // First 's' — arms the stop
      viewer.handleInput("s");
      expect(onStop).not.toHaveBeenCalled();

      // Second 's' — confirms
      viewer.handleInput("s");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("disarms stop on other key press", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const viewer = openViewer(session, record, { onClose: done, onStop });

      viewer.handleInput("s"); // arm
      viewer.handleInput("g"); // disarm (jump to top)
      viewer.handleInput("s"); // arm again (not confirm)
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not stop when agent is not running", () => {
      const onStop = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const viewer = openViewer(session, record, { onClose: done, onStop });

      viewer.handleInput("s");
      viewer.handleInput("s");
      expect(onStop).not.toHaveBeenCalled();
    });
  });

  describe("steering", () => {
    it.each(["running", "completed"] as const)("submits a message for a %s session", (status) => {
      const onSteer = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: {
          status,
          startedAt: Date.now() - 10000,
          completedAt: status === "completed" ? Date.now() : undefined,
          started: true,
        },
        execution: { settled: false, settlementCount: 0, session },
      });
      const viewer = openViewer(session, record, { onSteer });

      viewer.handleInput("\r");
      viewer.handleInput("fixture-steer-message");
      viewer.handleInput("\r");

      expect(onSteer).toHaveBeenCalledWith("fixture-steer-message");
    });

    it("does not submit a cancelled message", () => {
      const onSteer = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record, { onSteer });

      viewer.handleInput("\r");
      viewer.handleInput("discard");
      viewer.handleInput("\x1b");

      expect(onSteer).not.toHaveBeenCalled();
    });

    it("does not steer a record without a session", () => {
      const onSteer = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session: undefined } });
      const viewer = openViewer(session, record, { onSteer });

      viewer.handleInput("\r");
      viewer.handleInput("cannot continue");
      viewer.handleInput("\r");

      expect(onSteer).not.toHaveBeenCalled();
    });
  });

  describe("scrolling", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `row-${String(i).padStart(2, "0")}`).join("\n");

    function wheel(wheelDelta: number | undefined, type: TuiMouseEvent["type"] = "wheel"): TuiMouseEvent {
      return {
        type,
        button: "none",
        x: 5,
        y: 5,
        screenX: 10,
        screenY: 10,
        width: 80,
        height: 24,
        shift: false,
        alt: false,
        ctrl: false,
        ...(wheelDelta === undefined ? {} : { wheelDelta }),
      };
    }

    function setup() {
      const session = makeMockSession([{ role: "user", content: rows }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);
      viewer.render(80);
      return { viewer, session };
    }

    const hasRow = (viewer: ConversationViewer, index: number) =>
      frameText(viewer).includes(`row-${String(index).padStart(2, "0")}`);

    it("scrolls by wheel delta, clamps at both ends, and ignores unrelated events", () => {
      const { viewer, session } = setup();
      expect(hasRow(viewer, 29)).toBe(true);
      expect(hasRow(viewer, 0)).toBe(false);

      expect(viewer.handleMouse(wheel(-3))).toEqual({ handled: true });
      expect(hasRow(viewer, 8)).toBe(true);
      expect(hasRow(viewer, 7)).toBe(false);
      expect(viewer.handleMouse(wheel(2))).toEqual({ handled: true });
      expect(hasRow(viewer, 10)).toBe(true);

      viewer.handleMouse(wheel(-100));
      expect(hasRow(viewer, 0)).toBe(true);
      viewer.handleMouse(wheel(100));
      expect(hasRow(viewer, 29)).toBe(true);
      session.messages.push({ role: "user", content: "row-30" });
      expect(hasRow(viewer, 30)).toBe(true);
      expect(viewer.handleMouse(wheel(undefined, "click"))).toBeUndefined();
      expect(viewer.handleMouse(wheel(3, "drag"))).toBeUndefined();
      expect(viewer.handleMouse(wheel(0))).toBeUndefined();
      expect(viewer.handleMouse(wheel(-1))).toEqual({ handled: true });
      viewer.handleInput("q");
      expect(viewer.handleMouse(wheel(-1))).toBeUndefined();
    });

    it("uses navigation keys to reach and clamp at the transcript boundaries", () => {
      const { viewer } = setup();
      viewer.handleInput("g");
      expect(hasRow(viewer, 0)).toBe(true);
      viewer.handleInput("\x1b[A");
      expect(hasRow(viewer, 0)).toBe(true);
      viewer.handleInput("\x1b[B");
      expect(hasRow(viewer, 20)).toBe(true);
      viewer.handleInput("G");
      expect(hasRow(viewer, 29)).toBe(true);
      expect(hasRow(viewer, 0)).toBe(false);
    });
  });

  // --- Tool-result data and interaction behavior -----------------------------------------------
  const bodyText = (n: number) => Array.from({ length: n }, (_, i) => `body${i + 1}`).join("\n");
  const bodyRows = (viewer: ConversationViewer) => frameText(viewer).match(/\bbody\d+\b/g) ?? [];

  /** One assistant message holding these tool calls. */
  function callsOf(...calls: Array<{ id: string; name?: string; args?: Record<string, unknown> }>): TestMessage {
    return {
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name ?? "uniqtool", arguments: c.args })),
    };
  }
  function resultOf(
    id: string,
    opts: { name?: string; text?: string; blocks?: TestContentBlock[]; isError?: boolean; durationMs?: number } = {},
  ): TestMessage {
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: opts.name ?? "uniqtool",
      isError: opts.isError ?? false,
      content: opts.blocks ?? [{ type: "text", text: opts.text ?? "" }],
      durationMs: opts.durationMs,
    };
  }

  interface CallView {
    /** pi's global tool-output flag, in a holder the test flips. */
    flag?: { expanded: boolean };
    toolDisplay?: ToolDisplayOptions;
    keybindings?: ViewerKeybindings;
    /** Terminal rows: fewer rows than the transcript forces scrolling. */
    rows?: number;
  }
  function openCallView(messages: TestMessage[], view: CallView = {}): ConversationViewer {
    const session = makeMockSession(messages);
    const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
    return openViewer(session, record, {
      rows: view.rows,
      keybindings: view.keybindings,
      toolDisplay: { isExpanded: () => view.flag?.expanded ?? false, ...view.toolDisplay },
    });
  }

  describe("transcript data", () => {
    it("shows user and assistant messages without rendering an unpaired tool result", () => {
      const session = makeMockSession([
        { role: "user", content: "fixture-user-message" },
        { role: "assistant", content: [{ type: "text", text: "fixture-assistant-message" }] },
        resultOf("missing-call", { text: "unpaired-result" }),
      ]);
      const baseRecord = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const record = { ...baseRecord, display: { ...baseRecord.display, worktreeLabel: "fixture-worktree" } };
      const viewer = openViewer(session, record);
      const output = frameText(viewer);

      expect(output).toContain("fixture-user-message");
      expect(output).toContain("fixture-assistant-message");
      expect(output).toContain("fixture-worktree");
      expect(output).not.toContain("unpaired-result");
    });
  });

  describe("tool call results", () => {
    it("shows a short result whole and previews a long one until expanded", () => {
      const short = openCallView([callsOf({ id: "short" }), resultOf("short", { text: bodyText(2) })]);
      expect(bodyRows(short)).toEqual(["body1", "body2"]);
      const flag = { expanded: false };
      const viewer = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(10) })], { flag });

      expect(bodyRows(viewer)).toEqual(["body1", "body2", "body3"]);
      flag.expanded = true;
      expect(bodyRows(viewer)).toEqual(bodyText(10).split("\n"));
    });

    it("shows error result data under its call", () => {
      const viewer = openCallView([
        callsOf({ id: "t1" }),
        resultOf("t1", { text: "fixture-error-detail", isError: true }),
      ]);

      expect(frameText(viewer)).toContain("fixture-error-detail");
    });

    it("keeps the end of a bash result and the start of any other tool's", () => {
      const result = { text: bodyText(10) };
      expect(bodyRows(openCallView([callsOf({ id: "t1", name: "bash" }), resultOf("t1", result)]))).toEqual([
        "body8",
        "body9",
        "body10",
      ]);
      expect(bodyRows(openCallView([callsOf({ id: "t1", name: "read" }), resultOf("t1", result)]))).toEqual([
        "body1",
        "body2",
        "body3",
      ]);
    });

    it("limits wrapped text rows without treating image data as text", () => {
      const longText = "x".repeat(320);
      const textRows = frameText(openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: longText })]));
      const withImage = frameText(
        openCallView([
          callsOf({ id: "t1" }),
          resultOf("t1", {
            blocks: [
              { type: "text", text: longText },
              { type: "image", data: "fixture-image-payload" },
            ],
          }),
        ]),
      );
      const wrappedRows = (output: string) => output.match(/x{10,}/g) ?? [];

      expect(wrappedRows(textRows)).toHaveLength(3);
      expect(wrappedRows(withImage)).toHaveLength(3);
      expect(withImage).not.toContain("fixture-image-payload");
    });

    it("renders no escape or control sequences from hostile result text", () => {
      // Each of these would take over the terminal, or make the terminal send input back to
      // us. The 8-bit (C1) encodings count too: xterm and VTE decode them as UTF-8 controls.
      const raw =
        "sgr \u001b[31mred\u001b[0m\n" +
        "altscreen \u001b[?1049h\n" +
        "hidecursor \u001b[?25l\n" +
        "query \u001b[6n\n" +
        "resize \u001b[8;40;120t\n" +
        "device \u001bPtm;#q1\u001b\\\n" +
        "graphics \u001b_Gk=q;7;1;2;0;0;1\u001b\\\n" +
        "c1 graphics \u001b_Gk=q;7\u009c\n" +
        "title \u001b]0;window-title\u009c\n" +
        "clipboard \u001b]52;c;aGVsbG8=\u0007\n" +
        "private \u001b_x\u001b\\\n" +
        "c1 sgr A\u009b31mredB\u009b0mC\n" +
        "c1 altscreen A\u009b?1049hB\n" +
        "c1 stray A\u0090B\n" +
        "c1 stop A\u009cB\n" +
        "lone \u001b end\n" +
        "carriage return before\r after\n" +
        "tabs\tin\toutput stay\n" +
        "nul\u0000 bell\u0007 format\uFFF9 del before\u007f after bidi \u2066isolate\u2069 rtl \u202eword";
      const viewer = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: raw })], { flag: { expanded: true } });
      // Check the actual frame so a terminal control cannot be hidden by a text-only helper.
      const frame = viewer.render(80);
      expectNoUnsafeControls(frame);
      const shown = frame.join("\n");
      // What is left is the text around each sequence: removing one must not take its
      // neighbours with it, and must not leave the sequence's own parameters behind.
      expect(shown).toContain("sgr red");
      expect(shown).toContain("c1 sgr AredBC"); // the 8-bit CSI and its parameters go, the words stay
      expect(shown).toContain("c1 altscreen AB");
      expect(shown).toContain("carriage return before after");
      expect(shown).toContain("del before after");
      expect(shown).toContain("bidi isolate");
      expect(shown).toContain("rtl word");
      // A string sequence goes away whole, whichever terminator the writer used.
      expect(shown).toContain("title");
      expect(shown).not.toContain("window-title");
      expect(shown).toContain("c1 graphics");
      expect(shown).not.toContain("k=q");
      expect(shown).toContain("lone");
      expect(shown).toContain("end");
      expect(shown).toContain("tabs\tin\toutput stay"); // pi-tui lays a tab out; we are not to eat it
    });

    it("renders no escape or control sequences from hostile call arguments", () => {
      // The call line is built from tool data the same way the result is. JSON.stringify
      // escapes C0 but leaves the 8-bit encodings exactly as they came.
      const hostile = makeMockSession([
        callsOf({ id: "t1", args: { command: "echo A\u009b?1049hB \u001b]0;window-title\u0007 done" } }),
        resultOf("t1", { text: bodyText(3) }),
      ]);
      for (const expanded of [false, true]) {
        const viewer = openCallView(hostile.messages, { flag: { expanded } });
        const frame = viewer.render(80);
        expectNoUnsafeControls(frame);
        expect(frame.join("\n")).toContain("echo AB");
      }
    });

    it("keeps the text after an unterminated escape sequence", () => {
      const shown = frameText(
        openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: "before \u001b]0;never-ended after" })]),
      );

      expect(shown).not.toContain("\u001b");
      expect(shown).toContain("before");
      expect(shown).toContain("after");
    });

    it("shows the whole command once expanded and a shortened one collapsed", () => {
      const whole = "echo " + "TAIL".repeat(120) + " fixture-command-end";
      const tail = "fixture-command-end";
      const messages = [callsOf({ id: "t1", name: "bash", args: { command: whole } })];

      expect(frameText(openCallView(messages))).not.toContain(tail);
      expect(frameText(openCallView(messages, { flag: { expanded: true } }))).toContain(tail);
    });

    it("carries a bash timeout, and only a usable one on a bash call", () => {
      const output = (name: string, args?: Record<string, unknown>) =>
        frameText(openCallView([callsOf({ id: "t1", name, args })]));

      expect(output("bash", { command: "ls", timeout: 317 })).toMatch(/\b317s\b/);
      expect(output("read", { path: "fixture-file", timeout: 317 })).not.toMatch(/\b317s\b/);
      expect(output("bash", { command: "ls", timeout: 0 })).not.toMatch(/\b0s\b/);
    });
  });

  describe("tool call timing", () => {
    /** Event emitter of a viewer's subscription, so a test can deliver pi's own events. */
    function emitter(): (event: unknown) => void {
      let emit: (event: unknown) => void = () => {};
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        emit = cb;
        return () => {};
      });
      return (event) => emit(event);
    }

    it("shows the recorded duration for successful and failed calls", () => {
      for (const isError of [false, true]) {
        const viewer = openCallView([
          callsOf({ id: "t1", name: "bash" }),
          resultOf("t1", { durationMs: 1500, isError }),
        ]);
        expect(frameText(viewer)).toContain("1.5s");
      }
    });

    it.each(["edit", "write"] as const)("shows a small duration for %s calls", (name) => {
      const viewer = openCallView([callsOf({ id: "file-op", name }), resultOf("file-op", { name, durationMs: 42 })]);

      expect(frameText(viewer)).toContain("42ms");
    });

    it("takes the duration its result recorded over the one its end event reported", () => {
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([
          callsOf({ id: "t1", name: "bash" }),
          resultOf("t1", { name: "bash", durationMs: 9999 }),
        ]);
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", durationMs: 2042 });

        // The result's duration takes precedence over a later end event.
        expect(frameText(viewer)).toContain("10.0s");
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays quiet when nothing recorded how long the call took", () => {
      // Neither a result nor a running call without a known start has a duration to show.
      expect(frameText(openCallView([callsOf({ id: "t1", name: "bash" }), resultOf("t1")]))).not.toMatch(
        /\b\d+\.\ds\b/,
      );
      expect(frameText(openCallView([callsOf({ id: "t1", name: "bash" })]))).not.toMatch(/\b\d+\.\ds\b/);

      // A result that landed without a duration ends the count too: a settled call never
      // counts up, even when its start arrives after the result.
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([callsOf({ id: "t1", name: "bash" }), resultOf("t1", { name: "bash" })]);
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        vi.advanceTimersByTime(1000);
        expect(frameText(viewer)).not.toMatch(/\b\d+\.\ds\b/);
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads the text of a result that arrives as a plain string", () => {
      const session = makeMockSession([
        callsOf({ id: "t1" }),
        { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, content: "plain text result" },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);

      expect(frameText(viewer)).toContain("plain text result");
    });

    it("counts a running call up, then settles on the time it actually took", () => {
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([callsOf({ id: "t1", name: "bash" })]);
        expect(frameText(viewer)).not.toMatch(/\b\d+\.\ds\b/);

        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        vi.advanceTimersByTime(100);
        expect(frameText(viewer)).toContain("100ms");
        vi.advanceTimersByTime(1900);
        expect(frameText(viewer)).toContain("2.0s");

        // The call ends before its result message lands, so the event carries the time.
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", durationMs: 2042 });
        vi.advanceTimersByTime(100);
        expect(frameText(viewer)).toContain("2.0s");

        vi.advanceTimersByTime(100); // let the repaint settle
        expect(vi.getTimerCount()).toBe(0); // no call is running, so the once-a-second redraw is gone

        mockRequestRender.mockClear();
        vi.advanceTimersByTime(5000);
        expect(mockRequestRender).not.toHaveBeenCalled(); // nothing left to redraw
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses the recorded start time for a call already running on open", () => {
      vi.useFakeTimers();
      try {
        const startedBeforeViewer = Date.now() - 4000;
        const getToolStartedAt = (id: string) => (id === "t2" ? startedBeforeViewer : undefined);
        const viewer = openCallView(
          [
            callsOf({ id: "t1", name: "bash" }, { id: "t2", name: "bash" }),
            resultOf("t1", { name: "bash", durationMs: 900 }),
          ],
          {
            toolDisplay: { getToolStartedAt },
          },
        );

        const shown = frameText(viewer);
        expect(shown).toContain("900ms");
        expect(shown).toContain("4.0s");
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops counting once the viewer is closed", () => {
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([callsOf({ id: "t1", name: "bash" })]);
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        vi.advanceTimersByTime(100);
        mockRequestRender.mockClear();

        expect(vi.getTimerCount()).toBe(1); // the once-a-second redraw is running

        viewer.dispose();
        expect(vi.getTimerCount()).toBe(0); // closing stops it, rather than leaving a ticking viewer

        vi.advanceTimersByTime(5000);
        expect(mockRequestRender).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("expanding a call", () => {
    // Each call carries its own body markers, so a test can see which call opened.
    const markerBody = (marker: string) => Array.from({ length: 6 }, (_, i) => `${marker}${i + 1}`).join("\n");
    const noteMessages = (count: number): TestMessage[] =>
      Array.from({ length: count }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `note${i + 1}` }],
      }));
    const callRows = (viewer: ConversationViewer) =>
      frameLines(viewer).flatMap((line, index) => (line.includes("uniqtool") ? [index] : []));
    const TWO_CALLS = [
      callsOf({ id: "t1" }, { id: "t2" }),
      resultOf("t1", { text: markerBody("a") }),
      resultOf("t2", { text: markerBody("b") }),
    ];
    /** Collapsed calls show 3 body rows, expanded calls all 6. */
    const COLLAPSED = 3;
    const EXPANDED = 6;
    /** Tall enough that one opened call fits, short enough that the transcript scrolls. */
    const SCROLLABLE_ROWS = 32;
    function click(y: number, button: TuiMouseEvent["button"] = "left"): TuiMouseEvent {
      return {
        type: "click",
        button,
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
    /** How much of one call's result is on screen. */
    const shownOf = (viewer: ConversationViewer, marker: "a" | "b") =>
      frameText(viewer).match(new RegExp(`\\b${marker}\\d+\\b`, "g"))?.length ?? 0;

    it("expands only the clicked call, and collapses it again on the next click", () => {
      const flag = { expanded: false };
      const viewer = openCallView(TWO_CALLS, { flag });
      const [firstCallRow] = callRows(viewer);
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, COLLAPSED]);

      expect(viewer.handleMouse(click(firstCallRow))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([EXPANDED, COLLAPSED]);
      expect(flag.expanded).toBe(false); // a per-call choice leaves pi's flag alone

      viewer.handleMouse(click(firstCallRow));
      expect(shownOf(viewer, "a")).toBe(COLLAPSED);

      const secondTitle = callRows(viewer)[1];
      expect(viewer.handleMouse(click(secondTitle))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, EXPANDED]);
    });

    it("maps a click to the frame on screen, not to the scroll position behind it", () => {
      const notes = noteMessages(12);
      const viewer = openCallView(
        [
          ...notes,
          callsOf({ id: "t1" }, { id: "t2" }),
          resultOf("t1", { text: markerBody("a") }),
          resultOf("t2", { text: markerBody("b") }),
        ],
        {
          rows: SCROLLABLE_ROWS,
        },
      );
      const scroll = (delta: number) => {
        viewer.handleMouse(wheel(delta));
        viewer.render(80);
      };
      scroll(999);
      const secondTitle = callRows(viewer)[1];
      expect(secondTitle).toBeGreaterThan(0); // the second call is the one on screen

      // Scroll away without rendering: pi-tui has until its next frame to repaint, and a
      // click can arrive in that window. The paint, not the offset, decides what it hits.
      viewer.handleMouse(wheel(-999));
      expect(viewer.handleMouse(click(secondTitle))).toEqual({ handled: true });

      scroll(999); // look at the frame that was on screen when the click arrived
      expect(shownOf(viewer, "b")).toBe(EXPANDED); // the call that was under the pointer opened
      expect(shownOf(viewer, "a")).toBeLessThanOrEqual(COLLAPSED); // not whatever the new offset put there
    });

    it("maps a click through the scroll position, not the top of the transcript", () => {
      // Long enough that only the tail of the transcript fits on screen.
      const notes = noteMessages(12);
      const viewer = openCallView([...notes, callsOf({ id: "t1" }), resultOf("t1", { text: markerBody("b") })], {
        rows: SCROLLABLE_ROWS,
      });
      const scroll = (delta: number) => {
        viewer.handleMouse(wheel(delta));
        viewer.render(80);
      };
      scroll(999); // auto-scroll already rests here; the call is on screen
      const titleRow = callRows(viewer)[0];
      expect(titleRow).toBeGreaterThan(0);

      expect(viewer.handleMouse(click(titleRow))).toEqual({ handled: true });
      expect(frameText(viewer)).toContain("b6");

      scroll(-999);
      expect(callRows(viewer)).toEqual([]); // the call is off screen
      expect(viewer.handleMouse(click(titleRow))).toBeUndefined(); // that row belongs to someone else now
    });

    it("collapses one call while pi's global flag has the rest expanded", () => {
      const viewer = openCallView(TWO_CALLS, { flag: { expanded: true } });
      const [firstCallRow] = callRows(viewer);

      expect(viewer.handleMouse(click(firstCallRow))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, EXPANDED]);
    });

    it("drops per-call choices when pi's global flag flips, and follows the flag without any event", () => {
      const flag = { expanded: false };
      const viewer = openCallView(TWO_CALLS, { flag });
      const [firstCallRow] = callRows(viewer);
      expect(viewer.handleMouse(click(firstCallRow))).toEqual({ handled: true });

      flag.expanded = true;
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([EXPANDED, EXPANDED]); // the click no longer overrides
      flag.expanded = false;
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, COLLAPSED]);
    });

    it("uses the painted content bounds while the composer opens before repaint", () => {
      const steerable = makeMockSession([
        ...noteMessages(8),
        callsOf({ id: "t2" }),
        resultOf("t2", { text: bodyText(6) }),
      ]);
      const live = openViewer(
        steerable,
        makeMockRecord({
          lifecycle: { status: "running", startedAt: Date.now(), started: true },
          execution: { settled: false, settlementCount: 0, session: steerable },
        }),
        { rows: SCROLLABLE_ROWS, onSteer: vi.fn() },
      );
      live.render(80);
      live.handleMouse(wheel(-1));
      const painted = frameLines(live);
      const lastPaintedRow = painted.findIndex((line) => line.includes("body3"));

      expect(live.handleMouse(click(lastPaintedRow))).toEqual({ handled: true });
      live.handleInput("\r"); // Opens the composer before the next frame is painted.
      expect(live.handleMouse(click(lastPaintedRow))).toEqual({ handled: true });
      expect(bodyRows(live)).toHaveLength(3);
    });

    it("ignores clicks before rendering and outside a finished call", () => {
      const viewer = openCallView(TWO_CALLS);
      expect(viewer.handleMouse(click(0))).toBeUndefined();

      const [firstTitle, secondTitle] = callRows(viewer);
      expect(viewer.handleMouse(click(0))).toBeUndefined();
      expect(viewer.handleMouse(click(frameLines(viewer).length + 1))).toBeUndefined();
      expect(viewer.handleMouse(click(firstTitle, "right"))).toBeUndefined();
      expect(viewer.handleMouse(click(secondTitle - 2))).toBeUndefined();
      expect(shownOf(viewer, "a")).toBe(COLLAPSED);

      expect(viewer.handleMouse(click(firstTitle))).toEqual({ handled: true });
      expect(shownOf(viewer, "a")).toBe(EXPANDED);
    });

    it("ignores clicks on footer rows that map to calls below the fold", () => {
      const twelveLines = Array.from({ length: 12 }, (_, i) => `note${i + 1}`).join("\n");
      const tall = openCallView([{ role: "user", content: [{ type: "text", text: twelveLines }] }, ...TWO_CALLS], {
        rows: SCROLLABLE_ROWS,
      });
      tall.render(80);
      tall.handleMouse(wheel(-999));
      const footerRow = frameLines(tall).length - 2;
      expect(shownOf(tall, "a")).toBe(0);

      expect(tall.handleMouse(click(footerRow))).toBeUndefined();
      expect(shownOf(tall, "a")).toBe(0);
    });

    it("does not hit-test rows from a narrow or invalidated frame", () => {
      const narrow = openCallView(TWO_CALLS);
      const [callRow] = callRows(narrow);
      narrow.render(4);
      expect(narrow.handleMouse(click(callRow))).toBeUndefined();

      const invalidated = openCallView(TWO_CALLS);
      const [invalidatedCallRow] = callRows(invalidated);
      invalidated.invalidate();
      expect(invalidated.handleMouse(click(invalidatedCallRow))).toBeUndefined();
    });

    it("does not hit-test the previous frame after the transcript empties", () => {
      const emptied = makeMockSession([callsOf({ id: "t1" }), resultOf("t1", { text: markerBody("a") })]);
      const viewer = openViewer(
        emptied,
        makeMockRecord({ execution: { settled: false, settlementCount: 0, session: emptied } }),
      );
      const [callRow] = callRows(viewer);
      emptied.messages.length = 0;
      viewer.render(80);

      expect(viewer.handleMouse(click(callRow))).toBeUndefined();
    });

    it("does not expand a call before its result arrives", () => {
      const running = openCallView([callsOf({ id: "t1" })]);
      const [callRow] = callRows(running);

      expect(running.handleMouse(click(callRow))).toBeUndefined();
    });

    it("uses the configured expand key and ignores it when no toggle is wired", () => {
      const flag = { expanded: false };
      const bound = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(10) })], {
        flag,
        toolDisplay: { toggleExpanded: () => (flag.expanded = !flag.expanded) },
        keybindings: { matches: (data, id) => id === "app.tools.expand" && data === "\u001be" },
      });

      bound.handleInput("\u000f");
      expect(bodyRows(bound)).toHaveLength(3);
      bound.handleInput("\u001be");
      expect(bodyRows(bound)).toHaveLength(10);

      const unwired = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(10) })], {
        keybindings: { matches: () => true },
      });
      expect(() => unwired.handleInput("\u000f")).not.toThrow();
      expect(bodyRows(unwired)).toHaveLength(3);
    });
  });

  describe("caching", () => {
    it("shows a result added after its tool call was cached", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
      ]);
      const viewer = openViewer(
        session,
        makeMockRecord({ execution: { settled: false, settlementCount: 0, session } }),
      );

      expect(frameText(viewer)).not.toContain("fixture-late-result");
      session.messages.push({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "uniqtool",
        isError: false,
        content: [{ type: "text", text: "fixture-late-result" }],
      });

      const output = frameText(viewer);
      expect(output.match(/fixture-late-result/g)).toHaveLength(1);
    });

    it("scrolls to streamed content added after the last cached transcript", () => {
      vi.useFakeTimers();
      try {
        let subscriber: (event?: unknown) => void;
        mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
          subscriber = cb;
          return () => {};
        });

        const history = Array.from({ length: 30 }, (_, index) => `history-${index}`).join("\n");
        const session = makeMockSession([{ role: "user", content: history }]);
        const viewer = openViewer(
          session,
          makeMockRecord({ execution: { settled: false, settlementCount: 0, session } }),
        );

        expect(frameText(viewer)).toContain("history-29");
        viewer.handleInput("g");
        subscriber!({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "stream-first\nstream-tail" },
        });
        vi.runAllTimers();

        viewer.handleInput("G");
        expect(frameText(viewer)).toContain("stream-tail");
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dispose", () => {
    it("unsubscribes from session", () => {
      const unsubscribe = vi.fn();
      mockSubscribe.mockReturnValue(unsubscribe);

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);
      viewer.dispose();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("transcript updates", () => {
    it("renders a replaced transcript instead of stale messages", () => {
      let messagesArray: TestMessage[] = [
        { role: "user", content: "fixture-user" },
        { role: "assistant", content: [{ type: "text", text: "fixture-old-response-1" }] },
        { role: "user", content: "fixture-old-user-2" },
        { role: "assistant", content: [{ type: "text", text: "fixture-old-response-2" }] },
      ];
      const session = asAgentSession({
        get messages() {
          return messagesArray;
        },
        subscribe: mockSubscribe,
      });
      const viewer = openViewer(
        session,
        makeMockRecord({ execution: { settled: false, settlementCount: 0, session } }),
      );
      viewer.render(80);

      messagesArray = [
        { role: "user", content: "fixture-user" },
        { role: "assistant", content: [{ type: "text", text: "fixture-summary" }] },
      ];
      let output = frameText(viewer);
      expect(output).toContain("fixture-summary");
      expect(output).not.toContain("fixture-old-response-1");
      expect(output).not.toContain("fixture-old-response-2");

      messagesArray = [
        { role: "user", content: "fixture-user" },
        { role: "assistant", content: [{ type: "text", text: "fixture-recompacted" }] },
      ];
      output = frameText(viewer);
      expect(output).toContain("fixture-recompacted");
      expect(output).not.toContain("fixture-summary");
    });

    it("renders a newly appended message without duplicating existing content", () => {
      const messages: TestMessage[] = [{ role: "user", content: "fixture-existing-message" }];
      const session = asAgentSession({
        get messages() {
          return messages;
        },
        subscribe: mockSubscribe,
      });
      const viewer = openViewer(
        session,
        makeMockRecord({ execution: { settled: false, settlementCount: 0, session } }),
      );
      viewer.render(80);

      messages.push({ role: "assistant", content: [{ type: "text", text: "fixture-appended-message" }] });
      const output = frameText(viewer);

      expect(output.match(/fixture-existing-message/g)).toHaveLength(1);
      expect(output.match(/fixture-appended-message/g)).toHaveLength(1);
    });
  });

  describe("thinking visibility", () => {
    it("toggles thinking visibility with ctrl+T", () => {
      const session = makeMockSession([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);

      let output = frameText(viewer);
      expect(output).toContain("Let me think");
      expect(output).toContain("Here is the answer.");

      viewer.handleInput("\x14");
      output = frameText(viewer);
      expect(output).not.toContain("Let me think");
      expect(output).toContain("Here is the answer.");

      viewer.handleInput("\x14");
      expect(frameText(viewer)).toContain("Let me think");
    });

    it("hides stored thinking when the setting requests it but keeps the answer", () => {
      // Mock the setting to return true (thinking should be hidden)
      vi.mocked(getHideThinkingBlock).mockReturnValue(true);
      const session = makeMockSession([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "fixture-hidden-thought" },
            { type: "text", text: "fixture-visible-answer" },
          ],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);

      const text = viewer.render(80).join("\n");

      expect(text).not.toContain("fixture-hidden-thought");
      expect(text).toContain("fixture-visible-answer");
    });

    it("keeps streaming thoughts hidden until the user reveals them", () => {
      // Mock the setting to return true (thinking should be hidden)
      vi.mocked(getHideThinkingBlock).mockReturnValue(true);

      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = openViewer(session, record);

      try {
        subscriber!({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "fixture-streaming-thought" },
        });
        vi.runAllTimers();

        expect(frameText(viewer)).not.toContain("fixture-streaming-thought");
        viewer.handleInput("\x14");
        expect(frameText(viewer)).toContain("fixture-streaming-thought");
      } finally {
        viewer.dispose();
        vi.useRealTimers();
      }
    });
  });
});
