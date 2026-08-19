/**
 * conversation-viewer.test.ts — Tests for ConversationViewer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
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
      overrides?: { color?: (t: string) => string; italic?: boolean },
    ) {
      this._text = text;
      this._color = overrides?.color ?? ((t: string) => t);
      this._italic = overrides?.italic ?? false;
    }
    _text: string;
    _color: (t: string) => string;
    _italic: boolean;
    setText(text: string) {
      this._text = text;
    }
    render(width: number): string[] {
      const lines = this._text.split("\n");
      const result: string[] = [];
      for (const line of lines) {
        let wrapped = line.length > width ? line.slice(0, width) : line;
        if (this._italic) wrapped = wrapped;
        result.push(this._color(wrapped));
      }
      return result;
    }
  },
  truncateToWidth: vi.fn((s: string, w: number) => (s.length > w ? s.slice(0, w - 3) + "..." : s)),
  visibleWidth: vi.fn((s: string) => s.length),
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
 * Theme that marks bg() calls in the rendered output. The tool-result
 * success/error distinction is a background color, which noopTheme flattens.
 */
const bgMarkingTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `[bg:${color}]${text}[/bg]`,
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
}
interface TestMessage {
  role: string;
  content: string | TestContentBlock[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
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

  describe("scroll behavior", () => {
    // 30 distinct one-line rows → 33 content lines (fill + 30 + fill + empty)
    // against a 21-row viewport: maxScroll = 12. Distinct line markers make
    // the visible window observable through rendered output.
    const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    // Content rows sit between the separator under the header and the one
    // above the footer; rows are `│ <content> │` with trailing padding.
    function visibleContentLines(viewer: ConversationViewer): string[] {
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
      const visible = visibleContentLines(viewer);
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
      expect(visibleContentLines(viewer)[0]).toBe("line2");

      viewer.handleInput("\x1b[A"); // back to 2
      expect(readout(viewer)).toBe("(23/33 · 70%)");
      expect(visibleContentLines(viewer)[0]).toBe("line1");
    });

    it("jumps to top on 'g'", () => {
      const session = makeMockSession([{ role: "user", content: manyLines }]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      viewer.render(80); // parked at the bottom by autoScroll
      viewer.handleInput("g");

      const visible = visibleContentLines(viewer);
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

      const visible = visibleContentLines(viewer);
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

      const visible = visibleContentLines(viewer);
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

    it("renders tool results with success background", () => {
      const session = makeMockSession([
        {
          role: "toolResult",
          content: [{ type: "text", text: "file contents here" }],
          toolName: "read",
          isError: false,
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, bgMarkingTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("read");
      expect(text).toContain("toolSuccessBg");
      expect(text).not.toContain("toolErrorBg");
    });

    it("renders tool results with error background", () => {
      const session = makeMockSession([
        {
          role: "toolResult",
          content: [{ type: "text", text: "file not found" }],
          toolName: "read",
          isError: true,
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, bgMarkingTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("read");
      expect(text).toContain("toolErrorBg");
      expect(text).not.toContain("toolSuccessBg");
    });

    it("truncates tool results at 500 chars", () => {
      const longContent = "x".repeat(600); // >500 triggers truncation, but preview fits in viewport
      const session = makeMockSession([
        {
          role: "toolResult",
          content: [{ type: "text", text: longContent }],
          toolName: "bash",
          isError: false,
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("bash");
      expect(text).toContain("xxxxx");
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

  describe("caching", () => {
    it("renders a tool result once, inline under its call (no standalone duplicate)", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "uniqtool",
          isError: false,
          content: [{ type: "text", text: "UNIQRESULT" }],
        },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      const text = viewer.render(80).join("\n");
      expect(count(text, "UNIQRESULT")).toBe(1);
      expect(count(text, "uniqtool")).toBe(1);
    });

    it("re-renders a cached assistant tool call when its result arrives (no duplicate title)", () => {
      const session = makeMockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "uniqtool" }] },
      ]);
      const record = makeMockRecord({ execution: { settled: false, settlementCount: 0, session } });
      const viewer = new ConversationViewer(makeTui(), session, record, noopTheme, vi.fn());

      // First render caches the assistant message as a pending tool call.
      viewer.render(80);
      // The tool result then arrives as a new message.
      session.messages.push({
        role: "toolResult",
        toolCallId: "t1",
        toolName: "uniqtool",
        isError: false,
        content: [{ type: "text", text: "UNIQRESULT" }],
      });

      const text = viewer.render(80).join("\n");
      expect(count(text, "UNIQRESULT")).toBe(1);
      expect(count(text, "uniqtool")).toBe(1);
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
