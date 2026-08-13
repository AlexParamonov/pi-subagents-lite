/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getSessionCtx } from "../shell.js";
import type { AgentManager } from "../agents/agent-manager.js";
import { formatWatchdogSummary } from "../status-note.js";
import type { AgentRecord, AgentLifecycle } from "../types.js";
import type { Theme } from "./types.js";
import type { ModelThinkingPlacement } from "../config/types.js";
import { formatCost, getSessionContextPercent } from "../agents/usage.js";
import {
  buildStatsParts,
  getDisplayName,
  describeActivity,
  buildModelThinkingTag,
  resolveAgentModelThinking,
  buildMetadataLineParts,
  type StatsVisibility,
} from "./format.js";
import type { LiveView } from "../types.js";

// Backward-compat re-export for consumers importing Theme from this module.
export type { Theme } from "./types.js";

// ---- Constants ----

/** Overflow collapse kicks in above this many rendered lines. */
const DEFAULT_MAX_WIDGET_LINES = 12;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const WIDGET_KEY = "agents";

const STATUS_KEY = "subagents";

const WIDGET_REFRESH_INTERVAL = 80;

/** Navigation freeze window: roster order is deferred while the user is actively navigating. */
const NAV_FREEZE_MS = 2000;

/** Finished-retention is configured in minutes; convert to ms. */
const MINUTE_MS = 60_000;

// ---- Types ----

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Minimal TUI shape used by the widget. */
interface TUI {
  terminal: { columns: number };
  requestRender?(): void;
  hasOverlay?(): boolean;
}
/** A visual block: one header line plus zero or more metadata lines. */
interface RenderBlock {
  header: string;
  metadataLines: string[];
}

// ---- Re-exports from format.ts (backward compatibility) ----
export { formatMs, buildStatsParts, getDisplayName, type StatsVisibility } from "./format.js";
export type { LiveView as AgentActivity } from "../types.js";

// ---- Widget-internal helpers ----

/**
 * Wrap a stats line in dim ANSI codes, re-applying dim after any inner
 * ANSI reset sequences (e.g. from formatSessionTokens annotations).
 */
