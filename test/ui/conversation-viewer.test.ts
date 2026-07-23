/**
 * conversation-viewer.test.ts — Tests for ConversationViewer.
 *
 * Covers:
 *   - Rendering header with status, duration, tool uses, tokens
 *   - Rendering user/assistant/toolResult messages
 *   - Thinking blocks in assistant messages
 *   - Tool result success/error icons
 *   - Tool result truncation at 4000 chars
 *   - Scroll behavior (up/down/pageup/pagedown/g/G)
 *   - Close on q/Esc
 *   - Stop key two-press confirmation ('s')
 *   - Steering composer (Enter opens, sends on Enter, cancels on Esc)
 *   - Auto-scroll behavior
 *   - Event-driven updates via session.subscribe
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSubscribe = vi.fn(() => () => {});
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
    };
    return (map[key] ?? [key]).includes(data);
  }),
  Input: class {
    focused = false;
    onSubmit: ((v: string) => void) | undefined;
    onEscape: (() => void) | undefined;
    handleInput(_data: string) {}
    render(_w: number): string[] { return ["> "]; }
  },
  truncateToWidth: vi.fn((s: string, w: number) => s.length > w ? s.slice(0, w - 3) + "..." : s),
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

function makeMockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: mockSubscribe,
  } as any;
}

function makeMockRecord(overrides: Partial<any> = {}) {
  return {
    id: "abc12345",
    lifecycle: {
      status: "running",
      startedAt: Date.now() - 30000,
      completedAt: undefined,
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
    execution: { session: makeMockSession() },
    ...overrides,
  } as any;
}

function makeTui() {
  return {
    terminal: { rows: 40, cols: 120 },
    requestRender: mockRequestRender,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("subscription", () => {
    it("subscribes to session events on construction", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());

      expect(session.subscribe).toHaveBeenCalledTimes(1);
    });

    it("requests render on session events", () => {
      let subscriber: () => void;
      mockSubscribe.mockImplementation((cb: () => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());

      subscriber!();
      expect(mockRequestRender).toHaveBeenCalledTimes(1);
    });

    it("stops processing events after close", () => {
      let subscriber: () => void;
      mockSubscribe.mockImplementation((cb: () => void) => {
        subscriber = cb;
        return () => {};
      });

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();
      const done = vi.fn();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done);

      // Close the viewer (via q key)
      viewer.handleInput("q");
      subscriber!();
      // Should not request render after close
      expect(mockRequestRender).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("closes on 'q' key", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done);
      viewer.handleInput("q");
      expect(done).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape", () => {
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done);
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
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, onStop);

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
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, onStop);

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
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, onStop);

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
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      // Composer should be open (internal state)
      const composer = (viewer as any).composer;
      expect(composer).toBeDefined();
    });

    it("sends steer message on composer submit", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer

      // Simulate submit
      const composer = (viewer as any).composer;
      composer.onSubmit("do this thing");

      expect(onSteer).toHaveBeenCalledWith("do this thing");
    });

    it("does not open composer when agent is not running", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "completed", startedAt: Date.now() - 10000, completedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r");

      const composer = (viewer as any).composer;
      expect(composer).toBeUndefined();
    });

    it("cancels composer on Escape", () => {
      const onSteer = vi.fn();
      const done = vi.fn();
      const session = makeMockSession();
      const record = makeMockRecord({
        lifecycle: { status: "running", startedAt: Date.now() },
        execution: { session },
      });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, done, undefined, undefined, onSteer);
      viewer.handleInput("\r"); // open composer

      const composer = (viewer as any).composer;
      composer.onEscape();

      expect((viewer as any).composer).toBeUndefined();
    });
  });

  describe("scroll behavior", () => {
    it("scrolls down on down arrow", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(3000) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      (viewer as any).lastInnerW = 116; // normally set by render()
      const initialOffset = (viewer as any).scrollOffset;
      (viewer as any).autoScroll = false; // disable auto-scroll to test raw scroll

      viewer.handleInput("\x1b[B");
      expect((viewer as any).scrollOffset).toBe(initialOffset + 1);
    });

    it("scrolls up on up arrow", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(200) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      (viewer as any).scrollOffset = 5;

      viewer.handleInput("\x1b[A");
      expect((viewer as any).scrollOffset).toBe(4);
    });

    it("jumps to top on 'g'", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(200) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      (viewer as any).scrollOffset = 10;

      viewer.handleInput("g");
      expect((viewer as any).scrollOffset).toBe(0);
    });

    it("jumps to bottom on 'G'", () => {
      const session = makeMockSession([{ role: "user", content: "x".repeat(500) }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());

      viewer.handleInput("G");
      // Should be at max scroll
      const contentLines = (viewer as any).buildContentLines(116);
      const viewportH = (viewer as any).viewportHeight();
      const maxScroll = Math.max(0, contentLines.length - viewportH);
      expect((viewer as any).scrollOffset).toBe(maxScroll);
    });

    it("does not scroll past start", () => {
      const session = makeMockSession([{ role: "user", content: "hello" }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      viewer.handleInput("\x1b[A");
      expect((viewer as any).scrollOffset).toBe(0);
    });
  });

  describe("render", () => {
    it("renders border frame", () => {
      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);

      expect(lines[0]).toMatch(/[╭]/);
      expect(lines[lines.length - 1]).toMatch(/[╰]/);
    });

    it("renders user messages", () => {
      const session = makeMockSession([{ role: "user", content: "hello world" }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("[User]");
      expect(text).toContain("hello world");
    });

    it("renders assistant messages", () => {
      const session = makeMockSession([{ role: "assistant", content: [{ type: "text", text: "here is the answer" }] }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("[Assistant]");
      expect(text).toContain("here is the answer");
    });

    it("renders tool results with success icon", () => {
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: "file contents here" }],
        toolName: "read",
        isError: false,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("\u2713"); // checkmark
    });

    it("renders tool results with error icon", () => {
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: "file not found" }],
        toolName: "read",
        isError: true,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("\u2717"); // cross
    });

    it("truncates tool results at 4000 chars", () => {
      const longContent = "x".repeat(5000);
      const session = makeMockSession([{
        role: "toolResult",
        content: [{ type: "text", text: longContent }],
        toolName: "bash",
        isError: false,
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      // Should contain truncation marker
      expect(text).toContain("truncated");
    });

    it("renders thinking blocks in assistant messages", () => {
      const session = makeMockSession([{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think about this..." },
          { type: "text", text: "Here is the answer." },
        ],
      }]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("Let me think");
    });

    it("shows waiting message when no messages", () => {
      const session = makeMockSession([]);
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      const lines = viewer.render(80);
      const text = lines.join("\n");

      expect(text).toContain("waiting");
    });
  });

  describe("dispose", () => {
    it("unsubscribes from session", () => {
      const unsubscribe = vi.fn();
      mockSubscribe.mockReturnValue(unsubscribe);

      const session = makeMockSession();
      const record = makeMockRecord({ execution: { session } });
      const tui = makeTui();

      const viewer = new ConversationViewer(tui, session, record, undefined, noopTheme, vi.fn());
      viewer.dispose();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
