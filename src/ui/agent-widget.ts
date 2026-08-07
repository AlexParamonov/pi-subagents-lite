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
import type { LiveView } from "../spawn/spawn-coordinator.js";

// Re-export Theme so existing consumers (searchable-select, result-viewer) don't break
export type { Theme } from "./types.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const DEFAULT_MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Widget key used with setWidget(). */
const WIDGET_KEY = "agents";

/** Status bar key used with setStatus(). */
const STATUS_KEY = "subagents";

/** Widget refresh interval in milliseconds. */
const WIDGET_REFRESH_INTERVAL = 80;

/** Navigation freeze window: roster order is deferred while the user is actively navigating. */
const NAV_FREEZE_MS = 2000;
const LINGER_STATUSES = new Set(["error", "aborted", "turn_limited", "stopped"]);
const ERROR_LINGER_TURNS = 2;

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
export type { LiveView as AgentActivity } from "../spawn/spawn-coordinator.js";

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

  /** Whether to show cost in stats and status bar. */
  private showCost = false;

  /** Stats visibility flags. Controls which stats appear in the stats line. */
  private statsVisibility: StatsVisibility = {};

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
  /** Cached theme reference from widget factory callback. */
  private theme: Theme | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  /** Whether to use compact mode (1-line per agent). */
  private compactMode = false;

  /** Whether "force compact" mode is ON — overrides ctrl+o shortcut. */
  private forceCompact = false;

  /** Whether ctrl+o shortcut is enabled (syncs compact with toolsExpanded). */
  private widgetShortcut = false;

  /** Maximum lines for full mode. */
  private maxLines = DEFAULT_MAX_WIDGET_LINES;

  /** Maximum lines for compact mode. */
  private maxLinesCompact = Math.floor(DEFAULT_MAX_WIDGET_LINES / 2);

  /** Whether to show navigation hint text in the heading. */
  private navHint = true;

  /** Status bar format: 'full' or 'compact'. */
  private statusBarFormat: "full" | "compact" = "full";

  /** Turn age for finished agents: agent id → turns since completion. */
  private finishedTurnAge = new Map<string, number>();

  /** Configurable turn threshold for evicting finished agents. 0 = disabled. */
  private finishedEvictTurns = 0;

  /** Model display format: 'id' (short) or 'name' (full). */
  private modelDisplayStyle: "id" | "name" = "id";

  /** Model/thinking placement in full mode: 'header' (1st line) or 'metadata' (2nd line). */
  private modelThinkingPlacement: ModelThinkingPlacement = "header";

  /** Whether model/thinking should appear in header (compact mode or header placement setting). */
  private shouldShowModelThinkingInHeader(): boolean {
    return this.isCompact() || this.modelThinkingPlacement === "header";
  }

  /** Navigation mode active. */
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

  /** Viewer overlay open — prevents deactivation while ResultViewer is displayed. */
  private viewerOpen = false;

  constructor(
    private manager: AgentManager,
    private getLiveView: (id: string) => LiveView | undefined,
  ) {}

  /** Set whether to show cost in stats and status bar. */
  setShowCost(enabled: boolean) {
    this.showCost = enabled;
  }

  /** Set stats visibility flags. */
  setStatsVisibility(visible: StatsVisibility) {
    this.statsVisibility = visible;
  }

  /** Set compact mode (internal, for sync from ctrl+o). */
  setCompactMode(enabled: boolean) {
    if (this.compactMode === enabled) return;
    this.compactMode = enabled;
    this.update();
  }

  /** Set force compact mode — overrides ctrl+o shortcut. */
  setForceCompact(enabled: boolean) {
    this.forceCompact = enabled;
  }

  /** Set whether ctrl+o shortcut is enabled. */
  setWidgetShortcut(enabled: boolean) {
    this.widgetShortcut = enabled;
  }

  /** Set max lines for full mode. */
  setMaxLines(lines: number) {
    this.maxLines = lines;
  }

  /** Set max lines for compact mode. */
  setMaxLinesCompact(lines: number) {
    this.maxLinesCompact = lines;
  }

  /** Set whether to show navigation hint text in the heading. */
  setNavHint(enabled: boolean) {
    this.navHint = enabled;
  }

  /** Set status bar format ('full' or 'compact'). */
  setStatusBarFormat(format: "full" | "compact") {
    this.statusBarFormat = format;
  }
  /** Set the turn threshold for evicting finished agents. 0 = disabled. */
  setFinishedEvictTurns(turns: number) {
    this.finishedEvictTurns = turns;
  }
  /** Set model display format: 'id' (short) or 'name' (full). */
  setModelDisplayStyle(style: "id" | "name") {
    this.modelDisplayStyle = style;
  }
  /** Set model/thinking placement in full mode: 'header' (1st line) or 'metadata' (2nd line). */
  setModelThinkingPlacement(placement: ModelThinkingPlacement) {
    this.modelThinkingPlacement = placement;
  }
  /** Register a finished agent for turn-based tracking. No-op when eviction is disabled. */
  markFinished(id: string) {
    if (this.finishedEvictTurns > 0) this.finishedTurnAge.set(id, 0);
  }

  // ---- Navigation state machine ----

  /** All visible agents in live display order: finished → running → queued. */
  private liveRoster(): AgentRecord[] {
    const { finished, running, queued } = this.categorizeAgents();
    return [...finished, ...running, ...queued];
  }

  /**
   * Resolve the current nav roster from a live snapshot (ordered records).
   * Within the freeze window the order is kept: evicted agents drop, new
   * agents append at the end in live relative order. When dormant, the
   * roster is rebuilt in live display order on every call, so a long pause
   * stays current.
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
      // No highlight yet, or the highlighted agent was evicted/removed:
      // adopt the nearest remaining agent.
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
   * Resolve the current nav state: the roster (possibly frozen) and the
   * identity-based highlight position, from one live snapshot. Returns the
   * timestamp that drove the freeze check so callers seed navLastMove with
   * the same value. Render uses resolveNavRoster directly to reuse the
   * snapshot it already categorized for the blocks.
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

  /** Move highlight down one position with scroll logic. */
  navDown(): void {
    this.moveNav(1);
  }

  /** Move highlight up one position with scroll logic. */
  navUp(): void {
    this.moveNav(-1);
  }

  /**
   * Compute the greedy window end starting from `start`, given the roster and budget.
   * Returns the highest index (inclusive) that fits within the budget.
   */
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

  /** Compute the scroll anchor that shows the last block at the bottom. */
  private bottomScrollStart(roster: AgentRecord[]): number {
    // Smallest start whose nav window still reaches the last block.
    for (let start = 0; start < roster.length; start++) {
      if (this.navWindowEndFrom(start, roster) >= roster.length - 1) return start;
    }
    return 0;
  }

  /**
   * Check if an agent has a metadata line in full mode.
   * Delegates to buildMetadataLineParts to determine if any parts exist.
   */
  private hasMetadataLine(a: AgentRecord): boolean {
    if (this.isCompact()) return false;
    return (
      buildMetadataLineParts(a, this.modelDisplayStyle, this.statsVisibility, this.modelThinkingPlacement).length > 0
    );
  }

  /** Get the height of a block (header + metadata lines) for an agent. */
  private getBlockHeight(agent: AgentRecord): number {
    // In compact mode, all blocks are 1 line (header only)
    if (this.isCompact()) return 1;

    // In full mode, count metadata lines
    if (agent.lifecycle.status === "running") {
      // Running: activity line always present, metadata line conditional
      return 2 + (this.hasMetadataLine(agent) ? 1 : 0);
    }

    if (agent.lifecycle.status === "queued") {
      // Queued: no metadata lines (individual rows during nav)
      return 1;
    }

    // Finished: metadata line conditional
    return 1 + (this.hasMetadataLine(agent) ? 1 : 0);
  }

  /** Get the max body lines (total lines minus heading). */
  private getMaxBody(): number {
    const maxBodyLines = this.isCompact() ? this.maxLinesCompact : this.maxLines;
    return maxBodyLines - 1; // heading takes 1 line
  }

  navSelect(): AgentRecord | null {
    const { roster, index } = this.resolveNavState();
    return roster[index] ?? null;
  }

  /** Exit navigation mode, reset highlight and scroll anchor. Triggers re-render. */
  navDeactivate(): void {
    if (!this.navActive) return;
    this.resetNavState();
    this.update();
  }

  /** Reset all navigation state: highlight, roster, freeze timer, scroll anchor. */
  private resetNavState(): void {
    this.navActive = false;
    this.highlightId = null;
    this.navRoster = [];
    this.navLastMove = 0;
    this.lastHighlightIndex = 0;
    this.scrollAnchor = 0;
  }

  /** Query whether navigation mode is active. */
  isNavActive(): boolean {
    return this.navActive;
  }

  /** Current highlight position (0 = main). Derived from highlightId against the current roster. */
  highlightedIndex(): number {
    if (!this.navActive) return 0;
    return this.resolveNavState().index;
  }

  /** Whether the widget has any visible agents (after turn eviction filtering). */
  hasVisibleAgents(): boolean {
    const { finished, running, queued } = this.categorizeAgents();
    return finished.length + running.length + queued.length > 0;
  }

  /** Whether the ResultViewer overlay is currently open. */
  isViewerOpen(): boolean {
    return this.viewerOpen;
  }

  /** Set whether the ResultViewer overlay is open. */
  setViewerOpen(open: boolean): void {
    this.viewerOpen = open;
  }

  /** Check if the editor currently has focus (no dialog/menu open). */
  isEditorFocused(): boolean {
    // Overlays (ResultViewer, model picker) → not focused.
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

  /**
   * Called on each new LLM turn (turn_start event).
   * Increments turn age for all tracked finished agents.
   */
  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    try {
      this.update();
    } catch (err) {
      getSessionCtx()?.ui?.notify(`[subagents] onTurnStart error: ${err}`, "warning");
    }
  }

  /** Ensure the widget update timer is running. */
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

  /** Categorize all agents into running, queued, and finished groups. */
  private categorizeAgents() {
    const allAgents = this.manager.listAgents();
    const running: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const finished: AgentRecord[] = [];

    // Prune finishedTurnAge entries for agents no longer in the manager.
    if (this.finishedTurnAge.size > 0) {
      const agentIds = new Set(allAgents.map((a) => a.id));
      for (const id of this.finishedTurnAge.keys()) {
        if (!agentIds.has(id)) this.finishedTurnAge.delete(id);
      }
    }

    for (const a of allAgents) {
      if (a.lifecycle.status === "running") running.push(a);
      else if (a.lifecycle.status === "queued") queued.push(a);
      else if (a.lifecycle.completedAt && this.shouldShowFinished(a)) finished.push(a);
    }
    return { running, queued, finished };
  }

  /** Whether a finished agent should still be shown (not yet evicted by turn age). */
  private shouldShowFinished(a: AgentRecord): boolean {
    if (this.finishedEvictTurns === 0) return true;
    const age = this.finishedTurnAge.get(a.id) ?? 0;
    const isLingerStatus = LINGER_STATUSES.has(a.lifecycle.status);
    const maxAge = this.finishedEvictTurns + (isLingerStatus ? ERROR_LINGER_TURNS : 0);
    return isLingerStatus ? age <= maxAge : age < maxAge;
  }

  /** Build the icon and status suffix for a finished agent. */
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

  /** Render a finished agent line. */
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

  /** Build the stats line (toolUses · turns · tokens · cost · elapsed) for a running agent. */
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

  /** Build the dim-styled metadata line (model/thinking, worktree, output file), or undefined when empty. */
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

  /** Build RenderBlocks for finished (completed/errored) agents. */
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

  /** Build RenderBlocks for running agents. */
  private buildRunningBlocks(running: AgentRecord[], theme: Theme, w: number, frame: string): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of running) {
      const name = getDisplayName(a.display.type);
      const bg = this.getLiveView(a.id);
      const statsLine = this.buildStatsLine(a, theme);
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      if (this.isCompact()) {
        // Compact: single line; description after model, prioritize stats > description > activity.
        const tagPart = this.modelThinkingHeaderTag(a, theme);
        const fixedParts = `  ${theme.fg("accent", frame)} ${theme.bold(name)}${tagPart}  `;
        const fixedWidth = visibleWidth(fixedParts);
        const statsWidth = visibleWidth(`  ${statsLine}`);
        const availableWidth = w - fixedWidth - statsWidth;

        const desc = a.display.description;
        const activityMinWidth = 15;

        let finalDesc: string;
        let finalActivity: string;

        if (availableWidth < 30 + activityMinWidth && visibleWidth(activity) > activityMinWidth) {
          // Description would be too short if we reserve activity space.
          // Drop activity reservation to keep description meaningful.
          finalActivity = "";
          finalDesc = truncateToWidth(desc, availableWidth);
        } else {
          // Reserve at least activityMinWidth for activity.
          const activityWidth = Math.min(activityMinWidth, visibleWidth(activity));
          const descWidth = Math.max(0, availableWidth - activityWidth);
          finalDesc = truncateToWidth(desc, descWidth);
          finalActivity = truncateToWidth(activity, activityWidth);
        }

        const headerLine = `${fixedParts}${finalDesc}  ${statsLine}  ${theme.fg("dim", finalActivity)}`.trimEnd();
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

  /** Build a single RenderBlock for queued agents, or undefined if none. */
  private buildQueuedBlock(queued: AgentRecord[], theme: Theme, w: number): RenderBlock | undefined {
    if (queued.length === 0) return undefined;
    const truncate = (line: string) => truncateToWidth(line, w);
    const header = `  ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`;
    return { header: truncate(header), metadataLines: [] };
  }

  /** Whether the widget should render in compact mode. */
  private isCompact(): boolean {
    return this.forceCompact || (this.widgetShortcut && this.compactMode);
  }

  /** Render navigation mode: scroll window with highlighted agent. */
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

    // Overflow line: "+N more" where N = hidden agents
    const hiddenCount = len - (end - start + 1);
    if (hiddenCount > 0) {
      lines.push(truncate(this.buildOverflowLine(hiddenCount, theme)));
    }
    return lines;
  }

  /** Render non-navigation mode: contiguous top→bottom collapse. */
  private renderNonNavigationMode(
    blocks: RenderBlock[],
    totalAgents: number,
    theme: Theme,
    truncate: (line: string) => string,
    maxBody: number,
  ): string[] {
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.metadataLines.length, 0);

    if (totalBody <= maxBody) {
      // Everything fits — render all blocks
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

    // Heading with navigation hint and, during nav, the N/M position readout.
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

  /** Build the heading line with navigation hint text and, during nav, the N/M readout. */
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

  /** Build individual RenderBlocks for each queued agent (used during navigation). */
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
  /** Render a list of blocks. */
  private renderBlocks(blocks: RenderBlock[], highlightedBlockIndex: number): string[] {
    return blocks.flatMap((b, i) => this.renderBlock(b, i === highlightedBlockIndex));
  }

  /** Build the overflow line showing hidden agent count. */
  private buildOverflowLine(hiddenCount: number, theme: Theme): string {
    return `  ${theme.fg("dim", `+${hiddenCount} more`)}`;
  }

  /** Clear widget and status bar. */
  private clearWidget() {
    // Deactivate navigation when agents clear
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

  /** Build the status bar text for the current agent state. */
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

  /** Update the status bar text, only if it changed. */
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

  /** Force an immediate widget update. */
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

    // Nothing to show — clear widget if registered, then early-return
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
      // Widget already registered — just request a re-render of existing components.
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
