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

/** The background each call state is painted with: the status is otherwise invisible. */
const STATUS_BG = { success: BG_ON.toolSuccessBg, error: BG_ON.toolErrorBg, pending: BG_ON.toolPendingBg };
/**
 * What the viewer hands pi-tui must carry no control text of its own. The theme adds
 * SGR (colours), so those come out first: any escape or control character left would
 * be acted on by the terminal.
 */
function expectNoControlText(lines: string[]): void {
  const painted = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  expect(painted).not.toContain("\u001b");
  // oxlint-disable-next-line no-control-regex -- asserting no control character survives is the point
  expect(painted).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFF9-\uFFFB\p{Bidi_Control}]/u);
}

function statusShown(viewer: ConversationViewer): keyof typeof STATUS_BG | undefined {
  const painted = viewer.render(80).join("");
  return (Object.keys(STATUS_BG) as Array<keyof typeof STATUS_BG>).find((s) => painted.includes(STATUS_BG[s]));
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

/** Total content lines from the footer scroll readout (N/N · pct%). */
function readoutTotal(text: string): number {
  const m = text.match(/\((\d+)\/(\d+) · /);
  return m ? Number(m[2]) : 0;
}

/**
 * Content rows between the separator under the header and the one above the
 * footer, trimmed of the `│ … │` row frame and empties.
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

    it("marks a settled call as finished and shows its result under the title", () => {
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

      expect(statusShown(viewer)).toBe("success");
      expect(shownRows(viewer)).toEqual(["uniqtool", "SECRET-RESULT-TEXT"]);
    });

    it("marks an errored call as failed and shows the failure under the title", () => {
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

      expect(statusShown(viewer)).toBe("error");
      expect(shownRows(viewer)).toEqual(["uniqtool", "boom trace"]);
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

  // --- Tool calls: result previews, timings, expanding -------------------------------------------
  //
  // These read the content area with styling stripped: which lines the viewer
  // shows, and how much of a result it hides, is the contract. The colors,
  // padding and row framing it paints them with are not.

  function shownRows(viewer: ConversationViewer): string[] {
    return contentRows(viewer)
      .map((row) => row.replace(/\u001b\[[0-9;]*m/g, "").trim())
      .filter(Boolean); // padding and background-only rows are not content
  }
  /** Result bodies are built from `bodyN` markers, so a test can count what is on screen. */
  const bodyText = (n: number) => Array.from({ length: n }, (_, i) => `body${i + 1}`).join("\n");
  const bodyRows = (viewer: ConversationViewer) => shownRows(viewer).filter((row) => /^body\d+$/.test(row));
  /** The hint is the one row that starts with pi's ellipsis. */
  const hintRow = (viewer: ConversationViewer) => shownRows(viewer).find((row) => row.startsWith("..."));
  /** The timing on screen: `Took ...` once a call settled, `Elapsed ...` while it runs. */
  const timingOf = (viewer: ConversationViewer) =>
    shownRows(viewer)
      .join(" ")
      .match(/(Took|Elapsed) \S+/)?.[0];

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
    toolDisplay?: Record<string, unknown>;
    keybindings?: ViewerKeybindings;
    /** Terminal rows: fewer rows than the transcript forces scrolling. */
    rows?: number;
  }
  function openCallView(messages: TestMessage[], view: CallView = {}): ConversationViewer {
    const session = makeMockSession(messages);
    const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
    return new ConversationViewer(
      makeTui(view.rows),
      session,
      record,
      noopTheme,
      vi.fn(),
      undefined,
      view.keybindings,
      undefined,
      { isExpanded: () => view.flag?.expanded ?? false, ...view.toolDisplay },
    );
  }

  describe("tool call results", () => {
    it("shows a short result whole and a long one with a hint naming what is hidden", () => {
      expect(bodyRows(openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(2) })]))).toEqual([
        "body1",
        "body2",
      ]);

      const flag = { expanded: false };
      const long = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(10) })], { flag });
      expect(bodyRows(long)).toEqual(["body1", "body2", "body3"]);
      expect(hintRow(long)).toMatch(/\b7\b/); // 10 rows in the fixture, 3 shown
      expect(hintRow(long)).toContain("ctrl+o"); // the key that shows the rest

      flag.expanded = true;
      expect(bodyRows(long)).toEqual(bodyText(10).split("\n"));
      expect(hintRow(long)).toBeUndefined();
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

    it("counts wrapped rows, not source lines, and ignores non-text blocks", () => {
      // One source line of 320 characters: 5 wrapped rows at this width, so 2 stay hidden.
      const wide = [callsOf({ id: "t1" }), resultOf("t1", { text: "x".repeat(320) })];
      expect(shownRows(openCallView(wide)).filter((row) => /^x+$/.test(row))).toHaveLength(3);
      expect(hintRow(openCallView(wide))).toMatch(/\b2\b/); // 5 wrapped rows, 3 shown

      const withImage = [
        callsOf({ id: "t1" }),
        resultOf("t1", { blocks: [{ type: "text", text: "x".repeat(320) }, { type: "image" }] }),
      ];
      expect(shownRows(openCallView(withImage)).filter((row) => /^x+$/.test(row))).toHaveLength(3);
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
      // Read the painted frame, not the rows that have had their styling removed to read
      // content: a leak of colour codes would be invisible in those.
      const frame = viewer.render(80);
      expectNoControlText(frame);
      // Colour codes are the one thing the theme emits too, so the frame-wide check cannot
      // tell a leaked one from an owned one. The hostile one is named.
      expect(frame.join("")).not.toContain("\u001b[31mred");
      const shown = shownRows(viewer).join("\n");
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
        expectNoControlText(viewer.render(80));
        expect(shownRows(viewer).join(" ")).toContain("echo AB"); // the command stays readable
        // JSON.stringify escapes the 7-bit controls into inert text, but not the 8-bit
        // ones: those reached the frame until the call line got the same strip as the result.
        expect(shownRows(viewer).join(" ")).toContain('("echo AB ');
      }
    });

    it("keeps the text after an unterminated escape sequence", () => {
      const shown = shownRows(
        openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: "before \u001b]0;never-ended after" })]),
      ).join("\n");

      expect(shown).not.toContain("\u001b");
      expect(shown).toContain("before");
      expect(shown).toContain("after");
    });

    it("shows the whole command once expanded and a shortened one collapsed", () => {
      const whole = "echo " + "TAIL".repeat(120);
      const messages = [callsOf({ id: "t1", name: "bash", args: { command: whole } })];

      expect(shownRows(openCallView(messages)).join(" ")).not.toContain(whole);
      expect(shownRows(openCallView(messages, { flag: { expanded: true } })).join("")).toContain(whole);
    });

    it("carries a bash timeout, and only a usable one on a bash call", () => {
      const title = (name: string, args?: Record<string, unknown>) =>
        shownRows(openCallView([callsOf({ id: "t1", name, args })]))[0];

      expect(title("bash", { command: "ls", timeout: 300 })).toMatch(/timeout 300s/);
      expect(title("uniqtool", { timeout: 300 })).not.toContain("timeout");
      expect(title("bash", { command: "ls", timeout: 0 })).not.toContain("timeout");
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

    it("reports the duration its result carries, whether the call failed or not", () => {
      for (const isError of [false, true]) {
        const settled = resultOf("t1", { durationMs: 1500, isError });
        expect(timingOf(openCallView([callsOf({ id: "t1", name: "bash" }), settled]))).toBe("Took 1.5s");
      }
    });

    it("puts the timing on the call line collapsed and on its own line under the result expanded", () => {
      const messages = [callsOf({ id: "t1", name: "bash" }), resultOf("t1", { text: bodyText(2), durationMs: 1500 })];

      const collapsed = shownRows(openCallView(messages));
      expect(collapsed[0]).toContain("Took 1.5s"); // shares the call's line, to save a row
      expect(collapsed.filter((row) => row.includes("Took"))).toHaveLength(1);

      const expanded = shownRows(openCallView(messages, { flag: { expanded: true } }));
      expect(expanded[0]).not.toContain("Took");
      expect(expanded.indexOf("Took 1.5s")).toBeGreaterThan(expanded.indexOf("body2")); // after the output, as pi does
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

        // The result's number is monotonic and survives a reload; the viewer's clock is neither.
        expect(timingOf(viewer)).toBe("Took 10.0s");
        viewer.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays quiet when nothing recorded how long the call took", () => {
      // Settled, but the host that wrote the result stored no duration.
      expect(timingOf(openCallView([callsOf({ id: "t1", name: "bash" }), resultOf("t1")]))).toBeUndefined();
      // Running, but it started before the viewer opened and nobody knows its start.
      expect(timingOf(openCallView([callsOf({ id: "t1", name: "bash" })]))).toBeUndefined();

      // A result that landed without a duration ends the count too: a settled call never
      // counts up, even when its start arrives after the result.
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([callsOf({ id: "t1", name: "bash" }), resultOf("t1", { name: "bash" })]);
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        vi.advanceTimersByTime(1000);
        expect(timingOf(viewer)).toBeUndefined();
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
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      expect(shownRows(viewer)).toContain("plain text result");
    });

    it("counts a running call up, then settles on the time it actually took", () => {
      vi.useFakeTimers();
      try {
        const emit = emitter();
        const viewer = openCallView([callsOf({ id: "t1", name: "bash" })]);
        expect(timingOf(viewer)).toBeUndefined();

        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
        vi.advanceTimersByTime(100);
        expect(timingOf(viewer)).toBe("Elapsed 0.1s");
        vi.advanceTimersByTime(1900);
        expect(timingOf(viewer)).toBe("Elapsed 2.0s");

        // The call ends before its result message lands, so the event carries the time.
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", durationMs: 2042 });
        vi.advanceTimersByTime(100);
        expect(timingOf(viewer)).toBe("Took 2.0s");

        vi.advanceTimersByTime(100); // let the repaint settle
        expect(vi.getTimerCount()).toBe(0); // no call is running, so the once-a-second redraw is gone

        mockRequestRender.mockClear();
        vi.advanceTimersByTime(5000);
        expect(mockRequestRender).not.toHaveBeenCalled(); // nothing left to redraw
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts calls that were already running when the viewer opened, and only those", () => {
      vi.useFakeTimers();
      try {
        const startedBeforeViewer = Date.now() - 4000;
        const getToolStartedAt = vi.fn<(id: string) => number | undefined>((id) =>
          id === "t2" ? startedBeforeViewer : undefined,
        );
        const viewer = openCallView(
          [
            callsOf({ id: "t1", name: "bash" }, { id: "t2", name: "bash" }),
            resultOf("t1", { name: "bash", durationMs: 900 }),
          ],
          {
            toolDisplay: { getToolStartedAt },
          },
        );

        const shown = shownRows(viewer).join(" ");
        expect(shown).toContain("Took 0.9s"); // settled: its own result answers for it
        expect(shown).toContain("Elapsed 4.0s"); // running: counted from the start its owner recorded
        expect(getToolStartedAt).toHaveBeenCalledWith("t2");
        expect(getToolStartedAt).not.toHaveBeenCalledWith("t1");
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
    /** 4 frame rows above the content area, then the first call's title row. */
    const FIRST_CALL_TITLE = 5;

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
      shownRows(viewer).filter((row) => new RegExp(`^${marker}\\d+$`).test(row)).length;

    it("expands only the clicked call, and collapses it again on the next click", () => {
      const flag = { expanded: false };
      const viewer = openCallView(TWO_CALLS, { flag });
      viewer.render(80);
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, COLLAPSED]);

      expect(viewer.handleMouse(click(FIRST_CALL_TITLE))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([EXPANDED, COLLAPSED]);
      expect(flag.expanded).toBe(false); // a per-call choice leaves pi's flag alone

      viewer.handleMouse(click(FIRST_CALL_TITLE));
      expect(shownOf(viewer, "a")).toBe(COLLAPSED);

      const secondTitle = viewer.render(80).flatMap((l, i) => (l.includes("uniqtool") ? [i] : []))[1];
      expect(viewer.handleMouse(click(secondTitle))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, EXPANDED]);
    });

    it("maps a click to the frame on screen, not to the scroll position behind it", () => {
      const notes: TestMessage[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `note${i + 1}` }],
      }));
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
      const painted = viewer.render(80);
      const secondTitle = painted.map((l, i) => (l.includes("uniqtool") ? i : -1)).filter((i) => i >= 0)[1];
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
      const notes: TestMessage[] = Array.from({ length: 30 }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `note${i + 1}` }],
      }));
      const viewer = openCallView([...notes, callsOf({ id: "t1" }), resultOf("t1", { text: markerBody("b") })], {
        rows: SCROLLABLE_ROWS,
      });
      const scroll = (delta: number) => {
        viewer.handleMouse(wheel(delta));
        viewer.render(80);
      };
      scroll(999); // auto-scroll already rests here; the call is on screen
      const titleRow = viewer.render(80).findIndex((line) => line.includes("uniqtool"));
      expect(titleRow).toBeGreaterThan(0);

      expect(viewer.handleMouse(click(titleRow))).toEqual({ handled: true });
      expect(shownRows(viewer)).toContain("b6"); // the call under the pointer opened

      scroll(-999);
      expect(viewer.render(80).join(" ")).not.toContain("uniqtool"); // precondition: the call is off screen
      expect(viewer.handleMouse(click(titleRow))).toBeUndefined(); // that row belongs to someone else now
    });

    it("collapses one call while pi's global flag has the rest expanded", () => {
      const viewer = openCallView(TWO_CALLS, { flag: { expanded: true } });
      viewer.render(80);

      expect(viewer.handleMouse(click(FIRST_CALL_TITLE))).toEqual({ handled: true });
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, EXPANDED]);
    });

    it("drops per-call choices when pi's global flag flips, and follows the flag without any event", () => {
      const flag = { expanded: false };
      const viewer = openCallView(TWO_CALLS, { flag });
      viewer.render(80);
      expect(viewer.handleMouse(click(FIRST_CALL_TITLE))).toEqual({ handled: true });

      flag.expanded = true;
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([EXPANDED, EXPANDED]); // the click no longer overrides
      flag.expanded = false;
      expect([shownOf(viewer, "a"), shownOf(viewer, "b")]).toEqual([COLLAPSED, COLLAPSED]);
    });

    it("ignores clicks that land anywhere but on a finished call", () => {
      const viewer = openCallView(TWO_CALLS);
      // The row count has to come from the painted frame, not from what the viewport
      // would be right now: opening the steering composer makes the viewer one row
      // shorter, and a click can arrive before the next frame is painted.
      const notes: TestMessage[] = Array.from({ length: 20 }, (_, i) => ({
        role: "user",
        content: [{ type: "text", text: `note${i + 1}` }],
      }));
      const steerable = makeMockSession([...notes, callsOf({ id: "t2" }), resultOf("t2", { text: bodyText(3) })]);
      const live = new ConversationViewer(
        makeTui(SCROLLABLE_ROWS),
        steerable,
        makeMockRecord({
          lifecycle: { status: "running", startedAt: Date.now(), started: true },
          execution: { settled: false, settlementCount: 0, session: steerable },
        }),
        noopTheme,
        vi.fn(),
        undefined,
        undefined,
        vi.fn(),
      );
      live.render(80); // auto-scroll rests one blank row under the call
      live.handleMouse(wheel(-1)); // one row up, so the frame's last row is the call's own
      const painted = live.render(80);
      const paintedSeparators = painted.flatMap((line, i) => (line.includes("─") ? [i] : []));
      const lastPaintedRow = paintedSeparators[2] - 1;
      expect(live.handleMouse(click(lastPaintedRow))).toEqual({ handled: true });

      live.handleInput("\r"); // opens the composer: the live viewport is a row shorter
      expect(live.handleMouse(click(lastPaintedRow))).toEqual({ handled: true });
      // The frame keeps its height; the content area gives a row to the composer.
      const shrunk = live.render(80).flatMap((line, i) => (line.includes("─") ? [i] : []));
      expect(shrunk[2]).toBe(paintedSeparators[2] - 1);

      // Nothing has been rendered yet, so there are no rows to hit.
      expect(viewer.handleMouse(click(FIRST_CALL_TITLE))).toBeUndefined();
      viewer.render(80);

      expect(viewer.handleMouse(click(0))).toBeUndefined(); // header
      expect(viewer.handleMouse(click(FIRST_CALL_TITLE, "right"))).toBeUndefined(); // not the left button
      expect(shownOf(viewer, "a")).toBe(COLLAPSED);

      // The rows under the content area are the footer and the bottom border. Seen from
      // the top of a scrolling transcript they still map to content lines, lines that
      // belong to a call painted below the fold. Only the painted row count stops a
      // click there, not the block list: the line it maps to is inside a block.
      // Twelve text lines put the first call's body just under the fold.
      const twelveLines = Array.from({ length: 12 }, (_, i) => `note${i + 1}`).join("\n");
      const tall = openCallView([{ role: "user", content: [{ type: "text", text: twelveLines }] }, ...TWO_CALLS], {
        rows: SCROLLABLE_ROWS,
      });
      tall.render(80);
      tall.handleMouse(wheel(-999)); // back to the top
      const frame = tall.render(80);
      const separators = frame.flatMap((line, i) => (line.includes("─") ? [i] : []));
      const belowContent = separators[2]; // the separator the content area ends at
      expect(belowContent).toBeGreaterThan(separators[1]);
      expect(shownOf(tall, "a")).toBe(0); // its body rows are below the fold

      for (const row of [belowContent, belowContent + 1, belowContent + 2, frame.length - 1]) {
        expect(tall.handleMouse(click(row))).toBeUndefined();
        expect(shownOf(tall, "a")).toBe(0); // and none of them opened the call down there
      }

      // A block runs from its first painted row to its last; the blank row after it, and
      // the row before it, belong to no call. Row indices come from the painted frame.
      const titles = viewer.render(80).flatMap((line, i) => (line.includes("uniqtool") ? [i] : []));
      const [firstTitle, secondTitle] = titles;
      expect(secondTitle - firstTitle).toBeGreaterThan(3);
      expect(viewer.handleMouse(click(secondTitle - 2))).toBeUndefined(); // the gap between the blocks
      expect(viewer.handleMouse(click(firstTitle - 1))).toEqual({ handled: true }); // the block's own row above its title
      expect(shownOf(viewer, "a")).toBe(EXPANDED);

      // A frame that was never painted, or is about to be rebuilt, has nothing to hit.
      const torn = openCallView(TWO_CALLS);
      torn.render(80);
      torn.render(4); // too narrow to render anything
      expect(torn.handleMouse(click(FIRST_CALL_TITLE))).toBeUndefined();
      torn.render(80);
      torn.invalidate();
      expect(torn.handleMouse(click(FIRST_CALL_TITLE))).toBeUndefined();

      // A transcript that emptied while the viewer was open shows no calls, so the rows
      // the last one painted are gone with it.
      const emptied = makeMockSession([callsOf({ id: "t1" }), resultOf("t1", { text: markerBody("a") })]);
      const emptiedViewer = new ConversationViewer(
        makeTui(),
        emptied,
        makeMockRecord({ execution: { settled: false, settlementCount: 0, session: emptied } }),
        noopTheme,
        vi.fn(),
      );
      emptiedViewer.render(80);
      emptied.messages.length = 0;
      emptiedViewer.render(80);
      expect(emptiedViewer.handleMouse(click(FIRST_CALL_TITLE))).toBeUndefined();

      // A call still waiting for its result is not clickable.
      const running = openCallView([callsOf({ id: "t1" })]);
      running.render(80);
      expect(running.handleMouse(click(FIRST_CALL_TITLE))).toBeUndefined();
    });

    it("takes the expand key and its hint label from the user's binding", () => {
      const toggleExpanded = vi.fn();
      const bound = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: bodyText(10) })], {
        toolDisplay: { toggleExpanded },
        keybindings: {
          matches: (data: string, id: string) => id === "app.tools.expand" && data === "\u001be",
          getKeys: () => ["alt+e"],
        },
      });

      bound.handleInput("\u000f"); // pi's default key, unbound for this user
      expect(toggleExpanded).not.toHaveBeenCalled();
      bound.handleInput("o"); // a letter the user typed, not a binding
      expect(toggleExpanded).not.toHaveBeenCalled();
      bound.handleInput("\u001be");
      expect(toggleExpanded).toHaveBeenCalledTimes(1);
      expect(mockRequestRender).toHaveBeenCalled();
      expect(hintRow(bound)).toContain("alt+e");

      // Headless use wires no toggle at all: the bound key must be ignored, not thrown on.
      const unwired = openCallView([callsOf({ id: "t1" }), resultOf("t1", { text: markerBody("a") })], {
        keybindings: { matches: () => true },
      });
      const collapsed = shownOf(unwired, "a");
      expect(collapsed).toBeGreaterThan(0);
      expect(() => unwired.handleInput("\u000f")).not.toThrow();
      expect(shownOf(unwired, "a")).toBe(collapsed);
    });
  });

  describe("caching", () => {
    it("re-renders a cached pending tool call to its settled color when its result arrives", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, bgMarkingTheme, vi.fn());

      // First render caches the assistant message as a pending tool call.
      viewer.render(80);
      expect(statusShown(viewer)).toBe("pending");
      expect(shownRows(viewer)).toEqual(["uniqtool"]);

      // The tool result then arrives as a new message.
      session.messages.push({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "uniqtool",
        isError: false,
        content: [{ type: "text", text: "UNIQRESULT" }],
      });

      // The cached call line must be rebuilt: a frozen pending state would hide the
      // completion, and the result has to appear under it exactly once.
      viewer.render(80);
      expect(statusShown(viewer)).toBe("success");
      expect(shownRows(viewer)).toEqual(["uniqtool", "UNIQRESULT"]);
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
