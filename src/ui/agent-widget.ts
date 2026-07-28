/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getSessionCtx } from "../shell.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRecord, AgentStatus } from "../types.js";
import type { Theme } from "./types.js";
import { formatCost, getSessionUsageSnapshot } from "../agents/usage.js";
import { buildStatsCells, buildStatsLayout, formatStatsRow, formatThinkingTag, getAgentStatusDisplay, getDisplayName, truncateDesc, describeActivity, fgPreservingNestedStyles, type StatsCells, type StatsLayout, type StatsVisibility } from "./format.js";
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

/** Fixed horizontal gaps between the aligned agent columns. */
const NAME_COLUMN_GAP = "  ";
const MODEL_THINKING_COLUMN_GAP = "  ";
const ROW_PREFIX_WIDTH_WITH_START_TIME = 10; // indent, status icon, HH:MM time, and gaps
const ROW_PREFIX_WIDTH_WITHOUT_START_TIME = 4; // indent, status icon, and following gap
const STATS_COLUMN_GAP_WIDTH = 2;
const ACTIVITY_COLUMN_GAP_WIDTH = 2;

// ---- Types ----


export type UICtx = {
  /** Pi UI theme; optional for test and legacy UI contexts. */
  theme?: Pick<Theme, "fg">;
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
  agent: AgentRecord;
  header: string;
  continuations: string[];
}

