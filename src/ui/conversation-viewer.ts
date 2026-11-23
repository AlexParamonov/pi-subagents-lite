/**
 * conversation-viewer.ts — Live scrollable overlay over a transcript source.
 *
 * The source supplies the entries to show and reports when they change; a session supplies its own
 * events for streaming, tool timing and context usage, a source without one reports a bare change.
 * Adapted for pi-subagents-lite type shapes.
 */

import { getHideThinkingBlock } from "../pi-settings.ts";

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  Markdown,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.ts";
import { getSessionContextPercent, type SessionLike } from "../agents/usage.ts";
import { extractText } from "../prompt/context.ts";
import type { Theme } from "./types.ts";
import { makeMarkdownTheme } from "./markdown-theme.ts";
import {
  buildInvocationTags,
  buildStatsParts,
  fgPreservingNestedStyles,
  formatToolDuration,
  getDisplayName,
  recordDisplayName,
  resolveAgentModelLabel,
  statusIcon,
} from "./format.ts";
import { plainText } from "./sanitize.ts";
import { formatCallLine, nestedCallLine } from "./pi-call-line.ts";
import { overlayViewportRows } from "./overlay.ts";
import { createViewerKeys, keyLabel, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.ts";

/** Fixed chrome lines: top border + 2 header rows + 2 separators + footer + bottom border. */
const CHROME_LINES_BASE = 7;
/** Debounce interval for streaming renders — reduces CPU during fast token arrival. */
const STREAM_RENDER_DEBOUNCE_MS = 100;
/** Redraw interval for the "Elapsed" readout of running tool calls. */
const TOOL_TIMER_TICK_MS = 1000;

/** Result lines shown under a collapsed tool call (the viewer is only ~3/5 of the terminal tall). */
const COLLAPSED_RESULT_LINES = 3;

/**
 * What a tool result contributes to rendering: whether the call errored (the
 * call line's status color), how long it took, and its text (shown as plain
 * text under the call: a short preview collapsed, everything expanded).
 */
interface ToolResultStatus {
  isError: boolean;
  details?: unknown;
  /**
   * Read straight off the toolResult message: only hosts >= pi 1.1 stamp it, so
   * on older hosts timing comes solely from the events the viewer itself saw.
   */
  durationMs?: number;
  content?: unknown;
}

/**
 * Plain text of a tool result's content, safe to render. Tool output is untrusted
 * bytes (a `curl` body, a binary `grep`), so it goes through {@link plainText}.
 */
function resultText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? extractText(content) : "";
  return plainText(text);
}

/** A user message's text: pi stores it as a plain string or as content blocks. */
function userText(msg: any): string {
  return typeof msg.content === "string" ? msg.content : extractText(msg.content);
}

/** Optional wiring for tool-call display: timing seeds and the global collapsed/expanded flag. */
export interface ToolDisplayOptions {
  /**
   * Start time of an executing tool call, for calls already running when the
   * viewer opened (their `tool_execution_start` was never seen). Omitted -> no timing for those.
   */
  getToolStartedAt?: (toolCallId: string) => number | undefined;
  /** pi's global tool-output flag (`ctx.ui.getToolsExpanded`). Omitted -> always collapsed. */
  isExpanded?: () => boolean;
  /** Flip the global flag (`ctx.ui.setToolsExpanded(!…)`), so pi refreshes its own rows. Omitted -> key ignored. */
  toggleExpanded?: () => void;
}

/** Optional wiring of the viewer to the agent it shows and to pi's keybindings. */
export interface ConversationViewerOptions {
  /** Abort the agent shown here. Omitted -> no stop affordance (e.g. read-only history). */
  onStop?: () => void;
  /** User keybindings from `ctx.ui.custom()`. Omitted -> hardcoded defaults. */
  keybindings?: ViewerKeybindings;
  /** Send a steering message to the agent. Omitted -> no compose affordance. */
  onSteer?: (message: string) => void;
  /** Tool timing seeds and pi's global collapsed/expanded flag. */
  toolDisplay?: ToolDisplayOptions;
  /** Summarize runs of adjacent eligible calls, show no tool result body and omit hidden thinking. Omitted means on, as the preference does. */
  compactToolCalls?: boolean;
  /** Tool names that keep their normal call block, minus the result body, and split a run. Matched exactly, case-sensitively. Omitted means no exclusions: the caller passes the stored list. */
  ungroupedTools?: readonly string[];
}

/** One entry that is not a conversation message: a row its source already painted, shown as it stands. */
export interface TranscriptRow {
  role: "row";
  text: string;
}

/** What the viewer shows: a conversation message, or one row a source contributes itself. */
export type TranscriptEntry = AgentSession["messages"][number] | TranscriptRow;

/**
 * Everything the viewer reads from what it shows. An `AgentSession` satisfies it; so does a source
 * with no session behind it, which reports a change with no event - the entries it holds now are its
 * whole content, and it has no model whose context window could be reported.
 */
export interface TranscriptSource extends Partial<SessionLike> {
  messages?: TranscriptEntry[];
  subscribe(listener: (event?: AgentSessionEvent) => void): () => void;
}

/** A settled tool call's rows: lines [start, end) of a message or of the content. */
interface ToolBlock {
  id: string;
  start: number;
  end: number;
}

/** Background a call row is painted on while it runs and once its result lands. */
type ToolBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/** A tool call as the viewer paints it: the id links its result and clicks, name and args fill the row. */
interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

type CodemodeCallStatus = "running" | "ok" | "error" | "cancelled";

interface CodemodeCall {
  name: string;
  args: string;
  status: CodemodeCallStatus;
  durationMs?: number;
  error?: string;
}

function codemodeCallsFrom(details: unknown): CodemodeCall[] {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const calls = (details as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return [];

  return calls.flatMap((value): CodemodeCall[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const call = value as Record<string, unknown>;
    const status = call.status;
    if (
      typeof call.name !== "string" ||
      (status !== "running" && status !== "ok" && status !== "error" && status !== "cancelled")
    ) {
      return [];
    }
    return [
      {
        name: plainText(call.name).replace(/\s+/g, " "),
        args: typeof call.args === "string" ? plainText(call.args).replace(/\s+/g, " ") : "",
        status,
        ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0
          ? { durationMs: call.durationMs }
          : {}),
        ...(typeof call.error === "string" && call.error ? { error: plainText(call.error) } : {}),
      },
    ];
  });
}

