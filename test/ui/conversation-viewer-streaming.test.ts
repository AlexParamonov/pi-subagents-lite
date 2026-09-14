/**
 * conversation-viewer-streaming.test.ts — Streaming lifecycle in the viewer.
 *
 * Simulates pi's real streaming semantics (packages/agent/src/agent-loop.ts):
 *   - "start": an EMPTY partial assistant message is pushed into the live
 *     messages array and a session-level `message_start` is emitted.
 *   - every content event: the LAST array element is REPLACED with a new
 *     partial object (array reference and length stay constant) and a
 *     `message_update` carries the raw assistantMessageEvent (thinking_*,
 *     text_*, toolcall_*).
 *   - "done": the final message is swapped into the last slot and a
 *     session-level `message_end` is emitted (agent-session.ts forwards it
 *     to subscribers as `{ type: "message_end", message }`).
 *   - the TUI renders continuously, so a render follows every event batch.
 *
 * The viewer caches per-message-index render lines keyed on array reference +
 * count + width. None of those change while the partial message mutates, so
 * the in-flight assistant message's cache entry would stay frozen at whatever
 * was on screen when it was first rendered. The streaming accumulators are
 * the only live content, and they are cleared on *_end — so each completed
 * block would vanish from the view until something forced a re-render of that
 * index (for a tool-calling message: the toolResult arriving). These tests pin
 * the fix: completed blocks render from the session transcript the moment they
 * complete, and content only ever accumulates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../src/types.js";
import type { Theme } from "../../src/ui/types.js";
import { asAgentSession } from "../pi-boundaries.js";

const mockSubscribe = vi.fn<(listener: (event?: unknown) => void) => () => void>(() => () => {});
const mockRequestRender = vi.fn();

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: vi.fn(() => false),
  Input: class {
    focused = false;
    handleInput(_data: string) {}
    render(_w: number): string[] {
      return [""];
    }
  },
  Markdown: class {
    _text = "";
    constructor(text: string) {
      this._text = text;
    }
    setText(text: string) {
      this._text = text;
    }
    render(_width: number): string[] {
      return this._text.split("\n");
    }
  },
  truncateToWidth: vi.fn((s: string, w: number) => (s.length > w ? s.slice(0, w - 3) + "..." : s)),
  visibleWidth: vi.fn((s: string) => s.length),
  wrapTextWithAnsi: vi.fn((text: string) => text.split("\n")),
}));
vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

import { ConversationViewer } from "../../src/ui/conversation-viewer.js";

const noopTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
interface Msg {
  role: string;
  content: string | Block[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** An assistant partial carrying exactly these content blocks. */
function msgWith(...blocks: Block[]): Msg {
  return { role: "assistant", content: blocks };
}

function makeRecord(session: unknown): AgentRecord {
  return {
    id: "abc12345",
    lifecycle: { status: "running", startedAt: Date.now() - 30000, completedAt: undefined, started: true },
    display: { type: "builder", description: "test agent", invocation: { modelName: "sonnet" } },
    stats: {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      toolUses: 5,
      turnCount: 10,
      compactionCount: 0,
    },
    execution: { settled: false, settlementCount: 0, session },
  } as AgentRecord;
}

function makeTui(): TUI {
  return {
    terminal: { rows: 40, cols: 120 },
    requestRender: mockRequestRender,
  } as unknown as TUI;
}

/** Mirrors agent-loop.ts streaming: partial message swapped per delta, array ref/count stable. */
class FakeStream {
  subscriber: (event?: unknown) => void = () => {};
  constructor(public messages: Msg[]) {}
  /** message_start: pi pushes an empty partial assistant message and emits the event. */
  start(): void {
    const empty = msgWith();
    this.messages.push(empty);
    this.subscriber({ type: "message_start", message: empty });
  }
  /** A content event: replace the last element with the new partial, emit message_update. */
  event(meType: string, partial: Msg, delta?: string): void {
    this.messages[this.messages.length - 1] = partial;
    this.subscriber({ type: "message_update", assistantMessageEvent: { type: meType, delta }, message: partial });
  }
  /** done: pi swaps the final message into the last slot and emits session-level message_end. */
  end(final: Msg): void {
    this.messages[this.messages.length - 1] = final;
    this.subscriber({ type: "message_end", message: final });
  }
}

const THINKING = "STEP-ONE-THOUGHT";
const TEXT = "PART-ONE-TEXT";