/** Visible terminal column widths shared by agent rows in a single render pass. */
interface AgentColumnLayout {
  nameWidth: number;
  modelThinkingWidth: number;
  descriptionWidth: number;
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

/** Pad an unstyled string to a target terminal width. */
function padToVisibleWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Build the worktree/output continuation line parts for an agent record. */
function buildWorktreeOutputParts(a: AgentRecord): string[] {
  const parts: string[] = [];
  if (a.display.worktreeLabel) parts.push(`@${a.display.worktreeLabel}`);
  if (a.display.outputFile) parts.push(`tail -f ${a.display.outputFile}`);
  return parts;
}

/** Format an agent's local creation/start time in a fixed, locale-independent HH:MM form. */
function formatStartTime(startedAt: number): string {
  if (!Number.isFinite(startedAt)) return "--:--";
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Sort agents newest-first while preserving manager order for equal or invalid timestamps. */
function sortByStartedAt(agents: AgentRecord[]): AgentRecord[] {
  return [...agents].sort((a, b) => {
    const aStartedAt = Number.isFinite(a.lifecycle.startedAt) ? a.lifecycle.startedAt : Number.NEGATIVE_INFINITY;
    const bStartedAt = Number.isFinite(b.lifecycle.startedAt) ? b.lifecycle.startedAt : Number.NEGATIVE_INFINITY;
    return bStartedAt > aStartedAt ? 1 : bStartedAt < aStartedAt ? -1 : 0;
  });
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

  /** Whether to show model names and thinking levels in each agent row. */
  private showModelThinking = true;

  /** Whether to show local HH:MM start time in each agent row. */
  private showStartTime = true;

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

  /** Current highlight position in the roster (0 = first agent). */
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

  /** Set whether model names and thinking levels are shown in agent rows. */
  setShowModelThinking(enabled: boolean) {
    if (this.showModelThinking === enabled) return;
    this.showModelThinking = enabled;
    this.update();
  }

  /** Set whether local HH:MM start time is shown in agent rows. */
  setShowStartTime(enabled: boolean) {
    if (this.showStartTime === enabled) return;
    this.showStartTime = enabled;
    this.update();
  }

  /** Notify widget that tool expansion state changed (push-based, no polling). */
  notifyToolsExpansionChanged(expanded: boolean) {
    this.pendingToolsExpanded = expanded;
    this.update();
  }

  /** Set max total lines for full mode, including the heading. */
  setMaxLines(lines: number) {
    this.maxLines = Math.max(2, lines);
  }

  /** Set max total lines for compact mode, including the heading. */
  setMaxLinesCompact(lines: number) {
    this.maxLinesCompact = Math.max(2, lines);
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

  /** Build the navigation roster in the same newest-first order as the widget. */
  private buildRoster(): AgentRecord[] {
    return this.categorizeAgents().ordered;
  }

  /** Enter navigation mode. Highlights the first agent (index 0) when one exists. */
  navActivate(): void {
    if (this.navActive) return;
    this.navActive = true;
    this._highlightedIndex = 0;
    this.update();
  }

  /** Move highlight down one position. Wraps from the last agent to the first. */
  navDown(): void {
    if (!this.navActive) return;
    const roster = this.buildRoster();
    if (roster.length === 0) return;
    this.clampHighlight();
    this._highlightedIndex = (this._highlightedIndex + 1) % roster.length;
    this.update();
  }
  /** Move highlight up one position. Wraps from the first agent to the last. */
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

  /** Current highlight position (0 = first roster agent). */
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

  /**
   * Categorize visible agents while retaining one global newest-first order.
   * Equal timestamps keep the manager's original order, including across statuses.
   */
  private categorizeAgents() {
    const ordered: AgentRecord[] = [];
    const running: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const finished: AgentRecord[] = [];
    for (const a of sortByStartedAt(this.manager.listAgents())) {
      if (a.lifecycle.status === "running") {
        ordered.push(a);
        running.push(a);
      } else if (a.lifecycle.status === "queued") {
        ordered.push(a);
        queued.push(a);
      } else if (a.lifecycle.completedAt) {
        ordered.push(a);
        finished.push(a);
      }
    }
    return { ordered, running, queued, finished };
  }

  /** Build the icon and status suffix for a finished agent. */
  private finishedIconAndStatus(
    status: AgentStatus,
    error: string | undefined,
    theme: Theme,
  ): { icon: string; statusText: string } {
    const display = getAgentStatusDisplay(status);
    const icon = theme.fg(display.color, display.icon);
    switch (status) {
      case "completed":
        return { icon, statusText: "" };
      case "turn_limited":
        return { icon, statusText: theme.fg("warning", " (turn limit)") };
      case "stopped":
        return { icon, statusText: theme.fg("dim", " stopped") };
      case "error": {
        const errMsg = error ? `: ${error.slice(0, 60)}` : "";
        return { icon, statusText: theme.fg("error", ` error${errMsg}`) };
      }
      case "aborted":
        return { icon, statusText: theme.fg("warning", " aborted") };
      default:
        return { icon, statusText: "" };
    }
  }

  /** Build the optional parenthesized model/thinking label for an agent. */
  private modelThinkingLabel(a: AgentRecord): string {
    const invocation = a.display.invocation;
    const modelName = typeof invocation?.modelName === "string" && invocation.modelName.trim()
      ? invocation.modelName.trim()
      : undefined;
    const thinkingLevel = formatThinkingTag(invocation?.thinkingLevel);
    const parts = [modelName, thinkingLevel].filter((part): part is string => part !== undefined);
    return parts.length > 0 ? `(${parts.join(" · ")})` : "";
  }

  /** Get an agent description at the display length and, when needed, terminal width. */
  private displayDescription(a: AgentRecord, maxWidth?: number): string {
    const description = truncateDesc(a.display.description, this.isCompact() ? this.descLengthCompact : this.descLengthFull);
    return maxWidth == null ? description : truncateToWidth(description, maxWidth);
  }

  /** Get a model/thinking label at the available terminal width before applying styling. */
  private displayModelThinking(a: AgentRecord, maxWidth?: number): string {
    if (!this.showModelThinking) return "";
    const label = this.modelThinkingLabel(a);
    return maxWidth == null ? label : truncateToWidth(label, maxWidth);
  }

  /** Width used by the row's indent, status symbol, and optional start time. */
  private rowPrefixWidth(): number {
    return this.showStartTime ? ROW_PREFIX_WIDTH_WITH_START_TIME : ROW_PREFIX_WIDTH_WITHOUT_START_TIME;
  }

  /** Render the optional local start time after a status symbol. */
  private renderStartTime(a: AgentRecord, theme: Theme, color: string): string {
    return this.showStartTime ? ` ${theme.fg(color, formatStartTime(a.lifecycle.startedAt))}` : "";
  }

  /** Build shared terminal-width columns for visible individual agent rows. */
  private buildAgentColumnLayout(agents: AgentRecord[], terminalWidth: number, statsLines: Map<string, string>): AgentColumnLayout {
    const naturalLayout = agents.reduce<AgentColumnLayout>((layout, a) => ({
      nameWidth: Math.max(layout.nameWidth, visibleWidth(getDisplayName(a.display.type))),
      modelThinkingWidth: Math.max(layout.modelThinkingWidth, visibleWidth(this.displayModelThinking(a))),
      descriptionWidth: Math.max(layout.descriptionWidth, visibleWidth(this.displayDescription(a))),
    }), { nameWidth: 0, modelThinkingWidth: 0, descriptionWidth: 0 });
    const statsWidth = Math.max(0, ...agents
      .filter((a) => a.lifecycle.status !== "queued")
      .map((a) => visibleWidth(statsLines.get(a.id) ?? "")));
    const activityWidth = this.isCompact()
      ? Math.max(0, ...agents
        .filter((a) => a.lifecycle.status === "running")
        .map((a) => {
          const live = this.getLiveView(a.id);
          return visibleWidth(live ? describeActivity(live.activeTools, live.responseText) : "thinking…");
        }))
      : 0;
    const reservedWidth = this.rowPrefixWidth()
      + naturalLayout.nameWidth
      + visibleWidth(NAME_COLUMN_GAP)
      + STATS_COLUMN_GAP_WIDTH
      + statsWidth
      + (this.isCompact() ? ACTIVITY_COLUMN_GAP_WIDTH + activityWidth : 0);
    const modelThinkingWidth = naturalLayout.modelThinkingWidth > 0
      ? Math.min(naturalLayout.modelThinkingWidth, Math.max(0, terminalWidth - reservedWidth - visibleWidth(MODEL_THINKING_COLUMN_GAP)))
      : 0;
    const modelColumnWidth = modelThinkingWidth > 0
      ? modelThinkingWidth + visibleWidth(MODEL_THINKING_COLUMN_GAP)
      : 0;

    return {
      ...naturalLayout,
      modelThinkingWidth,
      descriptionWidth: Math.min(naturalLayout.descriptionWidth, Math.max(0, terminalWidth - reservedWidth - modelColumnWidth)),
    };
  }

  /** Render the optional, shared-width model/thinking column and its trailing gap. */
  private renderModelThinkingColumn(
    modelThinking: string,
    theme: Theme,
    layout: AgentColumnLayout,
    color = "dim",
  ): string {
    return layout.modelThinkingWidth > 0
      ? `${theme.fg(color, modelThinking)}${MODEL_THINKING_COLUMN_GAP}`
      : "";
  }

  /** Return live context/auth values, or the terminal snapshot when appropriate. */
  private usageSnapshot(agent: AgentRecord) {
    const live = getSessionUsageSnapshot(agent.execution.session);
    const persisted = {
      contextPercent: agent.stats.contextPercent,
      contextWindow: agent.stats.contextWindow,
      autoCompactionEnabled: agent.stats.autoCompactionEnabled,
      usingSubscription: agent.stats.usingSubscription,
    };
    const terminal = agent.lifecycle.completedAt != null;
    return terminal
      ? (persisted.contextPercent != null || persisted.contextWindow != null ? persisted : live)
      : (live ?? persisted);
  }

  /** Build structured stats for a running or finished agent. */
  private buildStatsCells(agent: AgentRecord, theme: Theme): StatsCells {
    return buildStatsCells({
      toolUses: agent.stats.toolUses,
      turnCount: agent.stats.turnCount,
      maxTurns: agent.stats.maxTurns,
      input: agent.stats.lifetimeUsage.input,
      output: agent.stats.lifetimeUsage.output,
      cacheRead: agent.stats.cacheRead,
      cacheWrite: agent.stats.lifetimeUsage.cacheWrite,
      latestCacheHitRate: agent.stats.latestCacheHitRate,
      cost: agent.stats.lifetimeUsage.cost,
      ...this.usageSnapshot(agent),
      durationMs: (agent.lifecycle.completedAt ?? Date.now()) - agent.lifecycle.startedAt,
    }, theme, this.statsVisibility);
  }

  /** Render a structured stats row while preserving nested warning/error colors. */
  private buildStatsLine(agent: AgentRecord, theme: Theme, statsLayout?: StatsLayout, cells?: StatsCells): string {
    return fgPreservingNestedStyles(theme, "text", formatStatsRow(cells ?? this.buildStatsCells(agent, theme), statsLayout) ?? "");
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord, theme: Theme, layout: AgentColumnLayout, rawStats: string): string {
    const name = padToVisibleWidth(getDisplayName(a.display.type), layout.nameWidth);
    const modelThinking = padToVisibleWidth(this.displayModelThinking(a, layout.modelThinkingWidth), layout.modelThinkingWidth);
    const description = padToVisibleWidth(this.displayDescription(a, layout.descriptionWidth), layout.descriptionWidth);
    const { icon, statusText } = this.finishedIconAndStatus(a.lifecycle.status, a.error, theme);
    return `${icon}${this.renderStartTime(a, theme, "dim")} ${theme.fg("dim", name)}${NAME_COLUMN_GAP}${this.renderModelThinkingColumn(modelThinking, theme, layout)}${theme.fg("dim", description)}  ${wrapInDim(theme, rawStats)}${statusText}`;
  }

  /** Build RenderBlocks for finished (completed/errored) agents. */
  private buildFinishedBlocks(
    finished: AgentRecord[],
    theme: Theme,
    w: number,
    layout: AgentColumnLayout,
    statsLines: Map<string, string>,
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
        agent: a,
        header: truncate(`  ${this.renderFinishedLine(a, theme, layout, statsLines.get(a.id) ?? "")}`),
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
    layout: AgentColumnLayout,
    statsLines: Map<string, string>,
  ): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of running) {
      const name = padToVisibleWidth(getDisplayName(a.display.type), layout.nameWidth);
      const modelThinking = padToVisibleWidth(this.displayModelThinking(a, layout.modelThinkingWidth), layout.modelThinkingWidth);
      const modelThinkingColumn = this.renderModelThinkingColumn(modelThinking, theme, layout, "text");
      const bg = this.getLiveView(a.id);
      const rawStats = statsLines.get(a.id) ?? "";
      const statsLine = fgPreservingNestedStyles(theme, "text", rawStats);
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      if (this.isCompact()) {
        // Compact: single line with activity inline, truncated description
        const desc = padToVisibleWidth(this.displayDescription(a, layout.descriptionWidth), layout.descriptionWidth);
        const headerLine = `  ${theme.fg("accent", frame)}${this.renderStartTime(a, theme, "text")} ${theme.fg("text", theme.bold(name))}${NAME_COLUMN_GAP}${modelThinkingColumn}${theme.fg("text", desc)}  ${statsLine}  ${theme.fg("text", activity)}`;
        blocks.push({
          agent: a,
          header: truncate(headerLine),
          continuations: [],
        });
      } else {
        // Full: header + continuation lines
        const description = padToVisibleWidth(this.displayDescription(a, layout.descriptionWidth), layout.descriptionWidth);
        const headerLine = `  ${theme.fg("accent", frame)}${this.renderStartTime(a, theme, "text")} ${theme.fg("text", theme.bold(name))}${NAME_COLUMN_GAP}${modelThinkingColumn}${theme.fg("text", description)}  ${statsLine}`;
        const continuations: string[] = [];
        const parts = buildWorktreeOutputParts(a);
        if (parts.length > 0) {
          continuations.push(truncate(theme.fg("text", "  │ " + parts.join("  "))));
        }
        continuations.push(truncate(theme.fg("text", "  └ " + activity)));
        blocks.push({
          agent: a,
          header: truncate(headerLine),
          continuations,
        });
      }
    }
    return blocks;
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
    const { ordered, running, queued, finished } = this.categorizeAgents();

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingDisplay = getAgentStatusDisplay(running.length > 0 ? "running" : "queued");
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build blocks individually. Running and queued agents are prioritized over
    // finished ones only while choosing an overflow subset; the rendered list is
    // always globally newest-first by creation/start time.
    const statCells = new Map<string, StatsCells>();
    for (const agent of [...running, ...finished]) statCells.set(agent.id, this.buildStatsCells(agent, theme));
    const statsLayout = buildStatsLayout([...statCells.values()]);
    const statsLines = new Map<string, string>();
    for (const agent of [...running, ...finished]) {
      statsLines.set(agent.id, formatStatsRow(statCells.get(agent.id)!, statsLayout) ?? "");
    }
    const layout = this.buildAgentColumnLayout([...running, ...queued, ...finished], w, statsLines);
    const finishedBlocks = this.buildFinishedBlocks(finished, theme, w, layout, statsLines);
    const runningBlocks = this.buildRunningBlocks(running, theme, w, frame, layout, statsLines);
    const queuedBlocks = this.buildQueuedIndividualBlocks(queued, theme, w, layout);

    const blocks = this.orderBlocks([
      ...runningBlocks,
      ...queuedBlocks,
      ...finishedBlocks,
    ], ordered);

    // ---- Overflow logic (works with blocks, not lines) ----

    const maxBodyLines = this.isCompact() ? this.maxLinesCompact : this.maxLines;
    const maxBody = maxBodyLines - 1; // heading takes 1 line
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.continuations.length, 0);

    // Heading with navigation hint
    const heading = this.buildHeading(theme, headingDisplay.color, headingDisplay.icon);
    const lines: string[] = [truncate(heading)];

    // Determine highlighted block index for rendering the '>' marker.
    // highlightedIndex maps directly to block index.
    const highlightedBlockIndex = this.navActive ? this._highlightedIndex : -1;

    if (totalBody <= maxBody) {
      // Everything fits — render all blocks with correct connectors.
      lines.push(...this.renderBlocks(blocks, highlightedBlockIndex, theme));
    } else {
      // Pin the highlighted block so it remains visible during navigation.
      const pinnedBlock = highlightedBlockIndex >= 0 && highlightedBlockIndex < blocks.length
        ? blocks[highlightedBlockIndex]
        : undefined;
      const { visible, overflowLine } = this.applyOverflow(
        runningBlocks, queuedBlocks, finishedBlocks, ordered, maxBody, theme, pinnedBlock,
      );
      const visibleInDisplayOrder = this.orderBlocks(visible, ordered);
      const visIndex = pinnedBlock
        ? visibleInDisplayOrder.findIndex((block) => block.agent === pinnedBlock.agent)
        : -1;
      lines.push(...this.renderBlocks(visibleInDisplayOrder, visIndex, theme));
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

  /** Build individual RenderBlocks for queued agents. */
  private buildQueuedIndividualBlocks(
    queued: AgentRecord[], theme: Theme, w: number, layout: AgentColumnLayout,
  ): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    const statusDisplay = getAgentStatusDisplay("queued");
    for (const a of queued) {
      const name = padToVisibleWidth(getDisplayName(a.display.type), layout.nameWidth);
      const modelThinking = padToVisibleWidth(this.displayModelThinking(a, layout.modelThinkingWidth), layout.modelThinkingWidth);
      const desc = padToVisibleWidth(this.displayDescription(a, layout.descriptionWidth), layout.descriptionWidth);
      const header = `  ${theme.fg(statusDisplay.color, statusDisplay.icon)}${this.renderStartTime(a, theme, "dim")} ${theme.fg("dim", name)}${NAME_COLUMN_GAP}${this.renderModelThinkingColumn(modelThinking, theme, layout)}${theme.fg("dim", desc)}`;
      blocks.push({ agent: a, header: truncate(header), continuations: [] });
    }
    return blocks;
  }

  /** Order blocks according to the stable global manager order for this render. */
  private orderBlocks(blocks: RenderBlock[], orderedAgents: AgentRecord[]): RenderBlock[] {
    const positions = new Map(orderedAgents.map((agent, index) => [agent, index]));
    return [...blocks].sort((a, b) => positions.get(a.agent)! - positions.get(b.agent)!);
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

  /** Number of terminal rows consumed by a block in the current widget mode. */
  private blockHeight(block: RenderBlock): number {
    return 1 + block.continuations.length;
  }

  /** Return a block cut to the available terminal-row budget, retaining its header. */
  private truncateBlockToHeight(block: RenderBlock, maxHeight: number): RenderBlock | undefined {
    if (maxHeight < 1) return undefined;
    return { ...block, continuations: block.continuations.slice(0, maxHeight - 1) };
  }

  /**
   * Overflow logic — prioritize active (running/queued) blocks over finished ones.
   * Reserve a row for the overflow summary when doing so still leaves room for a
   * row header. A pinned block is shortened to the remaining budget so navigation
   * never exceeds the configured line limit.
   */
  private applyOverflow(
    runningBlocks: RenderBlock[],
    queuedBlocks: RenderBlock[],
    finishedBlocks: RenderBlock[],
    orderedAgents: AgentRecord[],
    maxBody: number,
    theme: Theme,
    pinned: RenderBlock | undefined = undefined,
  ): { visible: RenderBlock[]; overflowLine?: string } {
    const reserveOverflowLine = maxBody >= 2;
    let budget = maxBody - (reserveOverflowLine ? 1 : 0);
    let hiddenRunning = 0;
    let hiddenQueued = 0;
    let hiddenFinished = 0;
    const visible: RenderBlock[] = [];

    // Pin the highlighted block first (navigation mode), trimming continuation
    // rows if needed. The copied block still carries the same agent identity.
    if (pinned) {
      const visiblePinned = this.truncateBlockToHeight(pinned, budget);
      if (visiblePinned) {
        visible.push(visiblePinned);
        budget -= this.blockHeight(visiblePinned);
      }
    }

    const activeBlocks = this.orderBlocks([...runningBlocks, ...queuedBlocks], orderedAgents);
    const visibleActive: Array<{ source: RenderBlock; block: RenderBlock }> = [];

    // 1. Give every active block a header before spending rows on continuations.
    // This keeps a running or queued agent visible when its full block does not
    // fit, and prevents a finished row from displacing it.
    for (const b of activeBlocks) {
      if (b === pinned) continue; // already placed
      const headerOnly = this.truncateBlockToHeight(b, 1);
      if (headerOnly && budget >= 1) {
        visible.push(headerOnly);
        visibleActive.push({ source: b, block: headerOnly });
        budget--;
      } else if (b.agent.lifecycle.status === "running") {
        hiddenRunning++;
      } else {
        hiddenQueued++;
      }
    }

    // 2. Restore active continuations in stable global order before showing
    // finished blocks, without displacing another active header.
    for (const { source, block } of visibleActive) {
      const continuationCount = Math.min(source.continuations.length, budget);
      if (continuationCount === 0) continue;
      block.continuations = source.continuations.slice(0, continuationCount);
      budget -= continuationCount;
    }

    // 3. Finished blocks (lowest priority, in stable global order)
    for (const b of this.orderBlocks(finishedBlocks, orderedAgents)) {
      if (b === pinned) continue; // already placed
      const height = this.blockHeight(b);
      if (budget >= height) {
        visible.push(b);
        budget -= height;
      } else {
        hiddenFinished++;
      }
    }

    // Overflow summary line
    let overflowLine: string | undefined;
    if (reserveOverflowLine && hiddenRunning + hiddenQueued + hiddenFinished > 0) {
      const parts: string[] = [];
      if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
      if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
      if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
      const summary = `+${hiddenRunning + hiddenQueued + hiddenFinished} more (${parts.join(", ")})`;
      overflowLine = `  ${theme.fg("dim", summary)}`;
    }

    return { visible, overflowLine };
  }
  /** Clear widget and, unless retained for session history, the status bar. */
  private clearWidget(clearStatus = true) {
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
    if (clearStatus && this.lastStatusText !== undefined) {
      this.uiCtx?.setStatus(STATUS_KEY, undefined);
      this.lastStatusText = undefined;
    }
    // Note: timer is NOT cleared here. It keeps running so the widget
    // can re-register when agents appear again (e.g., after a steer
    // message triggers a new turn). The timer's update() call early-returns
    // when there are no agents, so there's no cost to keeping it alive.
  }

  /** Apply Pi's semantic footer text token, falling back for older/test UI contexts. */
  private styleStatusText(text: string): string {
    return this.uiCtx?.theme?.fg("dim", text) ?? text;
  }

  /** Update the status bar text, only if it changed. */
  private updateStatusBar(runningCount: number, queuedCount: number, running: AgentRecord[]) {
    const activeCount = runningCount + queuedCount;
    const totalCount = this.manager.getTotalAgentCount();
    const activeText = activeCount > 0 ? `${activeCount} active` : "";
    const totalText = `${totalCount} agent${totalCount === 1 ? "" : "s"} total`;
    let statusText = [activeText, totalText].filter(Boolean).join(" · ");
    if (this.showCost) {
      const sessionCost = this.manager.getTotalAgentCost();
      // Also include in-flight running agents (not yet completed, so not in accumulator)
      const runningCost = running.reduce((sum, a) => sum + a.stats.lifetimeUsage.cost, 0);
      const totalCost = sessionCost + runningCost;
      if (totalCost > 0) statusText += `: ${formatCost(totalCost)}`;
    }
    if (statusText !== this.lastStatusText) {
      this.uiCtx?.setStatus(STATUS_KEY, this.styleStatusText(statusText));
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

    // Nothing to render — retain the session summary after finished-record eviction.
    if (!hasActive && !hasFinished) {
      if (this.manager.getTotalAgentCount() > 0) {
        this.clearWidget(false);
        this.updateStatusBar(0, 0, []);
      } else if (this.widgetRegistered || this.lastStatusText !== undefined) {
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
            // Status text is rendered outside this widget, so restyle it explicitly.
            if (this.lastStatusText !== undefined) {
              this.uiCtx?.setStatus(STATUS_KEY, this.styleStatusText(this.lastStatusText));
            }
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
