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
import { getLifetimeTotal, getSessionContextPercent } from "../agents/usage.js";
import { extractText } from "../prompt/context.js";
import type { Theme } from "./types.js";
import { makeMarkdownTheme } from "./markdown-theme.js";
import {
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatDuration,
  formatSessionTokens,
  getDisplayName,
  summarizeToolArgs,
} from "./format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";
import type { LiveView } from "../spawn/spawn-coordinator.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Cap viewport height at this % of terminal rows so the bordered box fits without clipping. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Maximum characters for a single tool result before truncation. */
const TOOL_RESULT_MAX_CHARS = 500;
/** Maximum lines to show from a large tool result. */
const TOOL_RESULT_MAX_LINES = 5;

/** Header status icon and its theme color, per lifecycle status. */
const STATUS_ICON: Record<AgentStatus, { icon: string; color: "accent" | "success" | "warning" | "error" | "dim" }> = {
  running: { icon: "●", color: "accent" },
  completed: { icon: "✓", color: "success" },
  turn_limited: { icon: "✓", color: "warning" },
  error: { icon: "✗", color: "error" },
  aborted: { icon: "✗", color: "error" },
  stopped: { icon: "✗", color: "error" },
  queued: { icon: "○", color: "dim" },
};

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer -- present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Accumulated thinking text from streaming deltas, cleared on thinking_end. */
  private _streamingThinking = "";
  /** Accumulated response text from streaming deltas, cleared on text_end. */
  private _streamingText = "";

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: LiveView | undefined,
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
      if (this.closed) return;
      // Accumulate streaming text for live display
      if (event?.type === "message_update") {
        const me = event.assistantMessageEvent;
        if (me?.type === "thinking_start") {
          this._streamingThinking = "";
        } else if (me?.type === "thinking_delta") {
          this._streamingThinking += me.delta;
        } else if (me?.type === "thinking_end") {
          this._streamingThinking = "";
        } else if (me?.type === "text_start") {
          this._streamingText = "";
        } else if (me?.type === "text_delta") {
          this._streamingText += me.delta;
        } else if (me?.type === "text_end") {
          this._streamingText = "";
        }
      }
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
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

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

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
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else if (data === "g") {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (data === "G") {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.display.type);

    const status = this.record.lifecycle.status;
    const { icon, color } = STATUS_ICON[status];
    const statusIcon = th.fg(color, icon);
    const duration = formatDuration(this.record.lifecycle.startedAt, this.record.lifecycle.completedAt);

    // Build header stats from record.stats (lite doesn't have activity.lifetimeUsage)
    const headerParts: string[] = [duration];
    const toolUses = this.record.stats.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.record.stats.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.session);
      headerParts.push(formatSessionTokens(
        this.record.stats.lifetimeUsage.input,
        this.record.stats.lifetimeUsage.output,
        percent,
        th,
        this.record.stats.compactionCount,
      ));
    }

    const worktreeTag = this.record.display.worktreeLabel ? th.fg("muted", ` @${this.record.display.worktreeLabel}`) : "";

    lines.push(row(
      `${statusIcon} ${th.bold(name)}  ${th.fg("muted", this.record.display.description)}${worktreeTag} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area -- rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

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
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
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

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.lifecycle.status === "running" || this.record.lifecycle.status === "queued");
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.lifecycle.status === "running" || this.record.lifecycle.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight -- otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.display.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
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

    // Second pass: render messages
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        const bgLines = wrapTextWithAnsi(text.trim(), width - 2);
        lines.push(th.bg("userMessageBg", " ".repeat(width)));
        for (const line of bgLines) {
          const padNeeded = Math.max(0, width - 2 - visibleWidth(line));
          lines.push(th.bg("userMessageBg", th.fg("userMessageText", ` ${line}${" ".repeat(padNeeded)} `)));
        }
        lines.push(th.bg("userMessageBg", " ".repeat(width)));
      } else if (msg.role === "assistant") {
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
        // Spacer before assistant content, matching Pi's AssistantMessageComponent
        if (thinkingParts.length > 0 || textParts.length > 0) lines.push("");
        // Thinking blocks — render via Markdown with italic, matching Pi's assistant-message.ts
        if (thinkingParts.length > 0) {
          const md = new Markdown(thinkingParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th), {
            color: (text: string) => th.fg("thinkingText", text),
            italic: true,
          });
          lines.push(...md.render(width));
          // Spacer between thinking and following text, matching Pi's hasVisibleContentAfter
          if (textParts.length > 0) lines.push("");
        }
        // Assistant text — paddingX=1, paddingY=0 to avoid extra spacing before tools
        if (textParts.length > 0) {
          const md = new Markdown(textParts.join("\n\n").trim(), 1, 0, makeMarkdownTheme(th));
          lines.push(...md.render(width));
        }
        // Tool calls — no icons, bold name, matching Pi's ToolExecutionComponent
        for (const tc of toolCalls) {
          // Spacer before each tool, matching Pi's Spacer(1)
          lines.push("");
          const argsSummary = tc.args ? summarizeToolArgs(tc.name, tc.args) : "";
          const label = argsSummary ? `${tc.name}${argsSummary}` : tc.name;
          const result = tc.id ? toolResults.get(tc.id) : undefined;
          const bg = result
            ? (result.isError ? "toolErrorBg" : "toolSuccessBg")
            : "toolPendingBg";

          // Tool call line: bold name with args, wrapping if long
          const toolLine = ` ${th.bold(label)} `;
          const toolLines = wrapTextWithAnsi(toolLine, width - 2);
          lines.push(th.bg(bg, " ".repeat(width)));
          for (const tl of toolLines) {
            const padNeeded = Math.max(0, width - visibleWidth(tl));
            lines.push(th.bg(bg, th.fg("toolTitle", `${tl}${" ".repeat(padNeeded)}`)));
          }

          if (result) {
            renderedToolResults.add(tc.id!);
            const resultText = extractText(result.content);
            if (resultText.trim()) {
              // paddingY top: blank line between call and result, matching Pi's Box(1,1)
              lines.push(th.bg(bg, " ".repeat(width)));
              if (resultText.length > TOOL_RESULT_MAX_CHARS) {
                const resultLines = resultText.split("\n");
                const linesToShow = Math.min(TOOL_RESULT_MAX_LINES, resultLines.length);
                for (let i = 0; i < linesToShow; i++) {
                  const rl = resultLines[i] ?? "";
                  if (!rl.trim() && i >= TOOL_RESULT_MAX_LINES) break;
                  const wrapped = wrapTextWithAnsi(rl || " ", width - 4);
                  for (const wl of wrapped) {
                    const linePad = Math.max(0, width - visibleWidth(`  ${wl} `));
                    lines.push(th.bg(bg, th.fg("toolOutput", `  ${wl}${" ".repeat(linePad)}`)));
                  }
                }
                if (resultLines.length > linesToShow) {
                  const more = th.fg("dim", `  … ${resultLines.length - linesToShow} more lines`);
                  lines.push(th.bg(bg, more + " ".repeat(Math.max(0, width - visibleWidth(more)))));
                }
              } else {
                for (const line of wrapTextWithAnsi(resultText.trim(), width - 4)) {
                  const linePad = Math.max(0, width - visibleWidth(`  ${line} `));
                  lines.push(th.bg(bg, th.fg("toolOutput", `  ${line}${" ".repeat(linePad)}`)));
                }
              }
              // paddingY bottom: blank line after result
              lines.push(th.bg(bg, " ".repeat(width)));
            }
          }
        }
      } else if (msg.role === "toolResult") {
        // Skip if already rendered with its tool call
        if (msg.toolCallId && renderedToolResults.has(msg.toolCallId)) continue;
        // Standalone tool result (orphaned) — Spacer + bold name + result
        lines.push("");
        const text = extractText(msg.content);
        if (!text.trim()) continue;
        const bg = msg.isError ? "toolErrorBg" : "toolSuccessBg";
        const name = msg.toolName ?? "tool";
        const toolLine = ` ${th.bold(name)} `;
        const titlePad = Math.max(0, width - visibleWidth(toolLine));
        lines.push(th.bg(bg, th.fg("toolTitle", `${toolLine}${" ".repeat(titlePad)}`)));
        for (const line of wrapTextWithAnsi(text.trim(), width - 4)) {
          const linePad = Math.max(0, width - visibleWidth(`  ${line} `));
          lines.push(th.bg(bg, th.fg("toolOutput", `  ${line}${" ".repeat(linePad)}`)));
        }
      } else {
        continue;
      }
    }

    // Streaming text — rendered live as deltas arrive
    if (this._streamingText.trim()) {
      const md = new Markdown(this._streamingText.trim(), 1, 0, makeMarkdownTheme(th));
      lines.push(...md.render(width));
    }

    // Streaming thinking text — rendered live as deltas arrive
    if (this._streamingThinking.trim()) {
      const md = new Markdown(this._streamingThinking.trim(), 1, 0, makeMarkdownTheme(th), {
        color: (text: string) => th.fg("thinkingText", text),
        italic: true,
      });
      lines.push(...md.render(width));
    }

    // Streaming indicator for running agents
    if (this.record.lifecycle.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    return lines.map((l) => truncateToWidth(l, width));
  }
}