function setup(): { stream: FakeStream; render: () => string } {
  const messages: Msg[] = [{ role: "user", content: "do the thing" }];
  const stream = new FakeStream(messages);
  mockSubscribe.mockImplementation((cb) => {
    stream.subscriber = cb;
    return () => {};
  });
  const session = asAgentSession({ messages, subscribe: mockSubscribe });
  const viewer = new ConversationViewer(makeTui(), session as never, makeRecord(session), noopTheme, vi.fn());
  return { stream, render: () => viewer.render(80).join("\n") };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ConversationViewer streaming", () => {
  it("control: streamed blocks stay visible while deltas arrive", () => {
    const { stream, render } = setup();
    stream.start();
    render(); // a render lands on the empty partial before content arrives
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    expect(render()).toContain(THINKING);

    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    const text = render();
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
  });

  it("keeps completed thinking visible when the text block starts", () => {
    const { stream, render } = setup();
    stream.start();
    // First render (debounce) lands before content arrives — cache warms empty.
    render();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    expect(render()).toContain(THINKING); // visible while streaming

    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    const text = render();
    expect(text).toContain(TEXT);

    // The completed thinking lives in session.messages — it must stay visible.
    expect(text).toContain(THINKING);
    expect(count(text, THINKING)).toBe(1); // transcript copy, not duplicated
  });

  it("keeps completed text visible at text_end immediately, straight from the transcript", () => {
    const { stream, render } = setup();
    stream.start();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    render(); // TUI renders during streaming
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    expect(render()).toContain(TEXT); // visible while streaming

    stream.event("text_end", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    const text = render(); // TUI renders on the clear

    // The completed text lives in session.messages — it must remain visible
    // with no tool result or turn progression required.
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
    expect(count(text, TEXT)).toBe(1); // exactly the transcript copy
  });

  it("message_end for the streamed message leaves its completed text visible", () => {
    const { stream, render } = setup();
    // The TUI renders continuously — one render per event batch, so the
    // per-index cache warms mid-stream exactly as in production.
    stream.start();
    render(); // lands on the empty partial
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    render();
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }), TEXT);
    render();
    stream.event("text_end", msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    render();

    // done: pi swaps the final message object into the last slot and emits
    // the session-level message_end — the swap must not hide the content.
    stream.end(msgWith({ type: "thinking", thinking: THINKING }, { type: "text", text: TEXT }));
    const text = render();
    expect(text).toContain(TEXT);
    expect(text).toContain(THINKING);
  });

  it("keeps completed text visible through the next message and its tool result", () => {
    const { stream, render } = setup();
    const doneBlocks: Block[] = [
      { type: "thinking", thinking: THINKING },
      { type: "text", text: TEXT },
    ];
    const callBlocks: Block[] = [...doneBlocks, { type: "toolCall", id: "t1", name: "bash", arguments: {} }];
    stream.start();
    stream.event("thinking_start", msgWith());
    stream.event("thinking_delta", msgWith({ type: "thinking", thinking: THINKING }), THINKING);
    stream.event("thinking_end", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_start", msgWith({ type: "thinking", thinking: THINKING }));
    stream.event("text_delta", msgWith(...doneBlocks), TEXT);
    stream.event("text_end", msgWith(...doneBlocks));
    // Tool call streams after the text block completes; done finalizes.
    stream.event("toolcall_start", msgWith(...callBlocks));
    stream.event("toolcall_end", msgWith(...callBlocks));
    stream.end(msgWith(...callBlocks));
    const atCompletion = render();
    // Inverted from the bug state: the completed text is on screen at
    // completion, not lost until the tool result lands.
    expect(atCompletion).toContain(TEXT);

    // Next LLM call starts (run progresses) — previous stream stays visible.
    stream.start();
    render(); // a render lands on the new empty partial
    stream.event("text_start", msgWith());
    stream.event("text_delta", msgWith({ type: "text", text: "PART-TWO-TEXT" }), "PART-TWO-TEXT");
    render(); // visible while the second stream is in flight
    stream.event("text_end", msgWith({ type: "text", text: "PART-TWO-TEXT" }));
    const duringTurn = render();
    expect(duringTurn).toContain("PART-TWO-TEXT"); // new stream visible
    expect(duringTurn).toContain(TEXT); // previous message's text still visible
    expect(count(duringTurn, TEXT)).toBe(1); // shown once — no duplication

    // Tool result for the FIRST message's call arrives → its cache entry is
    // invalidated → the message re-renders from the transcript with the
    // result inline. On-screen content of the earlier message must not change.
    stream.messages.push({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "RESULT-ONE" }],
    });
    const recovered = render();
    expect(recovered).toContain(TEXT);
    expect(recovered).toContain(THINKING);
    expect(recovered).toContain("PART-TWO-TEXT");
    expect(count(recovered, TEXT)).toBe(count(atCompletion, TEXT)); // no retroactive change
    expect(count(recovered, "RESULT-ONE")).toBe(1); // inline under the call, no standalone dup
  });
});

/** Occurrences of `needle` in `haystack` — pins "shown once" without layout assumptions. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