function codemodeStatusIcon(status: CodemodeCallStatus, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "…");
    case "ok":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("muted", "⊘");
  }
}

function codemodeDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One position of the compact layout: non-call rows, a normal or compact call, or a collapsed run.
 * A normal call carries the whole block its message was cached with, wherever the cache holds one.
 */
type CompactEntry =
  | { kind: "rows"; rows: string[] }
  | { kind: "normal-call" | "compact-call"; call: ToolCall; cachedBlock?: string[] }
  | { kind: "run"; calls: ToolCall[] };

/**
 * One message's cached paint: `rows` is everything it paints outside its calls, `blocks` the click
 * targets inside them, `calls` - compact mode only - the whole block of every call that layout keeps
 * whole, aligned with `callsOfMessage` and undefined where the layout paints the call itself. That
 * layout is planned from the transcript on every rebuild, and a kept call's block is the part of it
 * no grouping can change.
 */
interface CachedMessage {
  rows: string[];
  blocks: ToolBlock[];
  calls: (string[] | undefined)[];
}

/** The message's tool calls, in the order the viewer paints them. */
function callsOfMessage(msg: any): ToolCall[] {
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const calls: ToolCall[] = [];
  for (const c of msg.content) {
    if (c?.type === "toolCall") calls.push({ id: c.id, name: c.name, args: c.arguments });
  }
  return calls;
}

/** The status background of one call. */
function callBg(result: ToolResultStatus | undefined): ToolBg {
  return result ? (result.isError ? "toolErrorBg" : "toolSuccessBg") : "toolPendingBg";
}

export class ConversationViewer implements Component {
  private modelDisplayStyle: "id" | "name" = "id";
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Cached paint per message index - avoids re-rendering unchanged messages and their call blocks. */
  private messageCache = new Map<number, CachedMessage>();
  /** Message count and width of the last cache population. Mismatch → stale. */
  private cacheMeta: { count: number; width: number; messagesRef: any[] | undefined } = {
    count: 0,
    width: 0,
    messagesRef: undefined,
  };
  /** Full content lines from the last build — avoids re-iterating cached messages. */
  private cachedContentLines: string[] | undefined;
  private cachedNonStreamingCount = 0;

  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer -- present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Accumulated thinking text from streaming deltas, cleared on thinking_end. */
  private streamingThinking = "";
  /** Accumulated response text from streaming deltas, cleared on text_end. */
  private streamingText = "";
  /** Persistent Markdown instance for streaming thinking — lazily initialized. */
  private streamingThinkingMd: Markdown | undefined;
  /** Persistent Markdown instance for streaming text — lazily initialized. */
  private streamingTextMd: Markdown | undefined;
  /** Debounce timer for streaming renders — avoids fighting the TUI's 16ms loop. */
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  /** Start time of tool calls executing right now, by toolCallId. Fed by `tool_execution_start`. */
  private toolStartedAt = new Map<string, number>();
  /** Duration of tool calls that ended before their toolResult message landed, by toolCallId. */
  private toolFinishedMs = new Map<string, number>();
  /** Validated nested calls from a running codemode call, until its result enters the transcript. */
  private toolPartialCalls = new Map<string, CodemodeCall[]>();
  /** Redraws the "Elapsed" readout once a second while a tool call is running. */
  private toolTimer: ReturnType<typeof setInterval> | undefined;

  /** Collapsed/expanded state the cached lines were rendered for; re-read from pi on every render. */
  private toolsExpanded = false;
  /** Per-call state set by clicking a call; wins over the global flag until that flag flips (as in pi). */
  private expandedByCall = new Map<string, boolean>();
  /** Clickable (settled) tool blocks in `cachedContentLines` coordinates. */
  private toolBlocks: ToolBlock[] = [];
  /**
   * Content area of the last rendered frame: the viewer row the content starts
   * at, the first content line shown, and the number of rows. Mouse rows are
   * relative to this component, so this is what maps a click to a `toolBlocks`
   * line. Undefined until something has been rendered.
   */
  private clickOrigin: { topRow: number; firstLine: number; rows: number } | undefined;
  /** Thinking visibility: starts with pi's setting, toggled locally with ctrl+T. */
  private thinkingVisible: boolean;
  /** Compact presentation, fixed at open: summarized call runs, no result bodies and no hidden thinking. */
  private readonly compactToolCalls: boolean;
  /** Tool names the compact layout keeps whole; each one also splits a run. */
  private readonly ungroupedTools: ReadonlySet<string>;
  private readonly onStop?: () => void;
  private readonly onSteer?: (message: string) => void;
  private readonly toolDisplay: ToolDisplayOptions;

  constructor(
    private tui: TUI,
    private source: TranscriptSource,
    private record: AgentRecord,
    private theme: Theme,
    private done: (result: undefined) => void,
    options: ConversationViewerOptions = {},
  ) {
    this.onStop = options.onStop;
    this.onSteer = options.onSteer;
    this.toolDisplay = options.toolDisplay ?? {};
    this.thinkingVisible = !getHideThinkingBlock();
    this.compactToolCalls = options.compactToolCalls !== false;
    this.ungroupedTools = new Set(options.ungroupedTools ?? []);
    this.keys = createViewerKeys(options.keybindings);
    this.toolsExpanded = this.toolDisplay.isExpanded?.() ?? false;
    this.seedRunningToolCalls();
    this.unsubscribe = source.subscribe((event) => {
      try {
        this.handleSourceEvent(event);
      } catch {
        // Swallow — a throw here would crash the host menu; events can arrive after closure, before dispose.
      }
    });
  }

