/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 * Adapted for pi-subagents-lite type shapes.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentStatus } from "../types.js";
import { getSessionContextPercent } from "../agents/usage.js";
import { extractText } from "../prompt/context.js";
import type { Theme } from "./types.js";
import { makeMarkdownTheme } from "./markdown-theme.js";
import {
  buildInvocationTags,
  buildStatsParts,
  describeActivity,
  fgPreservingNestedStyles,
  getDisplayName,
  resolveAgentModelLabel,
  summarizeToolArgs,
} from "./format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Fixed chrome lines: top border + 2 header rows + 2 separators + footer + bottom border. */
const CHROME_LINES_BASE = 7;
const MIN_VIEWPORT = 3;
/** Cap viewport height at this % of terminal rows so the bordered box fits without clipping. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Maximum characters for a single tool result before truncation. */
const TOOL_RESULT_MAX_CHARS = 500;
/** Maximum lines to show from a large tool result. */
const TOOL_RESULT_MAX_LINES = 5;
/** Debounce interval for streaming renders — reduces CPU during fast token arrival. */
const STREAM_RENDER_DEBOUNCE_MS = 100;

/** Header status icon and its theme color, per lifecycle status. */
const STATUS_ICON: Record<AgentStatus, { icon: string; color: "accent" | "success" | "warning" | "error" | "dim" }> = {
  running: { icon: "◈", color: "accent" },
  completed: { icon: "✓", color: "success" },
  turn_limited: { icon: "✓", color: "warning" },
  error: { icon: "✗", color: "error" },
  aborted: { icon: "✗", color: "error" },
  stopped: { icon: "✗", color: "error" },
  queued: { icon: "◇", color: "dim" },
};