function wrapInDim(theme: Theme, text: string): string {
  const dimSample = theme.fg("dim", "x");
  const xIdx = dimSample.indexOf("x");
  const dimOn = dimSample.slice(0, xIdx);
  const dimOff = dimSample.slice(xIdx + 1);
  return dimOn + text.replaceAll(dimOff, dimOff + dimOn) + dimOff;
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;

  private showCost = false;

  private statsVisibility: StatsVisibility = {};

  private widgetRegistered = false;
  /** TUI from the widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
  private theme: Theme | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  /** Whether to use compact mode (1-line per agent). */
  private compactMode = false;

  /** Whether "force compact" mode is ON — overrides ctrl+o shortcut. */
  private forceCompact = false;

  /** Whether ctrl+o shortcut is enabled (syncs compact with toolsExpanded). */
  private widgetShortcut = false;

  private maxLines = DEFAULT_MAX_WIDGET_LINES;

  private maxLinesCompact = Math.floor(DEFAULT_MAX_WIDGET_LINES / 2);

  private navHint = true;

  private statusBarFormat: "full" | "compact" = "full";

  /** Retention window in minutes for finished rows. Mirrors the config default; never 0. */
  private finishedRetentionMinutes = 1;

  private modelDisplayStyle: "id" | "name" = "id";

  private modelThinkingPlacement: ModelThinkingPlacement = "header";

  private shouldShowModelThinkingInHeader(): boolean {
    return this.isCompact() || this.modelThinkingPlacement === "header";
  }

  private navActive = false;

  /** Highlighted agent id — the highlight's source of truth. */
  private highlightId: string | null = null;

  /** Current nav roster: ordered agent ids (frozen order mid-freeze, live order when dormant). */
  private navRoster: string[] = [];

  /** Timestamp of the last nav move (↓/↑) or activation; resets the freeze window. */
  private navLastMove = 0;

  /** Last resolved highlight position; seeds the nearest-agent adoption when the highlighted agent is evicted. */
  private lastHighlightIndex = 0;

  /** Scroll anchor: index of the first visible block in the window. */
  private scrollAnchor = 0;

  /** Viewer overlay open — prevents deactivation while ConversationViewer is displayed. */
  private viewerOpen = false;

  constructor(
    private manager: AgentManager,
    private getLiveView: (id: string) => LiveView | undefined,
  ) {}

  setShowCost(enabled: boolean) {
    this.showCost = enabled;
  }

  setStatsVisibility(visible: StatsVisibility) {
    this.statsVisibility = visible;
  }

  /** Internal — sync from ctrl+o. */
  setCompactMode(enabled: boolean) {
    if (this.compactMode === enabled) return;
    this.compactMode = enabled;
    this.update();
  }

  setForceCompact(enabled: boolean) {
    this.forceCompact = enabled;
  }

  setWidgetShortcut(enabled: boolean) {
    this.widgetShortcut = enabled;
  }

  setMaxLines(lines: number) {
    this.maxLines = lines;
  }

  setMaxLinesCompact(lines: number) {
    this.maxLinesCompact = lines;
  }

  setNavHint(enabled: boolean) {
    this.navHint = enabled;
  }

  setStatusBarFormat(format: "full" | "compact") {
    this.statusBarFormat = format;
  }
  /** Retention window (minutes) for finished rows; applied on the next render tick. */
  setFinishedRetentionMinutes(minutes: number) {
    this.finishedRetentionMinutes = minutes;
  }
  setModelDisplayStyle(style: "id" | "name") {
    this.modelDisplayStyle = style;
  }
  setModelThinkingPlacement(placement: ModelThinkingPlacement) {
    this.modelThinkingPlacement = placement;
  }

  // ---- Navigation state machine ----

  /** All visible agents in live display order: finished → running → queued. */
  private liveRoster(): AgentRecord[] {
    const { finished, running, queued } = this.categorizeAgents();
    return [...finished, ...running, ...queued];
  }

  /**
   * Resolve the nav roster from a live snapshot: keep the frozen order during
   * the freeze window (evicted drop, new append at the end), otherwise rebuild
   * in live display order so a long pause stays current.
   */
  private resolveNavRoster(now: number, live: AgentRecord[]): AgentRecord[] {
    const liveById = new Map(live.map((a) => [a.id, a]));

    if (now - this.navLastMove > NAV_FREEZE_MS) {
      // Dormant: live display order IS the roster.
      this.navRoster = live.map((a) => a.id);
      return live;
    }

    // Freeze window: keep the current order, drop evicted ids, append new ids.
    const ordered: AgentRecord[] = [];
    const known = new Set<string>();
    for (const id of this.navRoster) {
      known.add(id);
      const rec = liveById.get(id);
      if (rec) ordered.push(rec);
    }
    for (const rec of live) {
      if (!known.has(rec.id)) ordered.push(rec);
    }
    this.navRoster = ordered.map((a) => a.id);
    return ordered;
  }

  /**
   * Resolve the highlight index from highlightId (the source of truth). If the
   * highlighted agent is absent (evicted/removed), adopt the nearest remaining
   * agent: index = min(previousIndex, len-1). Clamps the scroll anchor to <= index.
   */
  private resolveHighlight(roster: AgentRecord[]): number {
    if (roster.length === 0) {
      this.highlightId = null;
      this.lastHighlightIndex = 0;
      this.scrollAnchor = 0;
      return 0;
    }
    let index = this.lastHighlightIndex;
    const pos = this.highlightId === null ? -1 : roster.findIndex((a) => a.id === this.highlightId);
    if (pos === -1) {
      index = Math.min(index, roster.length - 1);
      this.highlightId = roster[index].id;
    } else {
      index = pos;
    }
    this.lastHighlightIndex = index;
    if (this.scrollAnchor > index) this.scrollAnchor = index;
    return index;
  }

  /**
   * Resolve nav roster and highlight from one snapshot. Returns `now` so
   * callers seed navLastMove with the same value; render resolves the roster
   * directly to reuse the snapshot it already categorized.
   */
  private resolveNavState(): { roster: AgentRecord[]; index: number; now: number } {
    const now = Date.now();
    const roster = this.resolveNavRoster(now, this.liveRoster());
    return { roster, index: this.resolveHighlight(roster), now };
  }

  /** Enter navigation mode. Highlights the first agent if agents exist, else main (index 0). */
  navActivate(): void {
    if (this.navActive) return;
    this.navActive = true;
    const now = Date.now();
    const roster = this.resolveNavRoster(now, this.liveRoster());
    this.lastHighlightIndex = 0;
    this.scrollAnchor = 0;
    this.highlightId = roster.length > 0 ? roster[0].id : null;
    this.navLastMove = now;
    this.update();
  }

  /** Move the highlight one step (delta −1 = up, +1 = down) with scroll logic; wraps at both ends. */
  private moveNav(delta: 1 | -1): void {
    if (!this.navActive) return;
    const { roster, index: h, now } = this.resolveNavState();
    if (roster.length === 0) {
      this.navDeactivate();
      return;
    }
    const len = roster.length;
    const { start, end } = this.navWindow(h, roster);

    // Moving past the window edge scrolls the anchor; past the list end wraps.
    const atEdge = delta === 1 ? h === end : h === start;
    const atListEnd = delta === 1 ? end === len - 1 : start === 0;
    const wrap = atEdge && atListEnd;
    const next = wrap ? (delta === 1 ? 0 : len - 1) : h + delta;
    if (wrap) {
      this.scrollAnchor = delta === 1 ? 0 : this.bottomScrollStart(roster);
    } else if (atEdge) {
      this.scrollAnchor += delta;
    }
    this.lastHighlightIndex = next;
    this.highlightId = roster[next].id;
    this.navLastMove = now;
    this.update();
  }

  navDown(): void {
    this.moveNav(1);
  }

  navUp(): void {
    this.moveNav(-1);
  }

  /** Greedy highest index (inclusive) that fits within the budget. */
  private computeWindowEnd(start: number, roster: AgentRecord[], budget: number): number {
    let end = start - 1;
    for (let i = start; i < roster.length; i++) {
      const blockHeight = this.getBlockHeight(roster[i]);
      if (budget >= blockHeight) {
        budget -= blockHeight;
        end = i;
      } else {
        break;
      }
    }
    return end;
  }

  /**
   * Greedy window end from `start` under the nav budget rule: the full body
   * budget, reduced by one line (the overflow indicator) whenever anything
   * would be hidden. Mirrors rendering so state machine and renderer agree.
   */
  private navWindowEndFrom(start: number, roster: AgentRecord[]): number {
    const maxBody = this.getMaxBody();
    let end = this.computeWindowEnd(start, roster, maxBody);
    if (start > 0 || end < roster.length - 1) {
      end = this.computeWindowEnd(start, roster, maxBody - 1);
    }
    return end;
  }

  /**
   * Compute the visible nav window [start, end] for highlight `h`, using the
   * same budget rule as rendering. The highlighted block is always included,
   * even when it alone exceeds the budget.
   */
  private navWindow(h: number, roster: AgentRecord[]): { start: number; end: number } {
    if (roster.length === 0) return { start: 0, end: -1 };
    const start = Math.min(Math.max(this.scrollAnchor, 0), h);
    const end = Math.max(this.navWindowEndFrom(start, roster), h);
    return { start, end };
  }

  private bottomScrollStart(roster: AgentRecord[]): number {
    // Smallest start whose nav window still reaches the last block.
    for (let start = 0; start < roster.length; start++) {
      if (this.navWindowEndFrom(start, roster) >= roster.length - 1) return start;
    }
    return 0;
  }

  private hasMetadataLine(a: AgentRecord): boolean {
    if (this.isCompact()) return false;
    return (
      buildMetadataLineParts(a, this.modelDisplayStyle, this.statsVisibility, this.modelThinkingPlacement).length > 0
    );
  }

  private getBlockHeight(agent: AgentRecord): number {
    if (this.isCompact()) return 1;

    if (agent.lifecycle.status === "running") {
      // Running: activity line always present, metadata line conditional
      return 2 + (this.hasMetadataLine(agent) ? 1 : 0);
    }

    if (agent.lifecycle.status === "queued") {
      // Queued: no metadata lines (individual rows during nav)
      return 1;
    }

    return 1 + (this.hasMetadataLine(agent) ? 1 : 0);
  }

  private getMaxBody(): number {
    const maxBodyLines = this.isCompact() ? this.maxLinesCompact : this.maxLines;
    return maxBodyLines - 1; // heading takes 1 line
  }

  navSelect(): AgentRecord | null {
    const { roster, index } = this.resolveNavState();
    return roster[index] ?? null;
  }

  navDeactivate(): void {
    if (!this.navActive) return;
    this.resetNavState();
    this.update();
  }

  private resetNavState(): void {
    this.navActive = false;
    this.highlightId = null;
    this.navRoster = [];
    this.navLastMove = 0;
    this.lastHighlightIndex = 0;
    this.scrollAnchor = 0;
  }

  isNavActive(): boolean {
    return this.navActive;
  }

  /** Current highlight position (0 = main). */
  highlightedIndex(): number {
    if (!this.navActive) return 0;
    return this.resolveNavState().index;
  }

  /** Whether the widget has any visible agents (after finished-window filtering). */
  hasVisibleAgents(): boolean {
    const { finished, running, queued } = this.categorizeAgents();
    return finished.length + running.length + queued.length > 0;
  }

  isViewerOpen(): boolean {
    return this.viewerOpen;
  }

  setViewerOpen(open: boolean): void {
    this.viewerOpen = open;
  }

  isEditorFocused(): boolean {
    // Overlays (ConversationViewer, model picker) → not focused.
    if (this.tui?.hasOverlay?.()) return false;
    // Menus (ctx.ui.select/confirm) replace the editor in editorContainer.
    // Check if the focused component is the Editor via duck-typing:
    // Editor is the only component with getText() + setText().
    const focused = (this.tui as { focusedComponent?: unknown })?.focusedComponent;
    if (focused == null) return true;
    return (
      typeof (focused as { getText?: unknown })?.getText === "function" &&
      typeof (focused as { setText?: unknown })?.setText === "function"
    );
  }
  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.theme = undefined;
      this.lastStatusText = undefined;
    }
  }

  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        try {
          this.update();
        } catch (err) {
          getSessionCtx()?.ui?.notify(`[subagents] Widget timer error: ${err}`, "warning");
        }
      }, WIDGET_REFRESH_INTERVAL);
    }
  }

  private categorizeAgents() {
    const allAgents = this.manager.listAgents();
    const running: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const finished: AgentRecord[] = [];
    // One time-based filter for every finished status: keep the row while
    // completedAt is inside the retention window (ADR-0006).
    const cutoff = Date.now() - this.finishedRetentionMinutes * MINUTE_MS;

    for (const a of allAgents) {
      if (a.lifecycle.status === "running") running.push(a);
      else if (a.lifecycle.status === "queued") queued.push(a);
      else if (a.lifecycle.completedAt !== undefined && a.lifecycle.completedAt >= cutoff) finished.push(a);
    }
    return { running, queued, finished };
  }

  private finishedIconAndStatus(
    lifecycle: AgentLifecycle,
    error: string | undefined,
    theme: Theme,
  ): { icon: string; statusText: string } {
    switch (lifecycle.status) {
      case "completed":
        return { icon: theme.fg("success", "✓"), statusText: "" };
      case "turn_limited":
        return { icon: theme.fg("warning", "✓"), statusText: theme.fg("warning", " (turn limit)") };
      case "stopped": {
        const summary = formatWatchdogSummary(lifecycle);
        return {
          icon: theme.fg("dim", "■"),
          statusText: summary ? theme.fg("dim", ` stopped (${summary})`) : theme.fg("dim", " stopped"),
        };
      }
      case "error": {
        const errMsg = error ? `: ${error.slice(0, 60)}` : "";
        return { icon: theme.fg("error", "✗"), statusText: theme.fg("error", ` error${errMsg}`) };
      }
      default:
        // aborted
        return { icon: theme.fg("error", "✗"), statusText: theme.fg("warning", " aborted") };
    }
  }

  private renderFinishedLine(a: AgentRecord, theme: Theme, w: number): string {
    const name = getDisplayName(a.display.type);
    const { icon, statusText } = this.finishedIconAndStatus(a.lifecycle, a.error, theme);

    const durationMs = (a.lifecycle.completedAt ?? Date.now()) - a.lifecycle.startedAt;
    const statsParts = buildStatsParts(
      {
        toolUses: a.stats.toolUses,
        turnCount: a.stats.turnCount,
        maxTurns: a.stats.maxTurns,
        input: a.stats.lifetimeUsage.input,
        output: a.stats.lifetimeUsage.output,
        contextPercent: a.stats.contextPercent ?? null,
        compactions: a.stats.compactionCount,
        cost: a.stats.lifetimeUsage.cost,
        durationMs,
      },
      theme,
      this.statsVisibility,
    );
    const statsLine = statsParts.join("·");
    const tagPart = this.modelThinkingHeaderTag(a, theme);

    return `${icon} ${theme.fg("dim", name)}${tagPart}  ${theme.fg("dim", a.display.description)}  ${wrapInDim(theme, statsLine)}${statusText}`;
  }

  /** Build the dim-styled model/thinking tag for the header line, or "" when it belongs on the metadata line. */
  private modelThinkingHeaderTag(a: AgentRecord, theme: Theme): string {
    if (!this.shouldShowModelThinkingInHeader()) return "";
    const { model, thinking } = resolveAgentModelThinking(a, this.modelDisplayStyle);
    const tag = buildModelThinkingTag(model, thinking, this.statsVisibility);
    return tag ? ` ${theme.fg("dim", tag)}` : "";
  }

  private buildStatsLine(agent: AgentRecord, theme: Theme): string {
    const parts = buildStatsParts(
      {
        toolUses: agent.stats.toolUses,
        turnCount: agent.stats.turnCount,
        maxTurns: agent.stats.maxTurns,
        input: agent.stats.lifetimeUsage.input,
        output: agent.stats.lifetimeUsage.output,
        contextPercent: agent.execution.session
          ? getSessionContextPercent(agent.execution.session)
          : (agent.stats.contextPercent ?? null),
        compactions: agent.stats.compactionCount,
        cost: agent.stats.lifetimeUsage.cost,
        durationMs: Date.now() - agent.lifecycle.startedAt,
      },
      theme,
      this.statsVisibility,
    );
    return parts.join("·");
  }

  private buildMetadataLine(
    a: AgentRecord,
    prefix: string,
    theme: Theme,
    truncate: (line: string) => string,
  ): string | undefined {
    const parts = buildMetadataLineParts(a, this.modelDisplayStyle, this.statsVisibility, this.modelThinkingPlacement);
    if (parts.length === 0) return undefined;
    return truncate(theme.fg("dim", prefix + parts.join("  ")));
  }

  private buildFinishedBlocks(finished: AgentRecord[], theme: Theme, w: number): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of finished) {
      const metadataLines: string[] = [];
      if (!this.isCompact()) {
        const line = this.buildMetadataLine(a, "    ", theme, truncate);
        if (line) metadataLines.push(line);
      }
      blocks.push({
        header: truncate(`  ${this.renderFinishedLine(a, theme, w)}`),
        metadataLines,
      });
    }
    return blocks;
  }

  private buildRunningBlocks(running: AgentRecord[], theme: Theme, w: number, frame: string): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of running) {
      const name = getDisplayName(a.display.type);
      const bg = this.getLiveView(a.id);
      const statsLine = this.buildStatsLine(a, theme);
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      if (this.isCompact()) {
        // Compact: single line; description after model, stats, then activity.
        // Truncate description to preserve stats visibility; activity fills remainder
        // and gets cut by truncate() (which cuts from the right).
        const tagPart = this.modelThinkingHeaderTag(a, theme);
        const fixedParts = `  ${theme.fg("accent", frame)} ${theme.bold(name)}${tagPart}  `;
        const fixedWidth = visibleWidth(fixedParts);
        const statsWidth = visibleWidth(`  ${statsLine}`);
        const availableForDesc = Math.max(0, w - fixedWidth - statsWidth);

        const finalDesc = truncateToWidth(a.display.description, availableForDesc);

        // Activity gets full text; truncate() will cut from the right if line exceeds width.
        const headerLine = `${fixedParts}${finalDesc}  ${statsLine}  ${theme.fg("dim", activity)}`.trimEnd();
        blocks.push({
          header: truncate(headerLine),
          metadataLines: [],
        });
      } else {
        // Full: header + metadata lines (model/thinking on metadata line)
        // Truncate description to preserve stats visibility.
        const tagPart = this.modelThinkingHeaderTag(a, theme);
        const fixedParts = `  ${theme.fg("accent", frame)} ${theme.bold(name)}${tagPart}    ${statsLine}`;
        const fixedWidth = visibleWidth(fixedParts);
        const availableWidth = w - fixedWidth;
        const truncatedDesc = truncateToWidth(a.display.description, Math.max(0, availableWidth));
        const headerLine = `  ${theme.fg("accent", frame)} ${theme.bold(name)}${tagPart}  ${truncatedDesc}  ${statsLine}`;
        const metadataLines: string[] = [];
        const line = this.buildMetadataLine(a, "  │ ", theme, truncate);
        if (line) metadataLines.push(line);
        metadataLines.push(truncate(theme.fg("dim", "  └ " + activity)));
        blocks.push({
          header: truncate(headerLine),
          metadataLines,
        });
      }
    }
    return blocks;
  }

  private buildQueuedBlock(queued: AgentRecord[], theme: Theme, w: number): RenderBlock | undefined {
    if (queued.length === 0) return undefined;
    const truncate = (line: string) => truncateToWidth(line, w);
    const header = `  ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`;
    return { header: truncate(header), metadataLines: [] };
  }

  private isCompact(): boolean {
    return this.forceCompact || (this.widgetShortcut && this.compactMode);
  }

  private renderNavigationMode(
    roster: AgentRecord[],
    highlightIndex: number,
    blockById: Map<string, RenderBlock>,
    theme: Theme,
    truncate: (line: string) => string,
  ): string[] {
    const len = roster.length;
    if (len === 0) return [];

    // Same budget rule as nav moves: full body, minus one line for the
    // overflow indicator whenever anything is hidden.
    const { start, end } = this.navWindow(highlightIndex, roster);

    // Render visible blocks in roster order with the highlight. Blocks are
    // looked up by id because the frozen order can differ from the live
    // category order the blocks were built in. The roster comes from the
    // same snapshot as the blocks, so every id resolves.
    const visibleBlocks = roster.slice(start, end + 1).map((a) => blockById.get(a.id)!);
    const visIndex = highlightIndex - start;
    const lines = this.renderBlocks(visibleBlocks, visIndex);

    const hiddenCount = len - (end - start + 1);
    if (hiddenCount > 0) {
      lines.push(truncate(this.buildOverflowLine(hiddenCount, theme)));
    }
    return lines;
  }

  private renderNonNavigationMode(
    blocks: RenderBlock[],
    totalAgents: number,
    theme: Theme,
    truncate: (line: string) => string,
    maxBody: number,
  ): string[] {
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.metadataLines.length, 0);

    if (totalBody <= maxBody) {
      return this.renderBlocks(blocks, -1);
    }

    // Collapse from bottom: reserve 1 line for overflow indicator
    let budget = maxBody - 1;
    const visible: RenderBlock[] = [];
    for (const block of blocks) {
      const height = 1 + block.metadataLines.length;
      if (budget >= height) {
        visible.push(block);
        budget -= height;
      } else {
        break;
      }
    }
    const lines = this.renderBlocks(visible, -1);
    // Overflow line: "+N more" where N = hidden agents. In this branch the
    // queued aggregated block is always the last block and never visible
    // (if it fit, everything fit), so every visible block is one agent.
    const hiddenCount = totalAgents - visible.length;
    if (hiddenCount > 0) {
      lines.push(truncate(this.buildOverflowLine(hiddenCount, theme)));
    }
    return lines;
  }

  private renderWidget(tui: TUI, theme: Theme): string[] {
    const { running, queued, finished } = this.categorizeAgents();

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "◈" : "◇";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build blocks — separate arrays so overflow logic can apply priority: running > queued > finished.
    const finishedBlocks = this.buildFinishedBlocks(finished, theme, w);
    const runningBlocks = this.buildRunningBlocks(running, theme, w, frame);

    // Queued: individual rows during nav, aggregated block otherwise.
    let queuedBlocks: RenderBlock[];
    if (this.navActive) {
      queuedBlocks = this.buildQueuedIndividualBlocks(queued, theme, w);
    } else {
      const aggregated = this.buildQueuedBlock(queued, theme, w);
      queuedBlocks = aggregated ? [aggregated] : [];
    }

    // All blocks in display order: finished → running → queued.
    const blocks: RenderBlock[] = [...finishedBlocks, ...runningBlocks, ...queuedBlocks];

    // Resolve nav state first (every render tick): the roster — possibly in
    // frozen order — and the identity-based highlight. Eviction adoption
    // happens here, so a stale highlight can never reach the renderer. The
    // roster is derived from this render's snapshot so blocks and roster
    // always agree.
    let navRoster: AgentRecord[] | null = null;
    let navIndex = 0;
    if (this.navActive) {
      navRoster = this.resolveNavRoster(Date.now(), [...finished, ...running, ...queued]);
      navIndex = this.resolveHighlight(navRoster);
    }

    // ---- Overflow logic (scroll model during nav, contiguous collapse otherwise) ----

    const maxBody = this.getMaxBody();

    const navReadout =
      navRoster && navRoster.length > 0 ? { position: navIndex + 1, size: navRoster.length } : undefined;
    const heading = this.buildHeading(theme, headingColor, headingIcon, navReadout);
    const lines: string[] = [truncate(heading)];

    if (this.navActive && navRoster) {
      // Blocks in roster order: the frozen order can differ from the live
      // category order the blocks were built in.
      const blockById = new Map<string, RenderBlock>();
      for (let i = 0; i < finished.length; i++) blockById.set(finished[i].id, finishedBlocks[i]);
      for (let i = 0; i < running.length; i++) blockById.set(running[i].id, runningBlocks[i]);
      for (let i = 0; i < queued.length; i++) blockById.set(queued[i].id, queuedBlocks[i]);
      lines.push(...this.renderNavigationMode(navRoster, navIndex, blockById, theme, truncate));
    } else {
      lines.push(
        ...this.renderNonNavigationMode(
          blocks,
          finished.length + running.length + queued.length,
          theme,
          truncate,
          maxBody,
        ),
      );
    }

    return lines;
  }

  private buildHeading(
    theme: Theme,
    color: string,
    icon: string,
    navReadout?: { position: number; size: number },
  ): string {
    const iconText = `${theme.fg(color, icon)} ${theme.fg(color, "Agents")}`;
    if (this.navActive) {
      const readout = navReadout
        ? `${iconText} ${theme.fg("dim", `${navReadout.position}/${navReadout.size}`)}`
        : iconText;
      if (!this.navHint) return readout;
      return `${readout}  ${theme.fg("dim", "↑↓ navigate · enter view · esc back")}`;
    }
    if (!this.navHint) return iconText;
    return `${iconText}  ${theme.fg("dim", "↓ to navigate")}`;
  }

  private buildQueuedIndividualBlocks(queued: AgentRecord[], theme: Theme, w: number): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of queued) {
      const name = getDisplayName(a.display.type);
      const desc = a.display.description;
      const header = `  ${theme.fg("muted", "◦")} ${theme.fg("dim", name)}  ${theme.fg("dim", desc)}`;
      blocks.push({ header: truncate(header), metadataLines: [] });
    }
    return blocks;
  }

  private renderBlock(block: RenderBlock, isHighlighted: boolean): string[] {
    let header = block.header;
    if (isHighlighted && header.startsWith("  ")) {
      header = "→ " + header.slice(2);
    }
    return [header, ...block.metadataLines];
  }
  private renderBlocks(blocks: RenderBlock[], highlightedBlockIndex: number): string[] {
    return blocks.flatMap((b, i) => this.renderBlock(b, i === highlightedBlockIndex));
  }

  private buildOverflowLine(hiddenCount: number, theme: Theme): string {
    return `  ${theme.fg("dim", `+${hiddenCount} more`)}`;
  }

  private clearWidget() {
    if (this.navActive) this.resetNavState();
    if (this.widgetRegistered) {
      this.uiCtx?.setWidget(WIDGET_KEY, undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.lastStatusText !== undefined) {
      this.uiCtx?.setStatus(STATUS_KEY, undefined);
      this.lastStatusText = undefined;
    }
    // Note: timer is NOT cleared here. It keeps running so the widget
    // can re-register when agents appear again (e.g., after a steer
    // message triggers a new turn). The timer's update() call early-returns
    // when there are no agents, so there's no cost to keeping it alive.
  }

  private buildStatusBarText(activeCount: number, doneCount: number, totalCost: number): string {
    const icon = activeCount > 0 ? "◈" : "◇";
    const iconColor = activeCount > 0 ? "accent" : "dim";

    if (this.statusBarFormat === "compact") {
      const parts: string[] = [icon];
      if (activeCount > 0) parts.push(`${activeCount}`);
      if (doneCount > 0) parts.push(`${doneCount}Σ`);
      if (totalCost > 0) parts.push(formatCost(totalCost));
      return this.theme
        ? `${this.theme.fg(iconColor, icon)}${parts
            .slice(1)
            .map((p) => ` ${p}`)
            .join("")}`
        : parts.join(" ");
    }

    // Full: ◈ Agents: [N active][ · M done][ · $cost]
    const suffixParts: string[] = [];
    if (activeCount > 0) suffixParts.push(`${activeCount} active`);
    if (doneCount > 0) suffixParts.push(`${doneCount} done`);
    if (totalCost > 0) suffixParts.push(formatCost(totalCost));
    const agentsLabel = this.theme ? this.theme.fg(iconColor, "Agents") : "Agents";
    if (suffixParts.length > 0)
      return `${this.theme ? this.theme.fg(iconColor, icon) : icon} ${agentsLabel}: ${suffixParts.join(" \u00b7 ")}`;
    return `${this.theme ? this.theme.fg(iconColor, icon) : icon} ${agentsLabel}`;
  }

  private updateStatusBar(runningCount: number, queuedCount: number, running: AgentRecord[]) {
    const activeCount = runningCount + queuedCount;
    const doneCount = this.manager.getTotalAgentCount();

    // Compute total cost (session accumulator + in-flight running agents)
    let totalCost = 0;
    if (this.showCost) {
      const sessionCost = this.manager.getTotalAgentCost();
      const runningCost = running.reduce((sum, a) => sum + a.stats.lifetimeUsage.cost, 0);
      totalCost = sessionCost + runningCost;
    }

    const statusText = this.buildStatusBarText(activeCount, doneCount, totalCost);

    if (statusText !== this.lastStatusText) {
      this.uiCtx?.setStatus(STATUS_KEY, statusText);
      this.lastStatusText = statusText;
    }
  }

  update() {
    if (!this.manager) {
      // Widget lost its manager reference (e.g., after session shutdown)
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
      return;
    }
    if (!this.uiCtx) return;

    const { running, queued, finished } = this.categorizeAgents();

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered || this.lastStatusText !== undefined) {
        this.clearWidget();
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    this.updateStatusBar(running.length, queued.length, running);

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          return {
            render: (_width?: number) => {
              try {
                return this.tui && this.theme ? this.renderWidget(this.tui, this.theme) : [];
              } catch (err) {
                getSessionCtx()?.ui?.notify(`[subagents] Widget render error: ${err}`, "warning");
                return [];
              }
            },
            invalidate: () => {
              // Theme changed — force re-registration so factory captures fresh theme.
              this.widgetRegistered = false;
              this.tui = undefined;
              this.theme = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender?.();
    }
  }

  dispose() {
    const interval = this.widgetInterval;
    if (interval != null) {
      clearInterval(interval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx?.setWidget(WIDGET_KEY, undefined);
      this.uiCtx?.setStatus(STATUS_KEY, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.theme = undefined;
    this.lastStatusText = undefined;
  }
}
