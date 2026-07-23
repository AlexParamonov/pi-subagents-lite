/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 * Adapted for pi-subagents-lite type shapes.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../agents/usage.js";
import { extractText } from "../prompt/context.js";
import type { Theme } from "./types.js";
import {
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatDuration,
  formatSessionTokens,
  getDisplayName,
} from "./format.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";
import type { LiveView } from "../spawn/spawn-coordinator.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
/** Maximum characters for a single tool result before truncation. */
const TOOL_RESULT_MAX_CHARS = 4000;

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
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
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
    const statusIcon = status === "running"
      ? th.fg("accent", "●")
      : status === "completed"
        ? th.fg("success", "✓")
        : status === "turn_limited"
          ? th.fg("warning", "✓")
          : ["error", "aborted", "stopped"].includes(status)
            ? th.fg("error", "✗")
            : th.fg("dim", "○");
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

    lines.push(row(
      `${statusIcon} ${th.bold(name)}  ${th.fg("muted", this.record.display.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
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

    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const toolCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "thinking" && c.thinking) thinkingParts.push(c.thinking);
          else if (c.type === "toolCall") {
            toolCalls.push({ name: c.name, args: c.arguments });
          }
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        // Thinking blocks (dimmed)
        if (thinkingParts.length > 0) {
          for (const line of wrapTextWithAnsi(thinkingParts.join("\n").trim(), width)) {
            lines.push(th.fg("dim", `  ↝ ${line}`));
          }
        }
        if (textParts.length > 0) {
          for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
            lines.push(line);
          }
        }
        // Tool calls with summarized arguments
        for (const tc of toolCalls) {
          const argsSummary = tc.args ? summarizeToolArgsLite(tc.name, tc.args) : "";
          const label = argsSummary ? `  [Tool: ${tc.name}${argsSummary}]` : `  [Tool: ${tc.name}]`;
          lines.push(truncateToWidth(th.fg("muted", label), width));
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        const truncated = text.length > TOOL_RESULT_MAX_CHARS
          ? text.slice(0, TOOL_RESULT_MAX_CHARS) + "... (truncated)"
          : text;
        if (!truncated.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        const icon = msg.isError ? "✗" : "✓";
        const name = msg.toolName ?? "tool";
        lines.push(th.fg(msg.isError ? "error" : "success", `[Result ${icon}] ${name.charAt(0).toUpperCase() + name.slice(1)}`));
        for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
          lines.push(th.fg("dim", line));
        }
      } else {
        continue;
      }
      needsSeparator = true;
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

/** Compact tool arg summary for the live overlay. Bare format (no parens, no JSON) to save space in the bordered viewport. Separate from summarizeToolArgs in format.ts which produces parenthesized, JSON-quoted output for markdown transcripts. */
function summarizeToolArgsLite(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string => typeof v === "string" ? v.slice(0, 80) : String(v ?? "");
  switch (name) {
    case "read": return ` ${s(args.path)}`;
    case "write": return ` ${s(args.file_path)} (${typeof args.content === "string" ? args.content.length : 0} chars)`;
    case "edit": return ` ${s(args.path)} (${Array.isArray(args.edits) ? args.edits.length : 0} edits)`;
    case "bash": return ` ${s(args.command).slice(0, 60)}`;
    case "grep":
    case "rg": return ` ${s(args.pattern)} ${s(args.path)}`;
    default: return "";
  }
}