export class ConversationViewer implements Component {
  /** Model display format: 'id' (short) or 'name' (full). */
  private modelDisplayStyle: "id" | "name" = "id";
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Rendered lines per message index — avoids re-rendering unchanged messages. */
  private messageCache = new Map<number, string[]>();
  /** Message count and width of the last cache population. Mismatch → stale. */
  private cacheMeta = { count: 0, width: 0 };
  /** Full content lines from the last build — avoids re-iterating cached messages. */
  private cachedContentLines: string[] | undefined;
  /** Number of non-streaming lines in cachedContentLines. */
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

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted -> no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted -> hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted -> no compose affordance. */
    private onSteer?: (message: string) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
    this.unsubscribe = session.subscribe((event) => {
      try {
        if (this.closed) return;
        // Only request render when streaming text state changes
        if (event?.type === "message_update") {
          const me = event.assistantMessageEvent;
          const prevThinking = this.streamingThinking;
          const prevText = this.streamingText;
          switch (me?.type) {
            case "thinking_start":
            case "thinking_end":
              this.streamingThinking = "";
              this.streamingThinkingMd?.setText("");
              break;
            case "thinking_delta":
              this.streamingThinking += me.delta;
              this.ensureThinkingMd().setText(this.streamingThinking);
              break;
            case "text_start":
            case "text_end":
              this.streamingText = "";
              this.streamingTextMd?.setText("");
              break;
            case "text_delta":
              this.streamingText += me.delta;
              this.ensureTextMd().setText(this.streamingText);
              break;
          }
          // Only render if streaming state actually changed
          if (this.streamingThinking !== prevThinking || this.streamingText !== prevText) {
            this.scheduleRender();
          }
        }
      } catch (err) {
        // Swallow — session events after viewer closure must not crash the menu
      }
    });
  }
  /** Lazily initialize the Markdown instance for streaming thinking text. */
  private ensureThinkingMd(): Markdown {
    if (!this.streamingThinkingMd) {
      this.streamingThinkingMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme), {
        color: (text: string) => this.theme.fg("thinkingText", text),
        italic: true,
      });
    }
    return this.streamingThinkingMd;
  }

  /** Lazily initialize the Markdown instance for streaming response text. */
  private ensureTextMd(): Markdown {
    if (!this.streamingTextMd) {
      this.streamingTextMd = new Markdown("", 1, 0, makeMarkdownTheme(this.theme));
    }
    return this.streamingTextMd;
  }
  /** Schedule a debounced render for streaming updates. */
  private scheduleRender(): void {
    if (this.renderTimer !== undefined) return; // already scheduled
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, STREAM_RENDER_DEBOUNCE_MS);
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

    const viewportHeight = this.viewportHeight();
    const maxScroll = this.scrollMax();

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
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

  render(width: number): string[] {
    if (this.closed) return []; // closing — framework may still call render after done()
    if (width < 6) return []; // too narrow for any meaningful rendering
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
    const name = getDisplayName(this.record.display.type);

    const status = this.record.lifecycle.status;
    const { icon, color } = STATUS_ICON[status];
    const statusIcon = th.fg(color, icon);
    // Build stats line like the widget
    const durationMs = (this.record.lifecycle.completedAt ?? Date.now()) - this.record.lifecycle.startedAt;
    const statsParts = buildStatsParts({
      toolUses: this.record.stats.toolUses,
      turnCount: this.record.stats.turnCount,
      maxTurns: this.record.stats.maxTurns,
      input: this.record.stats.lifetimeUsage.input,
      output: this.record.stats.lifetimeUsage.output,
      contextPercent: getSessionContextPercent(this.session),
      compactions: this.record.stats.compactionCount,
      cost: this.record.stats.lifetimeUsage.cost,
      durationMs,
    }, th);

    const worktreeTag = this.record.display.worktreeLabel ? th.fg("muted", ` @${this.record.display.worktreeLabel}`) : "";
    // Row 1: status icon, name, description, worktree
    lines.push(row(
      `${statusIcon} ${th.bold(name)}  ${th.fg("muted", this.record.display.description)}${worktreeTag}`
    ));

    // Row 2: model name + compact usage stats
    const { tags } = buildInvocationTags(this.record.display.invocation);
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

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "s again to STOP") : th.fg("dim", "s stop"));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · g/G top/bottom · PgUp/PgDn · Esc/q close");

      // Prepend scroll position readout only when there's spare width
      const currentLine = Math.min(visibleStart + viewportHeight, totalContentLines);
      const scrollPct = totalContentLines <= viewportHeight
        ? 100
        : Math.round((currentLine / totalContentLines) * 100);
      const count = th.fg("dim", `(${currentLine}/${totalContentLines} · ${scrollPct}%)`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Agent is still active (running or queued). */
  private isActive(): boolean {
    return this.record.lifecycle.status === "running" || this.record.lifecycle.status === "queued";
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean { return !!this.onStop && this.isActive(); }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean { return !!this.onSteer && this.isActive(); }

  /** Open the inline steering composer and route subsequent input to it. */
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
    this.cacheMeta = { count: 0, width: 0 };
    this.cachedNonStreamingCount = 0;
  }

  dispose(): void {
    this.closed = true;
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
  /** Set model display format: 'id' (short) or 'name' (full). */
  setModelDisplayStyle(style: "id" | "name") {
    this.modelDisplayStyle = style;
  }

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight -- otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // Composer adds one extra row (input + hint instead of single footer).
    return CHROME_LINES_BASE + (this.composer ? 1 : 0);
  }

  /** Maximum scroll offset for the current content and viewport. */
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
   * A tool result is rendered inline under its assistant's tool call, and the
   * standalone toolResult message is suppressed via `renderedToolResults`. That
   * suppression only holds when the assistant is re-rendered in the same pass as
   * the fresh toolResult, repopulating `renderedToolResults`. A newly arrived
   * toolResult must therefore invalidate the cached assistant that references it,
   * or the result would render twice (cached inline + standalone) or the inline
   * copy would stay stuck in its pending state.
   */
  private invalidateCacheForNewMessages(newMsgs: any[], oldCount: number, allMessages: any[]): void {
    // Collect toolCallIds from new tool results
    const newToolCallIds = new Set<string>();
    for (const m of newMsgs) {
      if (m.role === "toolResult" && m.toolCallId) {
        newToolCallIds.add(m.toolCallId);
      }
    }
    if (newToolCallIds.size === 0) return;

    // Invalidate cached assistant messages that reference any of the new toolCallIds
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

  /** Wrap text to the inner width and return each line as a tool-output row with bg padding. */
  private wrapToolOutput(bg: string, text: string, width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    for (const wl of wrapTextWithAnsi(text, width - 4)) {
      const pad = Math.max(0, width - visibleWidth(`  ${wl} `));
      lines.push(th.bg(bg, th.fg("toolOutput", `  ${wl}${" ".repeat(pad)}`)));
    }
    return lines;
  }

  /** Wrap inner lines with bg-filled top and bottom padding. */
  private wrapInBg(bg: string, inner: string[], width: number): string[] {
    const fill = this.theme.bg(bg, " ".repeat(width));
    return [fill, ...inner, fill];
  }

  private renderUserMessage(msg: any, width: number): string[] {
    const th = this.theme;
    const text = typeof msg.content === "string"
      ? msg.content
      : extractText(msg.content);
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
    toolResults: Map<string, { content: unknown[]; isError: boolean; toolName?: string }>,
    renderedToolResults: Set<string>,
  ): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<{ id?: string; name: string; args?: Record<string, unknown> }> = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text) textParts.push(c.text);
      else if (c.type === "thinking" && c.thinking) thinkingParts.push(c.thinking);
      else if (c.type === "toolCall") {
        toolCalls.push({ id: c.id, name: c.name, args: c.arguments });
      }
    }
    // Thinking blocks — italic Markdown, matching Pi's assistant-message.ts
    if (thinkingParts.length > 0) {
      const md = new Markdown(thinkingParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th), {
        color: (text: string) => th.fg("thinkingText", text),
        italic: true,
      });
      lines.push(...md.render(width));
      lines.push("");
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
    // Tool calls
    for (const tc of toolCalls) {
      lines.push(...this.renderToolCall(tc, width, toolResults, renderedToolResults));
      lines.push("");
    }
    return lines;
  }

  private renderToolResult(msg: any, width: number, renderedToolResults: Set<string>): string[] {
    if (msg.toolCallId && renderedToolResults.has(msg.toolCallId)) return [];
    const th = this.theme;
    const text = extractText(msg.content);
    if (!text.trim()) return [];
    const bg = msg.isError ? "toolErrorBg" : "toolSuccessBg";
    const name = msg.toolName ?? "tool";
    const toolLine = ` ${th.bold(name)} `;
    const titlePad = Math.max(0, width - visibleWidth(toolLine));
    const inner = [th.bg(bg, th.fg("toolTitle", `${toolLine}${" ".repeat(titlePad)}`))];
    inner.push(...this.wrapToolOutput(bg, text.trim(), width));
    return [...this.wrapInBg(bg, inner, width), ""];
  }

  private renderToolCall(
    tc: { id?: string; name: string; args?: Record<string, unknown> },
    width: number,
    toolResults: Map<string, { content: unknown[]; isError: boolean; toolName?: string }>,
    renderedToolResults: Set<string>,
  ): string[] {
    const th = this.theme;
    const argsSummary = tc.args ? summarizeToolArgs(tc.name, tc.args) : "";
    const label = argsSummary ? `${tc.name}${argsSummary}` : tc.name;
    const result = tc.id ? toolResults.get(tc.id) : undefined;
    const bg = result
      ? (result.isError ? "toolErrorBg" : "toolSuccessBg")
      : "toolPendingBg";
    const inner: string[] = [];
    const toolLine = ` ${th.bold(label)} `;
    for (const tl of wrapTextWithAnsi(toolLine, width - 2)) {
      const padNeeded = Math.max(0, width - visibleWidth(tl));
      inner.push(th.bg(bg, th.fg("toolTitle", `${tl}${" ".repeat(padNeeded)}`)));
    }
    if (result && tc.id) {
      inner.push(th.bg(bg, " ".repeat(width)));
      renderedToolResults.add(tc.id);
      inner.push(...this.renderToolCallResult(result, bg, width));
    }
    return this.wrapInBg(bg, inner, width);
  }

  /** Render the output of a tool call result, with truncation for large outputs. */
  private renderToolCallResult(
    result: { content: unknown[]; isError: boolean },
    bg: string,
    width: number,
  ): string[] {
    const th = this.theme;
    const resultText = extractText(result.content);
    if (!resultText.trim()) return [];

    if (resultText.length > TOOL_RESULT_MAX_CHARS) {
      const resultLines = resultText.split("\n");
      const linesToShow = Math.min(TOOL_RESULT_MAX_LINES, resultLines.length);
      const lines: string[] = [];
      for (let i = 0; i < linesToShow; i++) {
        lines.push(...this.wrapToolOutput(bg, resultLines[i] || " ", width));
      }
      if (resultLines.length > linesToShow) {
        const more = th.fg("dim", `  … ${resultLines.length - linesToShow} more lines`);
        lines.push(th.bg(bg, more + " ".repeat(Math.max(0, width - visibleWidth(more)))));
      }
      return lines;
    }
    return this.wrapToolOutput(bg, resultText.trim(), width);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages ?? [];

    if (messages.length === 0) {
      this.cachedContentLines = undefined;
      return [th.fg("dim", "(waiting for first message...)")];
    }

    // First pass: collect tool results by toolCallId
    const toolResults = new Map<string, { content: unknown[]; isError: boolean; toolName?: string }>();
    for (const msg of messages) {
      if (msg.role === "toolResult" && msg.toolCallId) {
        toolResults.set(msg.toolCallId, msg);
      }
    }

    // Track which tool results have been rendered
    const renderedToolResults = new Set<string>();

    // Invalidate cache if width changed (Markdown wrapping depends on it)
    if (width !== this.cacheMeta.width) {
      this.messageCache.clear();
      this.cacheMeta = { count: messages.length, width };
      this.cachedContentLines = undefined;
    } else if (messages.length !== this.cacheMeta.count) {
      // Message count changed — only invalidate entries affected by new messages.
      const newMsgs = messages.slice(this.cacheMeta.count);
      this.invalidateCacheForNewMessages(newMsgs, this.cacheMeta.count, messages);
      this.cacheMeta.count = messages.length;
      this.cachedContentLines = undefined; // new messages → full rebuild
    }

    // Fast path: if we have cached content and only streaming text changed,
    // splice new streaming lines into the cached result.
    if (this.cachedContentLines) {
      const streamingLines = this.buildStreamingLines(width);
      const result = this.cachedContentLines.slice(0, this.cachedNonStreamingCount);
      result.push(...streamingLines);
      return result;
    }

    // Slow path: full rebuild
    const lines: string[] = [];

    // Render all messages with per-message caching
    for (let i = 0; i < messages.length; i++) {
      const cached = this.messageCache.get(i);
      if (cached) {
        lines.push(...cached);
      } else {
        let msgLines: string[];
        switch (messages[i].role) {
          case "user": msgLines = this.renderUserMessage(messages[i], width); break;
          case "assistant": msgLines = this.renderAssistantMessage(messages[i], width, toolResults, renderedToolResults); break;
          case "toolResult": msgLines = this.renderToolResult(messages[i], width, renderedToolResults); break;
          default: msgLines = [];
        }
        this.messageCache.set(i, msgLines);
        lines.push(...msgLines);
      }
    }

    const streamingLines = this.buildStreamingLines(width);
    this.cachedNonStreamingCount = lines.length;
    lines.push(...streamingLines);

    // Cache for fast-path streaming splice on next render
    this.cachedContentLines = lines;

    return lines;
  }

  /** Build just the streaming portion (thinking + text + indicator). */
  private buildStreamingLines(width: number): string[] {
    const lines: string[] = [];

    // Streaming thinking text — rendered before text, matching assistant message order
    if (this.streamingThinking.trim()) {
      lines.push(...this.ensureThinkingMd().render(width));
    }

    // Streaming text — rendered live as deltas arrive
    if (this.streamingText.trim()) {
      lines.push(...this.ensureTextMd().render(width));
    }

    return lines;
}
}
