/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { getSessionCtx } from "../shell.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRecord } from "../types.js";
import type { Theme } from "./types.js";
import {
  formatCost,
  getLifetimeTotal,
  getSessionContextPercent,
} from "../agents/usage.js";
import { formatMs, buildStatsParts, getDisplayName, truncateDesc, describeActivity, type StatsVisibility } from "./format.js";
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
/** A visual block: one header line plus zero or more continuation lines. */
interface RenderBlock {
  header: string;
  continuations: string[];
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


/** Build the worktree/output continuation line parts for an agent record. */
function buildWorktreeOutputParts(a: AgentRecord): string[] {
  const parts: string[] = [];
  if (a.display.worktreeLabel) parts.push(`@${a.display.worktreeLabel}`);
  if (a.display.outputFile) parts.push(`tail -f ${a.display.outputFile}`);
  return parts;
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
  /** Pending tool expansion state from onTerminalInput (push-based, no polling). */
  private pendingToolsExpanded: boolean | undefined;

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

  /** Max description length in full mode. */
  private descLengthFull = 50;

  /** Max description length in compact mode. */
  private descLengthCompact = 30;

  /** Whether to show navigation hint text in the heading. */
  private navHint = true;

  /** Navigation mode active. */
  private navActive = false;

  /** Current highlight position in the roster (0 = main). */
  private _highlightedIndex = 0;

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

  /** Notify widget that tool expansion state changed (push-based, no polling). */
  notifyToolsExpansionChanged(expanded: boolean) {
    this.pendingToolsExpanded = expanded;
    this.update();
  }

  /** Set max lines for full mode. */
  setMaxLines(lines: number) {
    this.maxLines = lines;
  }

  /** Set max lines for compact mode. */
  setMaxLinesCompact(lines: number) {
    this.maxLinesCompact = lines;
  }

  /** Set max description length for full mode. */
  setDescLengthFull(len: number) {
    this.descLengthFull = len;
  }

  /** Set max description length for compact mode. */
  setDescLengthCompact(len: number) {
    this.descLengthCompact = len;
  }

  /** Set whether to show navigation hint text in the heading. */
  setNavHint(enabled: boolean) {
    this.navHint = enabled;
  }

  // ---- Navigation state machine ----

  /** Clamp the navigation highlight to valid roster bounds. */
  private clampHighlight(): void {
    const roster = this.buildRoster();
    if (roster.length === 0) {
      this._highlightedIndex = 0;
    } else if (this._highlightedIndex >= roster.length) {
      this._highlightedIndex = roster.length - 1;
    }
  }

  /** Build the navigation roster: finished, running, queued. */
  private buildRoster(): AgentRecord[] {
    const { finished, running, queued } = this.categorizeAgents();
    return [...finished, ...running, ...queued];
  }

  /** Enter navigation mode. Highlights the first agent (index 1) if agents exist, else main (index 0). */
  navActivate(): void {
    if (this.navActive) return;
    this.navActive = true;
    this._highlightedIndex = 0;
    this.update();
  }

  /** Move highlight down one position. Wraps from last agent to main. */
  navDown(): void {
    if (!this.navActive) return;
    const roster = this.buildRoster();
    if (roster.length === 0) return;
    this.clampHighlight();
    this._highlightedIndex = (this._highlightedIndex + 1) % roster.length;
    this.update();
  }
  /** Move highlight up one position. Wraps from main to last agent. */
  navUp(): void {
    if (!this.navActive) return;
    const roster = this.buildRoster();
    if (roster.length === 0) return;
    this.clampHighlight();
    this._highlightedIndex = (this._highlightedIndex - 1 + roster.length) % roster.length;
    this.update();
  }

  navSelect(): AgentRecord | null {
    const roster = this.buildRoster();
    this.clampHighlight();
    return roster[this._highlightedIndex] ?? null;
  }

  /** Exit navigation mode, reset highlight. Triggers re-render. */
  navDeactivate(): void {
    if (!this.navActive) return;
    this.navActive = false;
    this._highlightedIndex = 0;
    this.update();
  }

  /** Query whether navigation mode is active. */
  isNavActive(): boolean {
    return this.navActive;
  }

  /** Current highlight position (0 = main). */
  highlightedIndex(): number {
    return this._highlightedIndex;
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
    return typeof (focused as { getText?: unknown })?.getText === "function"
      && typeof (focused as { setText?: unknown })?.setText === "function";
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
   * Called on each new turn (tool_execution_start).
   * No-op: finished-agent aging is handled by the manager's timer-based cleanup.
   */
  onTurnStart() {
    try {
      this.update();
    } catch (err) {
      getSessionCtx()?.ui?.notify(`[subagents] onTurnStart error: ${err}`, "warning");
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => { try { this.update(); } catch (err) { getSessionCtx()?.ui?.notify(`[subagents] Widget timer error: ${err}`, "warning"); } }, WIDGET_REFRESH_INTERVAL);
    }
  }

  /** Categorize all agents into running, queued, and finished groups. */
  private categorizeAgents() {
    const allAgents = this.manager.listAgents();
    const running: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const finished: AgentRecord[] = [];
    for (const a of allAgents) {
      if (a.lifecycle.status === "running") running.push(a);
      else if (a.lifecycle.status === "queued") queued.push(a);
      else if (a.lifecycle.completedAt) finished.push(a);
    }
    return { running, queued, finished };
  }

  /** Build the icon and status suffix for a finished agent. */
  private finishedIconAndStatus(
    status: string,
    error: string | undefined,
    theme: Theme,
  ): { icon: string; statusText: string } {
    switch (status) {
      case "completed":
        return { icon: theme.fg("success", "✓"), statusText: "" };
      case "turn_limited":
        return { icon: theme.fg("warning", "✓"), statusText: theme.fg("warning", " (turn limit)") };
      case "stopped":
        return { icon: theme.fg("dim", "■"), statusText: theme.fg("dim", " stopped") };
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
  private renderFinishedLine(a: AgentRecord, theme: Theme): string {
    const name = getDisplayName(a.display.type);
    const fullDesc = truncateDesc(a.display.description, this.descLengthFull);
    const { icon, statusText } = this.finishedIconAndStatus(a.lifecycle.status, a.error, theme);

    const durationMs = (a.lifecycle.completedAt ?? Date.now()) - a.lifecycle.startedAt;
    const statsParts = buildStatsParts({
      toolUses: a.stats.toolUses,
      turnCount: a.stats.turnCount,
      maxTurns: a.stats.maxTurns,
      input: a.stats.lifetimeUsage.input,
      output: a.stats.lifetimeUsage.output,
      contextPercent: a.stats.contextPercent ?? null,
      compactions: a.stats.compactionCount,
      cost: a.stats.lifetimeUsage.cost,
      durationMs,
    }, theme, this.statsVisibility);

    const statsLine = statsParts.join("·");
    return `${icon} ${theme.fg("dim", name)}  ${theme.fg("dim", fullDesc)}  ${wrapInDim(theme, statsLine)}${statusText}`;
  }

  /** Build the stats line (toolUses · turns · tokens · cost · elapsed) for a running agent. */
  private buildStatsLine(
    agent: AgentRecord,
    theme: Theme,
  ): string {
    const parts = buildStatsParts({
      toolUses: agent.stats.toolUses,
      turnCount: agent.stats.turnCount,
      maxTurns: agent.stats.maxTurns,
      input: agent.stats.lifetimeUsage.input,
      output: agent.stats.lifetimeUsage.output,
      contextPercent: agent.execution.session ? getSessionContextPercent(agent.execution.session) : agent.stats.contextPercent ?? null,
      compactions: agent.stats.compactionCount,
      cost: agent.stats.lifetimeUsage.cost,
      durationMs: Date.now() - agent.lifecycle.startedAt,
    }, theme, this.statsVisibility);
    return parts.join("·");
  }

  /** Build RenderBlocks for finished (completed/errored) agents. */
  private buildFinishedBlocks(
    finished: AgentRecord[],
    theme: Theme,
    w: number,
  ): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of finished) {
      const continuations: string[] = [];
      if (!this.isCompact()) {
        const parts = buildWorktreeOutputParts(a);
        if (parts.length > 0) {
          continuations.push(truncate(theme.fg("dim", `    ${parts.join("  ")}`)));
        }
      }
      blocks.push({
        header: truncate(`  ${this.renderFinishedLine(a, theme)}`),
        continuations,
      });
    }
    return blocks;
  }

  /** Build RenderBlocks for running agents. */
  private buildRunningBlocks(
    running: AgentRecord[],
    theme: Theme,
    w: number,
    frame: string,
  ): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of running) {
      const name = getDisplayName(a.display.type);
      const bg = this.getLiveView(a.id);
      const statsLine = this.buildStatsLine(a, theme);
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      if (this.isCompact()) {
        // Compact: single line with activity inline, truncated description
        const desc = truncateDesc(a.display.description, this.descLengthCompact);
        const headerLine = `  ${theme.fg("accent", frame)} ${theme.bold(name)}  ${desc}  ${statsLine}  ${theme.fg("dim", activity)}`;
        blocks.push({
          header: truncate(headerLine),
          continuations: [],
        });
      } else {
        // Full: header + continuation lines
        const fullDesc = truncateDesc(a.display.description, this.descLengthFull);
        const headerLine = `  ${theme.fg("accent", frame)} ${theme.bold(name)}  ${fullDesc}  ${statsLine}`;
        const continuations: string[] = [];
        const parts = buildWorktreeOutputParts(a);
        if (parts.length > 0) {
          continuations.push(truncate(theme.fg("dim", "  │ " + parts.join("  "))));
        }
        continuations.push(truncate(theme.fg("dim", "  └ " + activity)));
        blocks.push({
          header: truncate(headerLine),
          continuations,
        });
      }
    }
    return blocks;
  }

  /** Build a single RenderBlock for queued agents, or undefined if none. */
  private buildQueuedBlock(
    queued: AgentRecord[],
    theme: Theme,
    w: number,
  ): RenderBlock | undefined {
    if (queued.length === 0) return undefined;
    const truncate = (line: string) => truncateToWidth(line, w);
    const header = `  ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`;
    return { header: truncate(header), continuations: [] };
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  /** Whether the widget should render in compact mode. */
  private isCompact(): boolean {
    return this.forceCompact || (this.widgetShortcut && this.compactMode);
  }

  private renderWidget(tui: TUI | undefined, theme: Theme): string[] {
    if (!tui) return [];
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
    const blocks: RenderBlock[] = [
      ...finishedBlocks,
      ...runningBlocks,
      ...queuedBlocks,
    ];

    // ---- Overflow logic (works with blocks, not lines) ----

    const maxBodyLines = this.isCompact() ? this.maxLinesCompact : this.maxLines;
    const maxBody = maxBodyLines - 1; // heading takes 1 line
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.continuations.length, 0);

    // Heading with navigation hint
    const heading = this.buildHeading(theme, headingColor, headingIcon);
    const lines: string[] = [truncate(heading)];

    // Determine highlighted block index for rendering the '>' marker.
    // highlightedIndex maps directly to block index.
    const highlightedBlockIndex = this.navActive ? this._highlightedIndex : -1;

    if (totalBody <= maxBody) {
      // Everything fits — render all blocks with correct connectors.
      lines.push(...this.renderBlocks(blocks, highlightedBlockIndex, theme));
    } else {
      // Pin the highlighted block so it's always visible during navigation.
      // blocks is already [...finishedBlocks, ...runningBlocks, ...queuedBlocks].
      const pinnedBlock = highlightedBlockIndex >= 0 && highlightedBlockIndex < blocks.length
        ? blocks[highlightedBlockIndex]
        : undefined;
      const { visible, overflowLine } = this.applyOverflow(
        runningBlocks, queuedBlocks, finishedBlocks, maxBody, theme, pinnedBlock,
      );
      // The pinned block is the highlighted one; find it among the visible blocks
      // (it won't appear if it failed to fit).
      const visIndex = pinnedBlock ? visible.indexOf(pinnedBlock) : -1;
      lines.push(...this.renderBlocks(visible, visIndex, theme));
      if (overflowLine) lines.push(truncate(overflowLine));
    }

    return lines;
  }

  /** Build the heading line with navigation hint text. */
  private buildHeading(theme: Theme, color: string, icon: string): string {
    const iconText = `${theme.fg(color, icon)} ${theme.fg(color, "Agents")}`;
    if (this.navActive) {
      return `${iconText}  ${theme.fg("dim", "↑↓ navigate · enter view · esc back")}`;
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
      const desc = truncateDesc(a.display.description, this.descLengthFull);
      const header = `  ${theme.fg("muted", "◦")} ${theme.fg("dim", name)}  ${theme.fg("dim", desc)}`;
      blocks.push({ header: truncate(header), continuations: [] });
    }
    return blocks;
  }

  private renderBlock(block: RenderBlock, _isLast: boolean, isHighlighted: boolean, theme: Theme): string[] {
    let header = block.header;
    if (isHighlighted) {
      if (header.startsWith("  ")) {
        header = "→ " + header.slice(2);
      }
    }
    return [header, ...block.continuations];
  }
  /** Render a list of blocks. */
  private renderBlocks(blocks: RenderBlock[], highlightedBlockIndex: number, theme: Theme): string[] {
    return blocks.flatMap((b, i) => this.renderBlock(b, i === blocks.length - 1, i === highlightedBlockIndex, theme));
  }

  /**
   * Overflow logic — prioritize running > queued > finished.
   * Reserve 1 line for the overflow summary indicator.
   * When `pinned` is provided (navigation mode), reserve it a slot first so the
   * highlighted block is always visible even if it would be pushed off by priority.
   */
  private applyOverflow(
    runningBlocks: RenderBlock[],
    queuedBlocks: RenderBlock[],
    finishedBlocks: RenderBlock[],
    maxBody: number,
    theme: Theme,
    pinned: RenderBlock | undefined = undefined,
  ): { visible: RenderBlock[]; overflowLine?: string } {
    let budget = maxBody - 1;
    let hiddenRunning = 0;
    let hiddenQueued = 0;
    let hiddenFinished = 0;
    const visible: RenderBlock[] = [];

    // Pin the highlighted block first (navigation mode)
    if (pinned) {
      const pinnedHeight = 1 + pinned.continuations.length;
      if (budget >= pinnedHeight) {
        visible.push(pinned);
        budget -= pinnedHeight;
      }
      // If pinned block doesn't fit, still push it — it displaces lowest-priority content
      else if (budget > 0) {
        visible.push(pinned);
        budget = 0;
      }
    }

    // 1. Running blocks (highest priority)
    for (const b of runningBlocks) {
      if (b === pinned) continue; // already placed
      const height = 1 + b.continuations.length;
      if (budget >= height) {
        visible.push(b);
        budget -= height;
      } else {
        hiddenRunning++;
      }
    }

    // 2. Queued blocks
    for (const b of queuedBlocks) {
      if (b === pinned) continue; // already placed
      if (budget >= 1) {
        visible.push(b);
        budget--;
      } else {
        hiddenQueued++;
      }
    }

    // 3. Finished blocks (lowest priority)
    for (const b of finishedBlocks) {
      if (b === pinned) continue; // already placed
      if (budget >= 1) {
        visible.push(b);
        budget--;
      } else {
        hiddenFinished++;
      }
    }

    // Overflow summary line
    let overflowLine: string | undefined;
    if (hiddenRunning + hiddenQueued + hiddenFinished > 0) {
      const parts: string[] = [];
      if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
      if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
      if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
      const summary = `+${hiddenRunning + hiddenQueued + hiddenFinished} more (${parts.join(", ")})`;
      overflowLine = `  ${theme.fg("dim", summary)}`;
    }

    return { visible, overflowLine };
  }
  /** Clear widget and status bar. */
  private clearWidget() {
    // Deactivate navigation when agents clear
    if (this.navActive) {
      this.navActive = false;
      this._highlightedIndex = 0;
    }
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

  /** Update the status bar text, only if it changed. */
  private updateStatusBar(runningCount: number, queuedCount: number, running: AgentRecord[]) {
    const total = runningCount + queuedCount;
    let statusText = total > 0 ? `${total} agent${total === 1 ? "" : "s"}` : `agents`;
    if (this.showCost) {
      const sessionCost = this.manager.getTotalAgentCost();
      // Also include in-flight running agents (not yet completed, so not in accumulator)
      const runningCost = running.reduce((sum, a) => sum + a.stats.lifetimeUsage.cost, 0);
      const totalCost = sessionCost + runningCost;
      if (totalCost > 0) statusText += `: ${formatCost(totalCost)}`;
    }
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

    // Sync compact mode with tool expansion state (ctrl+o)
    // Tools expanded → widget full, tools collapsed → widget compact
    // Note: sync is triggered by onTerminalInput detecting ctrl+o, not polling
    if (this.widgetShortcut && !this.forceCompact && this.pendingToolsExpanded !== undefined) {
      this.compactMode = !this.pendingToolsExpanded;
      this.pendingToolsExpanded = undefined;
    }

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
      this.uiCtx.setWidget(WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        this.theme = theme;
        return {
          render: (_width?: number) => {
            try {
              return (this.tui && this.theme) ? this.renderWidget(this.tui, this.theme) : [];
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
      }, { placement: "aboveEditor" });
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