  /** Apply what the source reports to what is on screen. A session's event names the part of the
   * transcript that moved; a source with no session reports only that its entries changed. */
  private handleSourceEvent(event: AgentSessionEvent | undefined): void {
    if (this.closed) return;
    if (event === undefined) {
      // A source with no session says only that its entries changed: what it holds now replaces
      // what it held, so nothing cached may survive the next frame.
      this.invalidate();
      this.scheduleRender();
      return;
    }
    if (event.type === "message_update") {
      const me = event.assistantMessageEvent;
      const prevThinking = this.streamingThinking;
      const prevText = this.streamingText;
      switch (me?.type) {
        case "thinking_start":
        case "thinking_end":
          this.streamingThinking = "";
          this.streamingThinkingMd?.setText("");
          this.refreshStreamingMessage();
          break;
        case "thinking_delta":
          this.streamingThinking += me.delta;
          this.ensureThinkingMd().setText(this.streamingThinking);
          break;
        case "text_start":
        case "text_end":
          this.streamingText = "";
          this.streamingTextMd?.setText("");
          this.refreshStreamingMessage();
          break;
        case "text_delta":
          this.streamingText += me.delta;
          this.ensureTextMd().setText(this.streamingText);
          break;
      }
      if (this.streamingThinking !== prevThinking || this.streamingText !== prevText) {
        this.scheduleRender();
      }
    } else if (event.type === "tool_execution_start") {
      this.toolStartedAt.set(event.toolCallId, Date.now());
      if (event.toolName === "codemode") this.toolPartialCalls.delete(event.toolCallId);
      this.refreshToolCalls([event.toolCallId]);
    } else if (event.type === "tool_execution_update") {
      if (event.toolName === "codemode") {
        this.toolPartialCalls.set(event.toolCallId, codemodeCallsFrom(event.partialResult?.details));
        this.refreshToolCalls([event.toolCallId]);
      }
    } else if (event.type === "tool_execution_end") {
      const startedAt = this.toolStartedAt.get(event.toolCallId);
      this.toolStartedAt.delete(event.toolCallId);
      // pi >= 1.4 reports the monotonic duration on the event; older typings lack the field.
      const reportedMs = (event as { durationMs?: number }).durationMs;
      const durationMs = reportedMs ?? (startedAt === undefined ? undefined : Date.now() - startedAt);
      if (durationMs !== undefined) this.toolFinishedMs.set(event.toolCallId, durationMs);
      this.refreshToolCalls([event.toolCallId]);
    } else if (event.type === "message_end") {
      if (event.message.role === "toolResult") this.toolPartialCalls.delete(event.message.toolCallId);
      // Session-level end-of-message (pi swaps the final message object
      // into the last slot at "done") — same refresh as the boundaries.
      this.refreshStreamingMessage();
    }
  }
  private ensureThinkingMd(): Markdown {
    if (!this.streamingThinkingMd) {
      this.streamingThinkingMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme), {
        color: (text: string) => this.theme.fg("thinkingText", text),
        italic: true,
      });
    }
    return this.streamingThinkingMd;
  }

  private ensureTextMd(): Markdown {
    if (!this.streamingTextMd) {
      this.streamingTextMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme));
    }
    return this.streamingTextMd;
  }

  /**
   * Re-render the call lines of the given tool calls.
   *
   * The per-index message cache would otherwise freeze a call line at whatever
   * "Elapsed" it first showed. Calls without a recorded start (the viewer
   * opened mid-call) show no timing until their result lands.
   */
  private refreshToolCalls(toolCallIds: Iterable<string>): void {
    const ids = new Set(toolCallIds);
    const messages = this.source.messages ?? [];
    messages.forEach((msg: any, index: number) => {
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
      if (msg.content.some((c: any) => c?.type === "toolCall" && ids.has(c.id))) {
        this.messageCache.delete(index);
      }
    });
    this.cachedContentLines = undefined;
    this.syncToolTimer();
    this.scheduleRender();
  }

  /** Keep the 1s "Elapsed" redraw running exactly while some call is executing. */
  private syncToolTimer(): void {
    if (this.toolStartedAt.size === 0) {
      this.stopToolTimer();
      return;
    }
    if (this.toolTimer !== undefined) return;
    this.toolTimer = setInterval(() => {
      if (this.closed || this.toolStartedAt.size === 0) {
        this.stopToolTimer();
        return;
      }
      this.refreshToolCalls(this.toolStartedAt.keys());
    }, TOOL_TIMER_TICK_MS);
  }

  /** Pick up tool calls that are executing as the viewer opens: calls with no result yet that the owner knows the start of. */
  private seedRunningToolCalls(): void {
    const getToolStartedAt = this.toolDisplay.getToolStartedAt;
    if (!getToolStartedAt) return;
    const messages: any[] = this.source.messages ?? [];
    const settled = new Set<string>();
    for (const msg of messages) {
      if (msg?.role === "toolResult" && msg.toolCallId) settled.add(msg.toolCallId);
    }
    for (const msg of messages) {
      if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const c of msg.content) {
        if (c?.type !== "toolCall" || !c.id || settled.has(c.id)) continue;
        const startedAt = getToolStartedAt(c.id);
        if (startedAt !== undefined) this.toolStartedAt.set(c.id, startedAt);
      }
    }
    if (this.toolStartedAt.size > 0) this.refreshToolCalls(this.toolStartedAt.keys());
  }

  private stopToolTimer(): void {
    if (this.toolTimer !== undefined) {
      clearInterval(this.toolTimer);
      this.toolTimer = undefined;
    }
  }

  /** Re-read pi's global flag; a flip (ours or anyone's) re-renders every call, since each caches its own lines. */
  private syncToolsExpanded(): void {
    const expanded = this.toolDisplay.isExpanded?.() ?? false;
    if (expanded === this.toolsExpanded) return;
    this.toolsExpanded = expanded;
    this.expandedByCall.clear();
    this.messageCache.clear();
    this.cachedContentLines = undefined;
  }

  /** "Took 4.2s" for a settled call, "Elapsed 4.2s" for a running one, undefined when unknown. */
  private toolTimingText(id: string | undefined, result: ToolResultStatus | undefined): string | undefined {
    if (!id) return undefined;
    const durationMs = result?.durationMs ?? this.toolFinishedMs.get(id);
    if (durationMs !== undefined) {
      const formatted = formatToolDuration(durationMs);
      return formatted === undefined ? undefined : `Took ${formatted}`;
    }
    if (result) return undefined; // settled without a recorded duration
    const startedAt = this.toolStartedAt.get(id);
    if (startedAt === undefined) return undefined;
    const formatted = formatToolDuration(Date.now() - startedAt);
    return formatted === undefined ? undefined : `Elapsed ${formatted}`;
  }

  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return; // already scheduled
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, STREAM_RENDER_DEBOUNCE_MS);
  }

  /**
   * Re-render the in-flight (last) message's cache entry from the session
   * transcript.
   *
   * pi's agent loop replaces the last messages-array slot on every streaming
   * delta, keeping the array reference and length constant — so the per-index
   * cache (keyed on reference + count + width) never goes stale on its own
   * while a message streams, and its entry stays frozen at whatever was on
   * screen when it was first rendered. Meanwhile the streaming accumulators
   * are cleared exactly at the block boundaries, so a completed block would
   * vanish: no longer in an accumulator, and absent from the frozen cache
   * entry that predates it.
   *
   * Called exactly on the events that clear an accumulator (`thinking_start`,
   * `thinking_end`, `text_start`, `text_end`) plus the session's
   * `message_end`. The rebuild happens synchronously, at the boundary itself:
   * at that moment the finished block exists only in the transcript (the
   * accumulator that duplicated it was just cleared, and for a `*_start` the
   * new block has no content yet), so the rebuild can never duplicate the
   * live suffix — deferring the rebuild to the debounced render could land
   * after the next block's deltas arrived, and the cumulative partial would
   * render its block twice. `toolcall_*` events mutate the partial without
   * clearing an accumulator and are deliberately not refreshed here; the call
   * line lands with the next boundary, and `message_end` always follows the
   * last `toolcall_end`, so args are complete before the tool even runs.
   */
  private refreshStreamingMessage(): void {
    const messages = this.source.messages;
    if (!messages || messages.length === 0) return;
    const index = messages.length - 1;
    // Force the next render through the slow path so the streaming suffix is
    // re-spliced behind the refreshed entry.
    this.cachedContentLines = undefined;
    const msg = messages[index];
    if (this.lastInnerW > 0 && msg?.role === "assistant") {
      // No toolResults: the in-flight message's calls have no results yet
      // (they arrive as later messages) — render the calls as pending.
      this.cacheMessage(index, msg, this.lastInnerW, new Map());
    } else {
      // Nothing to rebuild against (no render yet, or a non-assistant end
      // event) — drop the entry and let the next full build handle it.
      this.messageCache.delete(index);
    }
    this.scheduleRender();
  }

  /**
   * Render a message once and cache what paints it: its own rows, the click targets inside them and,
   * in compact mode, the whole block of each call that layout keeps whole. Such a block changes only
   * when its result, timing, width or expansion changes - and each of those already drops this entry -
   * so a compact rebuild can paint it without rendering anything. An eligible call has no block here:
   * the layout summarizes it or paints its own row.
   */
  private cacheMessage(
    index: number,
    msg: any,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
  ): CachedMessage {
    const blocks: ToolBlock[] = [];
    const rows = this.renderMessage(msg, width, toolResults, blocks);
    const calls = this.compactToolCalls
      ? callsOfMessage(msg).map((call) =>
          this.ungroupedTools.has(call.name) ? this.renderToolCall(call, width, toolResults) : undefined,
        )
      : [];
    const cached: CachedMessage = { rows, blocks, calls };
    this.messageCache.set(index, cached);
    return cached;
  }

  /** Render one message's lines, recording the tool blocks it paints; shared by the rebuild paths. */
  private renderMessage(
    msg: any,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    blocks: ToolBlock[],
  ): string[] {
    switch (msg.role) {
      case "user":
        return this.renderUserMessage(msg, width);
      case "row":
        return wrapTextWithAnsi(msg.text, width);
      case "assistant":
        return this.renderAssistantMessage(msg, width, toolResults, blocks);
      case "toolResult":
        // A standalone result message paints nothing: its text reaches the frame inside its call's
        // block, and compact mode paints no such block content at all.
        return [];
      default:
        return [];
    }
  }

  handleInput(data: string): void {
    if (this.closed) return; // already closing, ignore stray keys
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels -- both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) -- then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "s" arms, second confirms -- any other key disarms.
    if (matchesKey(data, "s")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    // pi's tool-output toggle (ctrl+o by default). The viewer has focus, so pi's
    // own handler never sees the key; flip pi's global flag through its API so
    // the chat behind the overlay updates too. render() picks up the new state.
    if (this.keys.toggleExpand(data)) {
      this.toolDisplay.toggleExpanded?.();
      this.tui.requestRender();
      return;
    }

    if (data === "\x14") {
      this.thinkingVisible = !this.thinkingVisible;
      this.invalidate(); // Clear cache so messages re-render with new visibility
      this.tui.requestRender();
      return;
    }

    const viewportHeight = this.viewportHeight();
    const maxScroll = this.scrollMax();

    if (this.keys.scrollUp(data)) {
      this.scrollBy(-1);
    } else if (this.keys.scrollDown(data)) {
      this.scrollBy(1);
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home") || data === "g") {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end") || data === "G") {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  /**
   * Mouse wheel scrolls the conversation. Without this handler pi's
   * alternate-screen renderer treats the event as unhandled and scrolls the
   * chat behind the overlay instead.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    if (event.type === "click" && event.button === "left") return this.toggleCallAt(event.y);
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true };
  }

  /** Clicking a settled tool call expands/collapses just that call, like clicking a tool row in pi. */
  private toggleCallAt(row: number): TuiMouseEventResult | undefined {
    const origin = this.clickOrigin;
    if (!origin) return undefined;
    const contentRow = row - origin.topRow;
    if (contentRow < 0 || contentRow >= origin.rows) return undefined;
    const line = origin.firstLine + contentRow;
    const block = this.toolBlocks.find((b) => line >= b.start && line < b.end);
    if (!block) return undefined;

    this.expandedByCall.set(block.id, !this.isCallExpanded(block.id));
    this.messageCache.clear();
    this.cachedContentLines = undefined;
    return { handled: true };
  }

  /** Scroll by `delta` lines (negative = up), clamped; re-engages auto-scroll when at the bottom. */
  private scrollBy(delta: number): void {
    const maxScroll = this.scrollMax();
    this.scrollOffset = Math.min(maxScroll, Math.max(0, this.scrollOffset + delta));
    this.autoScroll = this.scrollOffset >= maxScroll;
  }

  render(width: number): string[] {
    if (this.closed) return []; // closing — framework may still call render after done()
    if (width < 6) {
      // Too narrow for any meaningful rendering, so there is no frame to hit-test against.
      this.clickOrigin = undefined;
      return [];
    }
    this.syncToolsExpanded();
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const row = (content: string) => {
      const padded = content + " ".repeat(Math.max(0, innerW - visibleWidth(content)));
      return th.fg("border", "│") + " " + truncateToWidth(padded, innerW, "...", true) + " " + th.fg("border", "│");
    };
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = recordDisplayName(this.record, getDisplayName(this.record.display.type));

    const icon = statusIcon(this.record.lifecycle.status, th, this.record.display.type || undefined);
    // Build stats line like the widget
    const durationMs = (this.record.lifecycle.completedAt ?? Date.now()) - this.record.lifecycle.startedAt;
    const statsParts = buildStatsParts(
      {
        toolUses: this.record.stats.toolUses,
        turnCount: this.record.stats.turnCount,
        maxTurns: this.record.stats.maxTurns,
        input: this.record.stats.lifetimeUsage.input,
        output: this.record.stats.lifetimeUsage.output,
        contextPercent: getSessionContextPercent(this.source),
        compactions: this.record.stats.compactionCount,
        cost: this.record.stats.lifetimeUsage.cost,
        durationMs,
      },
      th,
    );

    const worktreeTag = this.record.display.worktreeLabel
      ? th.fg("muted", ` @${this.record.display.worktreeLabel}`)
      : "";
    // Row 1: status icon, name, description, worktree
    lines.push(row(`${icon} ${th.bold(name)}  ${th.fg("muted", this.record.display.description)}${worktreeTag}`));

    // Row 2: model name + compact usage stats
    const resolvedInvocation = {
      ...this.record.display.invocation,
      thinkingLevel: this.record.execution.session?.thinkingLevel ?? this.record.display.invocation?.thinkingLevel,
    };
    const tags = buildInvocationTags(resolvedInvocation);
    const statsLine = fgPreservingNestedStyles(th, "dim", statsParts.join("·"));

    const modelLabel = resolveAgentModelLabel(this.record, this.modelDisplayStyle);
    if (modelLabel) {
      const parts = [statsLine, ...tags].filter(Boolean);
      lines.push(row(th.fg("dim", `  ${modelLabel} · ${parts.join(" · ")}`)));
    } else {
      lines.push(row(statsLine));
    }
    lines.push(hrMid);

    // Content area
    const contentLines = this.buildContentLines(innerW);
    const totalContentLines = contentLines.length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalContentLines - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    // Recorded from what is actually painted, so a click maps to the row under
    // the pointer even when auto-scroll or streaming moved the window.
    this.clickOrigin = { topRow: lines.length, firstLine: visibleStart, rows: viewportHeight };

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    // US-2: the action verb distinguishes steering a running agent from
    // continuing a settled one.
    const steerVerb = this.isActive() ? "steer" : "continue";
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", `✎ ${steerVerb}`);
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", `Enter ${steerVerb}`));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "s again to STOP") : th.fg("dim", "s stop"));
      }
      actions.push(th.fg("dim", "C-t thinking"));
      const expandKey = this.keys.expandHint();
      if (expandKey !== undefined) actions.push(th.fg("dim", `${keyLabel(expandKey)} tools`));
      const footerRight = th.fg("dim", "↑↓ scroll · g/G top/bottom · PgUp/PgDn · Esc/q close");

      // Prepend scroll position readout only when there's spare width
      const currentLine = Math.min(visibleStart + viewportHeight, totalContentLines);
      const scrollPct = totalContentLines <= viewportHeight ? 100 : Math.round((currentLine / totalContentLines) * 100);
      const count = th.fg("dim", `(${currentLine}/${totalContentLines} · ${scrollPct}%)`);
      const withCount = [count, ...actions].join(sep);
      // Widest left side that still fits beside the navigation group, readout first.
      const fits = (left: string) => visibleWidth(left) + 1 + visibleWidth(footerRight) <= innerW;
      const footerLeft = [withCount, count, actions.join(sep)].find(fits) ?? "";

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  private isActive(): boolean {
    return this.record.lifecycle.status === "running" || this.record.lifecycle.status === "queued";
  }

  private isStoppable(): boolean {
    return !!this.onStop && this.isActive();
  }

  private canSteer(): boolean {
    // Offered whenever a session exists — a settled agent can be continued.
    return !!this.onSteer && !!this.record.execution.session;
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      if (message) this.onSteer?.(message);
      this.closeComposer();
    };
    input.onEscape = () => {
      this.closeComposer();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  private closeComposer(): void {
    this.composer = undefined;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.messageCache.clear();
    this.cachedContentLines = undefined;
    this.clickOrigin = undefined; // no frame on screen, so the rows its blocks were mapped to are gone
    this.cacheMeta = { count: 0, width: 0, messagesRef: undefined };
    this.cachedNonStreamingCount = 0;
  }

  dispose(): void {
    this.closed = true;
    this.stopToolTimer();
    this.invalidate();
    if (this.renderTimer !== undefined) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
  setModelDisplayStyle(style: "id" | "name") {
    this.modelDisplayStyle = style;
  }

  private viewportHeight(): number {
    // The share cap matters here: rendering more rows than the overlay shows would clip the footer.
    return overlayViewportRows(this.tui.terminal.rows, this.chromeLines());
  }

  private chromeLines(): number {
    // Composer adds one extra row (input + hint instead of single footer).
    return CHROME_LINES_BASE + (this.composer ? 1 : 0);
  }

  private scrollMax(): number {
    // Derive from a fresh build, not cachedContentLines.length: that cache holds
    // the last slow-path result and goes stale while streaming grows the suffix.
    // buildContentLines takes its fast path when the cache is warm, so this is cheap.
    const totalLines = this.buildContentLines(this.lastInnerW).length;
    return Math.max(0, totalLines - this.viewportHeight());
  }
  /**
   * Drop cached assistant messages whose tool calls just received a result.
   *
   * A tool call line's background derives from whether its result exists
   * (`toolPendingBg` vs `toolSuccessBg`/`toolErrorBg`), and assistant messages
   * are cached per-index. A newly arrived toolResult must therefore invalidate
   * the cached assistant that references it, or the call line would stay stuck
   * in its pending color even though the call has settled.
   */
  private invalidateCacheForNewMessages(newMsgs: any[], oldCount: number, allMessages: any[]): void {
    const newToolCallIds = new Set<string>();
    for (const m of newMsgs) {
      if (m.role === "toolResult" && m.toolCallId) {
        newToolCallIds.add(m.toolCallId);
      }
    }
    if (newToolCallIds.size === 0) return;

    for (let i = 0; i < oldCount; i++) {
      if (!this.messageCache.has(i)) continue;
      const msg = allMessages[i];
      if (msg?.role !== "assistant") continue;
      for (const c of msg.content) {
        if (c.type === "toolCall" && newToolCallIds.has(c.id)) {
          this.messageCache.delete(i);
          break;
        }
      }
    }
  }

  /** Record the messages array reference so array replacement (e.g. compaction) is detected. */
  private updateCacheMeta(messages: any[], width: number): void {
    this.cacheMeta = { count: messages.length, width, messagesRef: messages };
    this.cachedContentLines = undefined;
  }

  private wrapInBg(bg: string, inner: string[], width: number): string[] {
    const fill = this.theme.bg(bg, " ".repeat(width));
    return [fill, ...inner, fill];
  }

  private renderUserMessage(msg: any, width: number): string[] {
    const th = this.theme;
    const text = userText(msg);
    if (!text.trim()) return [];
    const wrapped = wrapTextWithAnsi(text.trim(), width - 2);
    const inner: string[] = [];
    for (const line of wrapped) {
      const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
      inner.push(th.bg("userMessageBg", th.fg("userMessageText", ` ${line}${" ".repeat(padNeeded)} `)));
    }
    return [...this.wrapInBg("userMessageBg", inner, width), ""];
  }

  private renderAssistantMessage(
    msg: any,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    blocks: ToolBlock[],
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "thinking" && c.thinking) thinkingParts.push(c.thinking);
    }
    // Thinking blocks — italic Markdown, matching Pi's assistant-message.ts
    if (thinkingParts.length > 0) {
      if (this.thinkingVisible) {
        const md = new Markdown(thinkingParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th), {
          color: (text: string) => th.fg("thinkingText", text),
          italic: true,
        });
        lines.push(...md.render(width));
        lines.push("");
      } else {
        lines.push(...this.renderHiddenThinkingLabel());
      }
    }
    // Assistant text
    if (textParts.length > 0) {
      const md = new Markdown(textParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th));
      const textLines = md.render(width);
      if (textLines.length > 0) {
        lines.push(...textLines);
        lines.push("");
      }
    }
    // Tool calls. In compact mode the assembly paints them per frame, and cacheMessage keeps the
    // blocks of the calls that layout keeps whole beside these rows rather than inside them.
    if (this.compactToolCalls) return lines;
    for (const tc of callsOfMessage(msg)) {
      this.appendCallBlock(tc, width, toolResults, lines, blocks);
    }
    return lines;
  }

  /**
   * One call's complete normal block: fill bars, result (never in compact mode), its own trailing
   * blank row, click target included. `cached` supplies the block's own rows, so a cached message is
   * not rendered again.
   */
  private appendCallBlock(
    tc: ToolCall,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    lines: string[],
    blocks: ToolBlock[],
    cached?: string[],
  ): void {
    const start = lines.length;
    lines.push(...(cached ?? this.renderToolCall(tc, width, toolResults)));
    // Like pi, only a call with a result can be toggled by clicking it.
    if (tc.id && toolResults.has(tc.id)) blocks.push({ id: tc.id, start, end: lines.length });
    lines.push("");
  }

  private renderToolCall(tc: ToolCall, width: number, toolResults: Map<string, ToolResultStatus>): string[] {
    const th = this.theme;
    const expanded = this.isCallExpanded(tc.id);
    const result = tc.id ? toolResults.get(tc.id) : undefined;
    const bg = callBg(result);
    const timing = this.toolTimingText(tc.id, result);
    // Collapsed: timing sits on the title line. Expanded: at the end, like pi's muted footer line.
    const inner = this.callRows(this.callTitleText(tc, expanded ? undefined : timing), bg, width);
    if (tc.name === "codemode") {
      const calls = result ? codemodeCallsFrom(result.details) : tc.id ? (this.toolPartialCalls.get(tc.id) ?? []) : [];
      if (calls.length > 0) this.appendCodemodeCalls(calls, width, bg, expanded, inner);
    }
    // Compact mode shows no result body for any call, an ungrouped one included.
    if (!this.compactToolCalls) {
      for (const line of this.resultLines(tc.name, result, width - 2, expanded)) {
        const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
        inner.push(th.bg(bg, ` ${th.fg("toolOutput", line)}${" ".repeat(padNeeded)} `));
      }
    }
    if (timing && expanded) {
      for (const line of ["", th.fg("muted", timing)]) {
        inner.push(th.bg(bg, ` ${line}${" ".repeat(Math.max(0, width - 2 - visibleWidth(line)))} `));
      }
    }
    return this.wrapInBg(bg, inner, width);
  }

  private appendCodemodeCalls(
    calls: CodemodeCall[],
    width: number,
    parentBg: ToolBg,
    expanded: boolean,
    lines: string[],
  ): void {
    let run: CodemodeCall[] = [];
    const appendRun = () => {
      if (run.length === 1) this.appendCodemodeCall(run[0]!, width, parentBg, expanded, lines);
      else if (run.length > 1) {
        const state = (
          [
            ["error", "failed"],
            ["cancelled", "cancelled"],
            ["running", "running"],
          ] as const
        )
          .flatMap(([status, label]) => {
            const count = run.filter((call) => call.status === status).length;
            return count === 0 ? [] : [`${count} ${label}`];
          })
          .join(", ");
        lines.push(...this.callRows(this.runSummaryText(run, state), "toolPendingBg", width));
      }
      run = [];
    };

    for (const call of calls) {
      if (this.compactToolCalls && !expanded && !this.ungroupedTools.has(call.name)) {
        run.push(call);
      } else {
        appendRun();
        this.appendCodemodeCall(call, width, parentBg, expanded, lines);
      }
    }
    appendRun();
  }

  private appendCodemodeCall(call: CodemodeCall, width: number, bg: ToolBg, expanded: boolean, lines: string[]): void {
    const duration = codemodeDuration(call.durationMs);
    const detail = nestedCallLine(call.name, call.args, this.theme, expanded);
    // Row padding (2) plus the status icon and its space (2); the duration keeps its own space.
    const room = width - 4 - (duration ? visibleWidth(duration) + 1 : 0);
    const row = `${codemodeStatusIcon(call.status, this.theme)} ${expanded ? detail : truncateToWidth(detail, room)}`;
    lines.push(...this.callRows(duration ? `${row} ${this.theme.fg("dim", duration)}` : row, bg, width));
    // Why a nested call failed belongs to its row, and only the reader who asked for detail sees it.
    if (expanded && call.error) {
      lines.push(...this.callRows(this.theme.fg("error", `  ${call.error}`), bg, width));
    }
  }

  /** The call row's own text: pi's call line, then the timing, padded for the fill bar. */
  private callTitleText(tc: ToolCall, timing: string | undefined): string {
    return ` ${formatCallLine(tc.name, tc.args, this.theme, this.isCallExpanded(tc.id), timing)} `;
  }

  /** Wrap one row of text and paint it full width on a call's status background. */
  private callRows(text: string, bg: ToolBg, width: number): string[] {
    const th = this.theme;
    return wrapTextWithAnsi(text, width - 2).map((line) => {
      const padNeeded = Math.max(0, width - visibleWidth(line));
      return th.bg(bg, th.fg("toolTitle", `${line}${" ".repeat(padNeeded)}`));
    });
  }

  /**
   * Compact layout entries in display order: each message's non-call rows, then
   * its calls. Two or more consecutive eligible calls collapse into one run at
   * the position of their first member; a message that paints rows of its own,
   * and any excluded call, ends the open run. pi's expanded flag shows every
   * call itself, so no run forms at all.
   */
  private compactEntries(messages: any[], width: number, toolResults: Map<string, ToolResultStatus>): CompactEntry[] {
    const entries: CompactEntry[] = [];
    let openRun: { kind: "run"; calls: ToolCall[] } | undefined;
    messages.forEach((msg: any, msgIndex: number) => {
      // In compact mode a cached message's rows hold no call rows, so they are the one answer to
      // "does this message paint visible content?": blank text and blank turns paint nothing, so they
      // do not end the open run. The same entry holds the blocks the layout keeps whole, by position.
      const cached = this.messageCache.get(msgIndex) ?? this.cacheMessage(msgIndex, msg, width, toolResults);
      entries.push({ kind: "rows", rows: cached.rows });
      if (cached.rows.length > 0) openRun = undefined;
      for (const [position, call] of callsOfMessage(msg).entries()) {
        const keepWhole = call.name === "codemode" || this.ungroupedTools.has(call.name);
        if (this.toolsExpanded || keepWhole) {
          entries.push({
            kind: keepWhole ? "normal-call" : "compact-call",
            call,
            cachedBlock: keepWhole ? cached.calls[position] : undefined,
          });
          openRun = undefined;
        } else if (openRun) {
          openRun.calls.push(call);
        } else {
          openRun = { kind: "run", calls: [call] };
          entries.push(openRun);
        }
      }
    });
    // A run of one is not a summary: it shows the call itself.
    return entries.map((entry) =>
      entry.kind === "run" && entry.calls.length === 1 ? { kind: "compact-call", call: entry.calls[0]! } : entry,
    );
  }

  /**
   * Compact content rows and their click targets. Grouping comes straight from the transcript, never
   * from cached rows; a call the layout keeps whole paints the block cached with its own message.
   *
   * Every compact display item ends with the blank row a normal call block already ends with, so the
   * spacing around a summary and between two displayed calls is the viewer's usual one. Visible
   * content and an excluded call's block carry their own spacing and get nothing added around them.
   */
  private appendCompactRows(
    messages: any[],
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    lines: string[],
    toolBlocks: ToolBlock[],
  ): void {
    for (const entry of this.compactEntries(messages, width, toolResults)) {
      if (entry.kind === "rows") {
        lines.push(...entry.rows);
        continue;
      }
      if (entry.kind === "normal-call") {
        // A missing block means the message grew in place since it was cached, so render this one.
        this.appendCallBlock(entry.call, width, toolResults, lines, toolBlocks, entry.cachedBlock);
        continue;
      }
      if (entry.kind === "run") {
        lines.push(...this.callRows(this.runSummaryText(entry.calls), "toolPendingBg", width));
      } else this.appendCompactCall(entry.call, width, toolResults, lines, toolBlocks);
      lines.push("");
    }
  }

  /**
   * A run of calls as one summary row: count and names in first-seen order, no status icon and no
   * timing of its own, since one row cannot carry the colors of the calls it collapsed. `state` names
   * what a reader could not otherwise see - calls that failed, were cancelled or are still running.
   */
  private runSummaryText(calls: readonly { name: string }[], state = ""): string {
    const names = plainText([...new Set(calls.map((call) => call.name))].join(", "));
    return this.theme.bold(` ${calls.length} tools (${names})${state ? ` · ${state}` : ""} `);
  }

  /** One eligible call as one status-colored row: no fill bars, no result, no padding of its own. */
  private appendCompactCall(
    call: ToolCall,
    width: number,
    toolResults: Map<string, ToolResultStatus>,
    lines: string[],
    toolBlocks: ToolBlock[],
  ): void {
    const start = lines.length;
    const result = call.id ? toolResults.get(call.id) : undefined;
    const timing = this.toolTimingText(call.id, result);
    lines.push(...this.callRows(this.callTitleText(call, timing), callBg(result), width));
    // Like pi, only a call with a result can be toggled by clicking it.
    if (call.id && toolResults.has(call.id)) toolBlocks.push({ id: call.id, start, end: lines.length });
  }

  /**
   * A tool result as plain wrapped text (no per-tool renderers): the whole
   * result when expanded, else COLLAPSED_RESULT_LINES plus a hint naming the
   * toggle key. bash keeps the tail (its verdict is at the end), the rest
   * keep the head.
   */
  private resultLines(
    toolName: string,
    result: ToolResultStatus | undefined,
    width: number,
    expanded: boolean,
  ): string[] {
    const text = resultText(result?.content);
    if (!text) return [];
    const all = wrapTextWithAnsi(text, width);
    while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
    if (expanded || all.length <= COLLAPSED_RESULT_LINES) return all;

    const hidden = all.length - COLLAPSED_RESULT_LINES;
    if (toolName === "bash") {
      return [this.expandHintLine(`${hidden} earlier lines`), ...all.slice(-COLLAPSED_RESULT_LINES)];
    }
    return [...all.slice(0, COLLAPSED_RESULT_LINES), this.expandHintLine(`${hidden} more lines`)];
  }

  /** "... (N more lines, ctrl+o to expand)" colored like pi's keyHint. */
  private expandHintLine(what: string): string {
    const th = this.theme;
    const key = this.keys.expandHint();
    return (
      th.fg("muted", `... (${what}${key ? "," : ""}`) +
      (key ? ` ${th.fg("dim", key)}${th.fg("muted", " to expand")}` : "") +
      th.fg("muted", ")")
    );
  }

  /** A clicked call's own state, else pi's global flag. */
  private isCallExpanded(id: string | undefined): boolean {
    return (id !== undefined ? this.expandedByCall.get(id) : undefined) ?? this.toolsExpanded;
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.source.messages ?? [];

    if (messages.length === 0) {
      this.cachedContentLines = undefined;
      this.toolBlocks = []; // no calls on screen, so nothing to hit
      const lines = [th.fg("dim", "(waiting for first message...)")];
      const streamingLines = this.buildStreamingLines(width);
      this.cachedNonStreamingCount = lines.length;
      lines.push(...streamingLines);
      this.cachedContentLines = lines;
      return lines;
    }

    // Invalidate cache on array replacement or width change (both require full rebuild)
    if (messages !== this.cacheMeta.messagesRef || width !== this.cacheMeta.width) {
      this.messageCache.clear();
      this.updateCacheMeta(messages, width);
    } else if (messages.length !== this.cacheMeta.count) {
      // Message count changed — only invalidate entries affected by new messages.
      const newMsgs = messages.slice(this.cacheMeta.count);
      this.invalidateCacheForNewMessages(newMsgs, this.cacheMeta.count, messages);
      this.updateCacheMeta(messages, width);
    }

    // Fast path: if we have cached content and only streaming text changed,
    // splice new streaming lines into the cached result.
    if (this.cachedContentLines) {
      const streamingLines = this.buildStreamingLines(width);
      const result = this.cachedContentLines.slice(0, this.cachedNonStreamingCount);
      result.push(...streamingLines);
      return result;
    }

    // Slow path: full rebuild. Only this path reads result status (for call-line
    // coloring), so the call-id lookup is built here rather than paying a full
    // transcript scan on the streaming fast path above.
    const toolResults = new Map<string, ToolResultStatus>();
    for (const msg of messages) {
      if (msg.role === "toolResult" && msg.toolCallId) {
        toolResults.set(msg.toolCallId, msg);
      }
    }

    const lines: string[] = [];
    const toolBlocks: ToolBlock[] = [];

    if (this.compactToolCalls) {
      this.appendCompactRows(messages, width, toolResults, lines, toolBlocks);
    } else {
      for (let i = 0; i < messages.length; i++) {
        const base = lines.length;
        const cached = this.messageCache.get(i) ?? this.cacheMessage(i, messages[i], width, toolResults);
        lines.push(...cached.rows);
        for (const b of cached.blocks) {
          toolBlocks.push({ id: b.id, start: base + b.start, end: base + b.end });
        }
      }
    }
    this.toolBlocks = toolBlocks;

    const streamingLines = this.buildStreamingLines(width);
    this.cachedNonStreamingCount = lines.length;
    lines.push(...streamingLines);

    // Cache for fast-path streaming splice on next render
    this.cachedContentLines = lines;

    return lines;
  }

  private buildStreamingLines(width: number): string[] {
    const lines: string[] = [];

    // Streaming thinking text — rendered before text, matching assistant message order
    if (this.streamingThinking.trim()) {
      if (this.thinkingVisible) {
        lines.push(...this.ensureThinkingMd().render(width));
      } else {
        lines.push(...this.renderHiddenThinkingLabel());
      }
    }

    if (this.streamingText.trim()) {
      lines.push(...this.ensureTextMd().render(width));
    }

    return lines;
  }

  /**
   * Render the "Thinking..." label shown when thinking blocks are hidden.
   * Matches pi's behavior: italic styling with thinkingText color.
   */
  private renderHiddenThinkingLabel(): string[] {
    // Compact mode drops hidden thinking entirely: no indicator, no spacer row.
    if (this.compactToolCalls) return [];
    const th = this.theme;
    const thinkingText = th.fg("thinkingText", "Thinking...");
    const label = th.italic ? th.italic(thinkingText) : thinkingText;
    return [label, ""];
  }
}
