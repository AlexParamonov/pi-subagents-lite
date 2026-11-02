/**
 * conversation-viewer.test.ts — Tests for ConversationViewer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import type { MarkdownTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
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
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

// --- Test helpers ---

const noopTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

/**
 * Theme that renders bg() as real SGR background codes. The tool-call
 * success/error/pending distinction is a background color, which noopTheme
 * flattens; real escape codes (unlike text markers) keep the ANSI-aware
 * width math honest, so marked lines measure their true visible width.
 */
const BG_ON: Record<string, string> = {
  toolPendingBg: "\x1b[100m",
  toolSuccessBg: "\x1b[42m",
  toolErrorBg: "\x1b[41m",
  userMessageBg: "\x1b[44m",
};
const BG_OFF = "\x1b[49m";
const bgMarkingTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `${BG_ON[color] ?? "\x1b[45m"}${text}${BG_OFF}`,
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

/** Assert a fake TUI at the boundary: the viewer reads only requestRender and terminal.rows. */
function asTui<S extends object>(fake: S): TUI & S {
  return fake as TUI & S;
}

function makeTui(): TUI {
  return asTui({
    terminal: { rows: 40, cols: 120 },
    requestRender: mockRequestRender,
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Total content lines from the footer scroll readout (N/N · pct%). */
function readoutTotal(text: string): number {
  const m = text.match(/\((\d+)\/(\d+) · /);
  return m ? Number(m[2]) : 0;
}

/**
 * Content rows between the separator under the header and the one above the
 * footer, trimmed of the `│ … │` row frame and empties. With bgMarkingTheme
 * this pins the exact rendered content array (per the layout lesson), not
 * just membership.
 */
function contentRows(viewer: ConversationViewer): string[] {
  const lines = viewer.render(80);
  const seps: number[] = [];
  lines.forEach((l, i) => {
    if (l.includes("─")) seps.push(i);
  });
  return lines
    .slice(seps[1] + 1, seps[2])
    .map((l) => l.replace(/^│/, "").replace(/│$/, "").trim())
    .filter(Boolean);
}

/**
 * The exact 3-row block a tool call renders at render(80): bg fill / title /
 * bg fill — the same shape whether the call is pending or settled, since
 * results never add rows.
 */
function expectedCallBlock(bg: string, label: string): string[] {
  const innerW = 76; // render(80) minus border + padding
  const fill = `${bg}${" ".repeat(innerW)}${BG_OFF}`;
  const title = `${bg} ${label} ${" ".repeat(innerW - ` ${label} `.length)}${BG_OFF}`;
  return [fill, title, fill];
}

/** A call block with result rows under the title, all inside one status background. */
function expectedResultBlock(bg: string, label: string, resultRows: string[]): string[] {
  const innerW = 76;
  const [fill, title] = expectedCallBlock(bg, label);
  const row = (text: string) => `${bg} ${text}${" ".repeat(innerW - 2 - text.length)} ${BG_OFF}`;
  return [fill, title, ...resultRows.map(row), fill];
}

// --- Tests ---

describe("ConversationViewer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("subscription", () => {
    it("subscribes to session events on construction", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      expect(session.subscribe).toHaveBeenCalledTimes(1);
    });

    it("requests render on session events", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession([{ role: "user", content: "hi" }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      // Non-message_update events should not trigger render
      subscriber!({ type: "other" });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(0);

      // message_update with text_delta should trigger render (debounced)
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(1);

      // Rapid deltas coalesce into one render: both fire before the debounce
      // window elapses, so only a single requestRender follows.
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "!" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(2);
      // The coalesced render shows the accumulated text (second delta included).
      expect(viewer.render(80).join("\n")).toContain("hello world!");

      // Clearing text should trigger render
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "done" } });
      vi.runAllTimers();
      expect(mockRequestRender).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it("stops processing events after close", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();
      const done = vi.fn();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);

      viewer.handleInput("q");

      // Fire a render-triggering event after close and run the debounce timer:
      // the closed guard must swallow the event before it mutates streaming
      // state or schedules a render.
      subscriber!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
      vi.runAllTimers();

      expect(mockRequestRender).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("close", () => {
    it("closes on 'q' key", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);
      viewer.handleInput("q");
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done);
      viewer.handleInput("\x1b");
      expect(done).toHaveBeenCalledTimes(1);
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
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

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
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

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
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, onStop);

      viewer.handleInput("s");
      viewer.handleInput("s");
      expect(onStop).not.toHaveBeenCalled();
    });
  });

  describe("steering", () => {
    it("opens composer on Enter when steerable", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      // The composer row and its hints are rendered output.
      const text = viewer.render(80).join("\n");
      expect(text).toContain("✎ steer");
      expect(text).toContain("Enter send · Esc cancel");
    });

    it("sends steer message on composer submit", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("do this thing"); // type (routed to the composer)
      viewer.handleInput("\r"); // submit

      expect(onSteer).toHaveBeenCalledWith("do this thing");
      // Submitting closes the composer — the hint row is gone from the render.
      expect(viewer.render(80).join("\n")).not.toContain("Enter send · Esc cancel");
    });

    it("offers continue (not steer) for a settled agent with a session", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);

      // Footer advertises continue for a settled record, not steer.
      const text = viewer.render(120).join("\n");
      expect(text).toContain("Enter continue");
      expect(text).not.toContain("Enter steer");

      // Enter opens the composer with the continue hint.
      viewer.handleInput("\r");
      const composed = viewer.render(120).join("\n");
      expect(composed).toContain("✎ continue");
      expect(composed).not.toContain("✎ steer");

      // Submitting sends through the same onSteer callback.
      viewer.handleInput("keep going");
      viewer.handleInput("\r");
      expect(onSteer).toHaveBeenCalledWith("keep going");
    });

    it("shows Enter steer in the footer while the agent is running", () => {
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const viewer = new ConversationViewer(
        makeTui(),
        session,
        record,
        noopTheme,
        vi.fn(),
        undefined,
        undefined,
        vi.fn(),
      );

      const text = viewer.render(120).join("\n");
      expect(text).toContain("Enter steer");
      expect(text).not.toContain("Enter continue");
    });

    it("does not offer the composer when the record has no session", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session: undefined } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      const text = viewer.render(120).join("\n");
      expect(text).not.toContain("✎ continue");
      expect(text).not.toContain("Enter send · Esc cancel");
    });

    it("cancels composer on Escape", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now(), started: true },
        execution: { settled: false, settlementCount: 0, session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\x1b"); // escape routes to the composer's onEscape

      const text = viewer.render(80).join("\n");
      expect(text).not.toContain("Enter send · Esc cancel");
      expect(text).not.toContain("✎ steer");
    });
  });

  describe("mouse wheel", () => {
    const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");

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
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());
      viewer.render(80); // parked at the bottom by autoScroll
      return viewer;
    }

    it("scrolls up and down by the wheel delta and reports the event handled", () => {
      const viewer = setup();

      expect(viewer.handleMouse(wheel(-3))).toEqual({ handled: true });
      expect(contentRows(viewer)[0]).toBe("line8"); // bottom window starts at line11

      expect(viewer.handleMouse(wheel(2))).toEqual({ handled: true });
      expect(contentRows(viewer)[0]).toBe("line10");
    });

    it("clamps at the top and the bottom", () => {
      const viewer = setup();

      viewer.handleMouse(wheel(-100));
      expect(contentRows(viewer)[0]).toBe("line0");

      viewer.handleMouse(wheel(100));
      const visible = contentRows(viewer);
      expect(visible[0]).toBe("line11");
      expect(visible[visible.length - 1]).toBe("line29");
    });

    it("leaves auto-scroll when scrolled up and re-engages at the bottom", () => {
      const viewer = setup();

      viewer.handleMouse(wheel(-5));
      viewer.handleMouse(wheel(5));
      // Back at the bottom: new content follows again, so the window stays pinned.
      expect(contentRows(viewer)[0]).toBe("line11");
      viewer.handleMouse(wheel(-1));
      expect(contentRows(viewer)[0]).toBe("line10");
    });

    it("ignores other mouse events and zero deltas so pi keeps its default handling", () => {
      const viewer = setup();

      expect(viewer.handleMouse(wheel(undefined, "click"))).toBeUndefined();
      expect(viewer.handleMouse(wheel(3, "drag"))).toBeUndefined();
      expect(viewer.handleMouse(wheel(0))).toBeUndefined();
      expect(contentRows(viewer)[0]).toBe("line11");
    });

    it("ignores the wheel after close", () => {
      const viewer = setup();
      viewer.handleInput("q");

      expect(viewer.handleMouse(wheel(-3))).toBeUndefined();
    });
  });

  describe("scroll behavior", () => {
    // 30 distinct one-line rows → 33 content lines (fill + 30 + fill + empty)
    // against a 21-row viewport: maxScroll = 12. Distinct line markers make
    // the visible window observable through rendered output.
    const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    // Footer readout: `(currentLine/total · pct%)`. With 33 content lines and
    // a 21-row viewport: top = (21/33 · 64%), one step down = (22/33 · 67%),
    // bottom = (33/33 · 100%).
    function readout(viewer: ConversationViewer): string {
      return (
        viewer
          .render(80)
          .join("\n")
          .match(/\(\d+\/\d+ · \d+%\)/)?.[0] ?? ""
      );
    }

    it("scrolls down on down arrow", () => {
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80); // autoScroll parks at the bottom
      viewer.handleInput("g"); // top, manual scroll
      viewer.handleInput("\x1b[B"); // one step down

      expect(readout(viewer)).toBe("(22/33 · 67%)");
      // The window's last content line advanced past the top window.
      const visible = contentRows(viewer);
      expect(visible[visible.length - 1]).toBe("line20");
    });

    it("scrolls up on up arrow", () => {
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80);
      viewer.handleInput("g");
      viewer.handleInput("\x1b[B"); // 1
      viewer.handleInput("\x1b[B"); // 2
      viewer.handleInput("\x1b[B"); // 3
      expect(contentRows(viewer)[0]).toBe("line2");

      viewer.handleInput("\x1b[A"); // back to 2
      expect(readout(viewer)).toBe("(23/33 · 70%)");
      expect(contentRows(viewer)[0]).toBe("line1");
    });

    it("jumps to top on 'g'", () => {
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80); // parked at the bottom by autoScroll
      viewer.handleInput("g");

      const visible = contentRows(viewer);
      expect(visible[0]).toBe("line0");
      expect(visible[visible.length - 1]).toBe("line19");
      expect(readout(viewer)).toBe("(21/33 · 64%)");
    });

    it("jumps to bottom on 'G'", () => {
      // Content must actually overflow the viewport, or maxScroll is 0 and
      // the G branch has nothing to scroll (vacuous).
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80); // bottom
      viewer.handleInput("g"); // top
      viewer.handleInput("G"); // bottom

      const visible = contentRows(viewer);
      expect(visible[0]).toBe("line11");
      expect(visible[visible.length - 1]).toBe("line29");
      expect(visible).not.toContain("line0");
      expect(readout(viewer)).toBe("(33/33 · 100%)");
    });

    it("does not scroll past start", () => {
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80); // bottom
      viewer.handleInput("g"); // top
      viewer.handleInput("\x1b[A"); // up at the top — must stay clamped at 0
      viewer.handleInput("\x1b[A"); // up again

      const visible = contentRows(viewer);
      expect(visible[0]).toBe("line0");
      // Readout pins the clamp: a negative offset would drop currentLine below 21.
      expect(readout(viewer)).toBe("(21/33 · 64%)");
    });
  });

  describe("render", () => {
    it("renders border frame", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);

      expect(lines[0]).toMatch(/[╭]/);
      expect(lines[lines.length - 1]).toMatch(/[╰]/);
    });

    it("renders user messages", () => {
      const session = makeMockSession([{ role: "user", content: "hello world" }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("hello world");
    });

    it("renders assistant messages", () => {
      const session = makeMockSession([{ role: "assistant", content: [{ type: "text", text: "here is the answer" }] }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");
      expect(text).toContain("here is the answer");
    });

    it("renders nothing for a standalone toolResult message", () => {
      const session = makeMockSession([
        {
          role: "toolResult",
          content: [{ type: "text", text: "file contents here" }],
          toolName: "read",
          isError: false,
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });

      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      // No title bar, no output block, no status background anywhere.
      expect(contentRows(viewer)).toEqual([]);
      expect(viewer.render(80).join("\n")).not.toContain("file contents here");
    });

    it("renders a settled tool call as a status-colored block with its result text under the title", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "uniqtool",
          isError: false,
          content: [{ type: "text", text: "SECRET-RESULT-TEXT" }],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });

      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      expect(contentRows(viewer)).toEqual(expectedResultBlock(BG_ON.toolSuccessBg, "uniqtool", ["SECRET-RESULT-TEXT"]));
    });

    it("renders an errored tool call with the error background and its result text", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "uniqtool",
          isError: true,
          content: [{ type: "text", text: "boom trace" }],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });

      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      expect(contentRows(viewer)).toEqual(expectedResultBlock(BG_ON.toolErrorBg, "uniqtool", ["boom trace"]));
    });

    it("renders thinking blocks in assistant messages", () => {
      const session = makeMockSession([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("Let me think");
    });

    it("shows waiting message when no messages", () => {
      const session = makeMockSession([]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("waiting");
    });

    it.each([
      ["stopped", "■"],
      ["queued", "◆"],
    ] as const)("shows %s icon in header for status %s", (status, icon) => {
      const session = makeMockSession([]);
      const record = makeMockRecord({
        execution: { settled: true, settlementCount: 1, session },
        lifecycle: { ...makeMockRecord().lifecycle, status },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);

      expect(lines.join("\n")).toContain(icon);
    });

    it("renders worktree label in header when present", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({
        execution: { settled: false, settlementCount: 0, session },
        display: { ...makeMockRecord().display, worktreeLabel: "feature" },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("@feature");
    });

    it("omits worktree label when not present", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).not.toContain("@");
    });
  });

  describe("tool call timing", () => {
    function subscribeCapture(): { emit: (event: unknown) => void } {
      const capture = { emit: (_event: unknown) => {} };
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        capture.emit = cb;
        return () => {};
      });
      return capture;
    }
    const callMessage: TestMessage = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] };
    function resultMessage(durationMs?: number, isError = false): TestMessage & { durationMs?: number } {
      return { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError, content: [], durationMs };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("appends the recorded duration to a settled call line", () => {
      const session = makeMockSession([callMessage, resultMessage(1500)]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolSuccessBg, "uniqtool  Took 1.5s"));
    });

    it("moves the duration to a footer line under the result when expanded, like pi", () => {
      const settled = { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, durationMs: 2100 };
      const session = makeMockSession([callMessage, { ...settled, content: [{ type: "text", text: "out" }] }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(
        makeTui(),
        session,
        record,
        bgMarkingTheme,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        { isExpanded: () => true },
      );

      expect(contentRows(viewer)).toEqual(
        expectedResultBlock(BG_ON.toolSuccessBg, "uniqtool", ["out", "", "Took 2.1s"]),
      );
    });

    it("keeps the duration on an errored call line", () => {
      const session = makeMockSession([callMessage, resultMessage(65_000, true)]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolErrorBg, "uniqtool  Took 1m 5s"));
    });

    it("shows no timing for a settled call whose result has no duration", () => {
      const session = makeMockSession([callMessage, resultMessage()]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolSuccessBg, "uniqtool"));
    });

    it("counts up a running call each second, then settles on the reported duration", () => {
      const capture = subscribeCapture();
      const session = makeMockSession([callMessage]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool"));

      capture.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "uniqtool" });
      vi.advanceTimersByTime(100);
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool  Elapsed 0.1s"));

      vi.advanceTimersByTime(1900);
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool  Elapsed 2.0s"));

      // The tool ends before its result message lands: Took shows at once and the clock stops.
      capture.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "uniqtool", durationMs: 2042 });
      vi.runOnlyPendingTimers();
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool  Took 2.0s"));
      expect(vi.getTimerCount()).toBe(0);

      // The persisted result's duration then takes over.
      session.messages.push(resultMessage(2042));
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolSuccessBg, "uniqtool  Took 2.0s"));
    });

    it("counts a call already running at open from the owner's start time", () => {
      subscribeCapture();
      const session = makeMockSession([callMessage]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const getToolStartedAt = vi.fn((id: string) => (id === "t1" ? Date.now() - 3000 : undefined));
      const viewer = new ConversationViewer(
        makeTui(),
        session,
        record,
        bgMarkingTheme,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        { getToolStartedAt },
      );

      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool  Elapsed 3.0s"));
      vi.advanceTimersByTime(2000);
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool  Elapsed 5.0s"));
    });

    it("does not seed calls that already have a result", () => {
      subscribeCapture();
      const session = makeMockSession([callMessage, resultMessage(800)]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const getToolStartedAt = vi.fn(() => Date.now() - 3000);
      const viewer = new ConversationViewer(
        makeTui(),
        session,
        record,
        bgMarkingTheme,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        { getToolStartedAt },
      );

      expect(getToolStartedAt).not.toHaveBeenCalled();
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolSuccessBg, "uniqtool  Took 0.8s"));
    });

    it("shows no timing for a running call whose start was not observed", () => {
      subscribeCapture();
      const session = makeMockSession([callMessage]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      vi.advanceTimersByTime(5000);
      expect(contentRows(viewer)).toEqual(expectedCallBlock(BG_ON.toolPendingBg, "uniqtool"));
    });

    it("stops the redraw timer on dispose", () => {
      const capture = subscribeCapture();
      const session = makeMockSession([callMessage]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      capture.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "uniqtool" });
      vi.runOnlyPendingTimers(); // flush the debounced render, keep the 1s interval
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      viewer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("tool result output", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`);
    function sessionWith(toolName: string, resultLines: string[]) {
      return makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: toolName }] },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName,
          isError: false,
          content: [{ type: "text", text: resultLines.join("\n") }],
        },
      ]);
    }
    function open(session: ReturnType<typeof makeMockSession>, flag: { expanded: boolean }, extra = {}) {
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      return new ConversationViewer(
        makeTui(),
        session,
        record,
        bgMarkingTheme,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        {
          isExpanded: () => flag.expanded,
          ...extra,
        },
      );
    }
    const bg = BG_ON.toolSuccessBg;

    it("collapsed: shows the first 3 lines and a hint with the remaining count", () => {
      const viewer = open(sessionWith("uniqtool", lines(10)), { expanded: false });

      expect(contentRows(viewer)).toEqual(
        expectedResultBlock(bg, "uniqtool", ["line1", "line2", "line3", "... (7 more lines, ctrl+o to expand)"]),
      );
    });

    it("collapsed bash: shows the last 3 lines under an 'earlier lines' hint", () => {
      const viewer = open(sessionWith("bash", lines(10)), { expanded: false });

      expect(contentRows(viewer)).toEqual(
        expectedResultBlock(bg, "bash", ["... (7 earlier lines, ctrl+o to expand)", "line8", "line9", "line10"]),
      );
    });

    it("collapsed: a result of 3 lines or fewer shows in full with no hint", () => {
      const viewer = open(sessionWith("uniqtool", lines(3)), { expanded: false });

      expect(contentRows(viewer)).toEqual(expectedResultBlock(bg, "uniqtool", ["line1", "line2", "line3"]));
    });

    it("expanded: shows every line with no hint", () => {
      const viewer = open(sessionWith("uniqtool", lines(10)), { expanded: true });

      expect(contentRows(viewer)).toEqual(expectedResultBlock(bg, "uniqtool", lines(10)));
    });

    describe("long tool-call label", () => {
      const command = "echo " + "x".repeat(400);
      const session = () =>
        makeMockSession([
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command } }] },
        ]);
      const rendered = (viewer: ConversationViewer) =>
        contentRows(viewer)
          .join("")
          .replace(/\x1b\[[0-9;]*m/g, "");

      it("collapsed: cuts the command at 350 characters with an ellipsis", () => {
        const text = rendered(open(session(), { expanded: false }));

        expect(text).toContain("…");
        expect(text).not.toContain("x".repeat(346));
      });

      it("expanded: shows the whole command, wrapped, without an ellipsis", () => {
        const text = rendered(open(session(), { expanded: true }));

        expect(text).not.toContain("…");
        // Wrapping splits the command across rows; stripping row padding recovers it whole.
        expect(text.replace(/\s+/g, "")).toContain(`bash(${JSON.stringify(command)})`.replace(/\s+/g, ""));
      });
    });

    it("counts wrapped rows, not source lines, and ignores non-text blocks", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "uniqtool",
          isError: false,
          content: [{ type: "text", text: "x".repeat(150) }, { type: "image" }],
        },
      ]);
      const viewer = open(session, { expanded: true });

      // 150 chars wrap at 74 columns -> 3 rows (74 + 74 + 2)
      expect(contentRows(viewer)).toEqual(expectedResultBlock(bg, "uniqtool", ["x".repeat(74), "x".repeat(74), "xx"]));
    });

    it("colors the key in the hint like pi's keyHint: muted text around a dim key", () => {
      const sgr: Record<string, string> = { toolOutput: "33", muted: "35", dim: "36" };
      const tagTheme: Theme = {
        ...noopTheme,
        fg: (color, text) => `\x1b[${sgr[color] ?? "0"}m${text}\x1b[39m`,
      };
      const session = sessionWith("uniqtool", lines(10));
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, tagTheme, vi.fn());

      const hint = contentRows(viewer).find((row) => row.includes("to expand"));

      expect(hint).toContain(
        "\x1b[35m... (7 more lines,\x1b[39m \x1b[36mctrl+o\x1b[39m\x1b[35m to expand\x1b[39m\x1b[35m)\x1b[39m",
      );
    });

    describe("bash timeout", () => {
      function bashLabel(timeout: unknown): string {
        const session = makeMockSession([
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls", timeout } }],
          },
          { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [] },
        ]);
        return contentRows(open(session, { expanded: false }))[1]
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim();
      }

      it("shows pi's muted (timeout Ns) suffix after the command", () => {
        expect(bashLabel(300)).toBe('bash("ls") (timeout 300s)');
      });

      it("separates the suffix from the timing with a single space", () => {
        const session = makeMockSession([
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls", timeout: 300 } }],
          },
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "bash",
            isError: false,
            content: [],
            durationMs: 2100,
          },
        ]);
        const title = contentRows(open(session, { expanded: false }))[1]
          .replace(/\x1b\[[0-9;]*m/g, "")
          .trim();
        expect(title).toBe('bash("ls") (timeout 300s) Took 2.1s');
      });

      it("omits it when the timeout is absent or not a positive number", () => {
        for (const timeout of [undefined, 0, "300"]) expect(bashLabel(timeout)).not.toContain("timeout");
      });

      it("is only shown for bash", () => {
        const session = makeMockSession([
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "uniqtool", arguments: { timeout: 300 } }],
          },
          { role: "toolResult", toolCallId: "t1", toolName: "uniqtool", isError: false, content: [] },
        ]);
        expect(contentRows(open(session, { expanded: false }))[1]).not.toContain("(timeout");
      });
    });

    describe("clicking a call", () => {
      const CONTENT_TOP = 4; // top border, 2 header rows, separator
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
      function twoCalls() {
        const result = (id: string) => ({
          role: "toolResult",
          toolCallId: id,
          toolName: "uniqtool",
          isError: false,
          content: [{ type: "text", text: lines(6).join("\n") }],
        });
        return makeMockSession([
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "t1", name: "uniqtool" },
              { type: "toolCall", id: "t2", name: "uniqtool" },
            ],
          },
          result("t1"),
          result("t2"),
        ]);
      }
      // Each call renders 7 rows plus a blank separator: t1 at 0-6, t2 at 8-14.
      const firstTitle = CONTENT_TOP + 1;
      const secondTitle = CONTENT_TOP + 9;

      it("expands only the clicked call and collapses it again on a second click", () => {
        const flag = { expanded: false };
        const viewer = open(twoCalls(), flag);
        const collapsed = expectedResultBlock(bg, "uniqtool", [
          "line1",
          "line2",
          "line3",
          "... (3 more lines, ctrl+o to expand)",
        ]);
        expect(contentRows(viewer)).toEqual([...collapsed, ...collapsed]);

        expect(viewer.handleMouse(click(firstTitle))).toEqual({ handled: true });
        expect(contentRows(viewer)).toEqual([...expectedResultBlock(bg, "uniqtool", lines(6)), ...collapsed]);

        expect(viewer.handleMouse(click(firstTitle))).toEqual({ handled: true });
        expect(contentRows(viewer)).toEqual([...collapsed, ...collapsed]);
        expect(flag.expanded).toBe(false); // pi's global flag is untouched
      });

      it("targets the call under the pointer, including when scrolled", () => {
        const viewer = open(twoCalls(), { expanded: false });
        viewer.render(80);

        viewer.handleMouse(click(secondTitle));
        const collapsed = expectedResultBlock(bg, "uniqtool", [
          "line1",
          "line2",
          "line3",
          "... (3 more lines, ctrl+o to expand)",
        ]);
        expect(contentRows(viewer)).toEqual([...collapsed, ...expectedResultBlock(bg, "uniqtool", lines(6))]);
      });

      it("can collapse a single call while the global flag is expanded", () => {
        const viewer = open(twoCalls(), { expanded: true });
        viewer.render(80);
        viewer.handleMouse(click(firstTitle));

        const rows = contentRows(viewer);
        expect(rows).toEqual([
          ...expectedResultBlock(bg, "uniqtool", ["line1", "line2", "line3", "... (3 more lines, ctrl+o to expand)"]),
          ...expectedResultBlock(bg, "uniqtool", lines(6)),
        ]);
      });

      it("drops per-call state when the global flag flips, as pi does", () => {
        const flag = { expanded: false };
        const viewer = open(twoCalls(), flag);
        viewer.handleMouse(click(firstTitle));

        flag.expanded = true;
        expect(contentRows(viewer)).toEqual([
          ...expectedResultBlock(bg, "uniqtool", lines(6)),
          ...expectedResultBlock(bg, "uniqtool", lines(6)),
        ]);
        flag.expanded = false;
        expect(contentRows(viewer)).toHaveLength(14); // both collapsed again
      });

      it("ignores clicks outside a settled call, other buttons, and pending calls", () => {
        const viewer = open(twoCalls(), { expanded: false });
        viewer.render(80);

        expect(viewer.handleMouse(click(CONTENT_TOP + 7))).toBeUndefined(); // blank row between calls
        expect(viewer.handleMouse(click(1))).toBeUndefined(); // header
        expect(viewer.handleMouse(click(firstTitle, "right"))).toBeUndefined();
        expect(contentRows(viewer)).toHaveLength(14);

        const pending = open(
          makeMockSession([{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] }]),
          { expanded: false },
        );
        pending.render(80);
        expect(pending.handleMouse(click(firstTitle))).toBeUndefined();
      });

      it("shows the full command label of a clicked call", () => {
        const command = "echo " + "x".repeat(400);
        const session = makeMockSession([
          { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command } }] },
          { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [] },
        ]);
        const viewer = open(session, { expanded: false });
        const text = () =>
          contentRows(viewer)
            .join("")
            .replace(/\x1b\[[0-9;]*m/g, "");
        expect(text()).toContain("…");

        viewer.handleMouse(click(firstTitle));

        expect(text()).not.toContain("…");
      });
    });

    it("re-renders when pi's global flag flips, without any event", () => {
      const flag = { expanded: false };
      const viewer = open(sessionWith("uniqtool", lines(10)), flag);
      expect(contentRows(viewer)).toHaveLength(7);

      flag.expanded = true;
      expect(contentRows(viewer)).toEqual(expectedResultBlock(bg, "uniqtool", lines(10)));

      flag.expanded = false;
      expect(contentRows(viewer)).toHaveLength(7);
    });

    it("the expand key calls the toggle callback and requests a render", () => {
      const toggleExpanded = vi.fn();
      const viewer = open(sessionWith("uniqtool", lines(10)), { expanded: false }, { toggleExpanded });
      mockRequestRender.mockClear();

      viewer.handleInput("ctrl+o");

      expect(toggleExpanded).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalled();
    });

    it("follows the user's keybinding: matches app.tools.expand and names its key in the hint", () => {
      const toggleExpanded = vi.fn();
      const keybindings = {
        matches: vi.fn((data: string, id: string) => id === "app.tools.expand" && data === "\x0f"),
        getKeys: vi.fn(() => ["alt+e"]),
      };
      const session = sessionWith("uniqtool", lines(10));
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(
        makeTui(),
        session,
        record,
        bgMarkingTheme,
        vi.fn(),
        undefined,
        keybindings,
        undefined,
        {
          isExpanded: () => false,
          toggleExpanded,
        },
      );

      expect(contentRows(viewer).at(-2)).toContain("(7 more lines, alt+e to expand)");
      viewer.handleInput("ctrl+o"); // default key, no longer bound
      expect(toggleExpanded).not.toHaveBeenCalled();
      viewer.handleInput("\x0f");
      expect(toggleExpanded).toHaveBeenCalledTimes(1);
    });

    it("ignores the expand key when no toggle is wired", () => {
      const viewer = open(sessionWith("uniqtool", lines(10)), { expanded: false });

      expect(() => viewer.handleInput("ctrl+o")).not.toThrow();
    });
  });

  describe("caching", () => {
    it("re-renders a cached pending tool call to its settled color when its result arrives", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      // First render caches the assistant message as a pending tool call:
      // fill / title / fill, all pending.
      const pending = viewer.render(80).join("\n");
      expect(count(pending, BG_ON.toolPendingBg)).toBe(3);
      expect(pending).not.toContain(BG_ON.toolSuccessBg);

      // The tool result then arrives as a new message.
      session.messages.push({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "uniqtool",
        isError: false,
        content: [{ type: "text", text: "UNIQRESULT" }],
      });

      // The cached call line must refresh to the settled background — a frozen
      // pending color would hide the completion; the result line joins the block.
      const settled = viewer.render(80).join("\n");
      expect(settled).not.toContain(BG_ON.toolPendingBg);
      expect(count(settled, BG_ON.toolSuccessBg)).toBe(4);
      expect(count(settled, "uniqtool")).toBe(1);
      expect(count(settled, "UNIQRESULT")).toBe(1);
    });

    it("scrolls to the true bottom when streaming adds lines (scrollMax not stale)", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession([{ role: "user", content: "x".repeat(3000) }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      // First render warms the cache and parks the viewport at the bottom of the
      // non-streaming content.
      const before = viewer.render(80).join("\n");
      const beforeTotal = readoutTotal(before);
      expect(beforeTotal).toBeGreaterThan(0);

      // Streaming text arrives (5 rendered lines) without a new session message,
      // so only the streaming suffix changes.
      subscriber!({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a\nb\nc\nd\ne" },
      });
      vi.runAllTimers();

      // G must jump to the true bottom: scrollMax is derived from the current
      // content, not the pre-streaming cache. A stale scrollMax would park the
      // viewport short and the readout would drop below 100%.
      viewer.handleInput("G");
      const after = viewer.render(80).join("\n");
      expect(readoutTotal(after)).toBeGreaterThan(beforeTotal);
      expect(after).toMatch(/\(\d+\/\d+ · 100%\)/);
      // The last streamed line is inside the viewport, not cut off above it.
      expect(after).toContain("│ e");

      vi.useRealTimers();
    });
  });

  describe("dispose", () => {
    it("unsubscribes from session", () => {
      const unsubscribe = vi.fn();
      mockSubscribe.mockReturnValue(unsubscribe);

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.dispose();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe("cache invalidation on messages array replacement", () => {
    it("clears cache when messages array is replaced (e.g., after compaction)", () => {
      const originalMessages = [
        { role: "user", content: "original message 1" },
        { role: "assistant", content: [{ type: "text", text: "original response 1" }] },
        { role: "user", content: "original message 2" },
        { role: "assistant", content: [{ type: "text", text: "original response 2" }] },
      ];
      // Create a session where messages can be replaced
      let messagesArray = [...originalMessages];
      const session = asAgentSession({
        get messages() {
          return messagesArray;
        },
        subscribe: mockSubscribe,
      });
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const firstRender = viewer.render(80).join("\n");
      expect(firstRender).toContain("original message 1");
      expect(firstRender).toContain("original response 1");

      // Simulate compaction: replace the messages array with a shorter one
      messagesArray = [
        { role: "user", content: "original message 1" },
        { role: "assistant", content: [{ type: "text", text: "SUMMARIZED response" }] },
      ];

      // Second render - should show summarized content, not stale cached content
      const secondRender = viewer.render(80).join("\n");
      expect(secondRender).toContain("SUMMARIZED response");
      expect(secondRender).not.toContain("original response 1");
      expect(secondRender).not.toContain("original response 2");
    });

    it("detects array replacement via reference change (not just length)", () => {
      let messagesArray = [
        { role: "user", content: "msg 1" },
        { role: "assistant", content: [{ type: "text", text: "resp 1" }] },
      ];
      const session = asAgentSession({
        get messages() {
          return messagesArray;
        },
        subscribe: mockSubscribe,
      });
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      viewer.render(80);

      // Replace with new array of SAME length but different content (simulating compaction)
      messagesArray = [
        { role: "user", content: "msg 1" },
        { role: "assistant", content: [{ type: "text", text: "COMPACTED" }] },
      ];

      // Should detect the replacement and clear cache
      const text = viewer.render(80).join("\n");
      expect(text).toContain("COMPACTED");
      expect(text).not.toContain("resp 1");
    });

    it("preserves cache on append (no array replacement)", () => {
      const messagesArray: TestMessage[] = [{ role: "user", content: "msg 1" }];
      const session = asAgentSession({
        get messages() {
          return messagesArray;
        },
        subscribe: mockSubscribe,
      });
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const firstRender = viewer.render(80).join("\n");
      expect(firstRender).toContain("msg 1");

      // Append to same array (no replacement)
      messagesArray.push({ role: "assistant", content: [{ type: "text", text: "resp 1" }] });

      const secondRender = viewer.render(80).join("\n");
      expect(secondRender).toContain("msg 1");
      expect(secondRender).toContain("resp 1");
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
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      // Thinking is visible initially (mock returns false for hideThinkingBlock).
      let text = viewer.render(80).join("\n");
      expect(text).toContain("Let me think");
      expect(text).not.toContain("Thinking...");

      // ctrl+T hides thinking blocks behind the placeholder label.
      viewer.handleInput("\x14");
      text = viewer.render(80).join("\n");
      expect(text).not.toContain("Let me think");
      expect(text).toContain("Thinking...");

      // Toggle again restores the blocks.
      viewer.handleInput("\x14");
      text = viewer.render(80).join("\n");
      expect(text).toContain("Let me think");
      expect(text).not.toContain("Thinking...");
    });

    it("shows thinking visibility state in footer", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      const text = viewer.render(120).join("\n");
      expect(text).toContain("C-t thinking");
    });
    it("renders Thinking... label for non-streaming thinking when hideThinkingBlock is true", () => {
      // Mock the setting to return true (thinking should be hidden)
      vi.mocked(getHideThinkingBlock).mockReturnValue(true);
      const session = makeMockSession([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this..." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      const text = viewer.render(80).join("\n");

      // Should show "Thinking..." label, not the actual thinking content
      expect(text).toContain("Thinking...");
      expect(text).not.toContain("Let me think about this...");
      // But should still show the text content
      expect(text).toContain("Here is the answer.");
    });

    it("shows Thinking... label during streaming when thinking is hidden", () => {
      vi.useFakeTimers();
      let subscriber: (event?: unknown) => void;
      mockSubscribe.mockImplementation((cb: (event?: unknown) => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      // Hide thinking
      viewer.handleInput("\x14");

      // Simulate streaming thinking via session events
      subscriber!({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Streaming thought..." },
      });
      vi.runAllTimers();

      const text = viewer.render(80).join("\n");
      expect(text).toContain("Thinking...");
      expect(text).not.toContain("Streaming thought...");

      vi.useRealTimers();
    });

    it("shows Thinking... label during streaming when hideThinkingBlock is true initially", () => {
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
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());

      // Simulate streaming thinking via session events
      subscriber!({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Streaming thought..." },
      });
      vi.runAllTimers();

      const text = viewer.render(80).join("\n");
      expect(text).toContain("Thinking...");
      expect(text).not.toContain("Streaming thought...");

      vi.useRealTimers();
    });
  });
});
