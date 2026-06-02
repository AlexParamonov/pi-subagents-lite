/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentRecord, SubagentType } from "../types.js";
import {
  formatCost,
  formatTokens,
  getLifetimeTotal,
  getSessionContextPercent,
  type LifetimeUsage,
  type SessionLike,
} from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const DEFAULT_MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Non-success statuses — used for linger behavior and icon rendering. */
const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tree-drawing connectors used in the widget header/continuation lines. */
const BRANCH = "├─";
const CORNER = "└─";
const VLINE = "│";

/** Widget key used with setWidget(). */
const WIDGET_KEY = "agents";

/** Status bar key used with setStatus(). */
const STATUS_KEY = "subagents";

/** Widget refresh interval in milliseconds. */
const WIDGET_REFRESH_INTERVAL = 80;

/** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
const ERROR_LINGER_TURNS = 2;

/** Default activity text when no tools are active and no response text. */
const THINKING_TEXT = "thinking…";

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic?: (text: string) => string;
};

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
}

/** A visual block: one header line plus zero or more continuation lines. */
interface RenderBlock {
  header: string;
  continuations: string[];
}

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
}



// ---- Formatting helpers ----

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `↻ N` in dim.
 *
 *   "12.3k"                     — no annotations
 *   "12.3k(45%)"                — percent only
 *   "12.3k(↻ 2)"                 — compactions only (e.g. right after compact)
 *   "12.3k(45%·↻ 2)"             — both
 */
function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `↻ ${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  // Include closing paren in the last annotation's color span to prevent
  // ANSI reset from leaving `)` in default color when wrapped in outer dim.
  const lastIdx = annot.length - 1;
  annot[lastIdx] += ")";
  return `${tokenStr}(${annot.join("·")}`;
}

/** Format turn count with optional max limit: "5≤30⟳" or "5⟳". */
function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `${turnCount}≤${maxTurns}⟳ ` : `${turnCount}⟳ `;
}

/** Format milliseconds as a compact human-readable duration: "1h 1m 1s", "5m 37s", "10s", "<1s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/**
 * Build common stats parts: toolUses · turns · tokens with context % · cost.
 * Shared by AgentWidget and index.ts for consistent stats display.
 */
export function buildStatsParts(
  args: {
    toolUses: number;
    turnCount?: number;
    maxTurns?: number;
    tokens: number;
    contextPercent: number | null;
    compactions: number;
    cost?: number;
  },
  theme: Theme,
): string[] {
  const parts: string[] = [];
  if (args.toolUses > 0) parts.push(`${args.toolUses}🛠 `);
  if (args.turnCount != null) parts.push(formatTurns(args.turnCount, args.maxTurns));
  if (args.tokens > 0) {
    parts.push(formatSessionTokens(
      args.tokens, args.contextPercent, theme, args.compactions,
    ));
  }
  if (args.cost != null && args.cost > 0) parts.push(formatCost(args.cost));
  return parts;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

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

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return THINKING_TEXT;
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Finished agents: agent ID → turns since finished. */
  private finishedTurnAge = new Map<string, number>();

  /** Whether to show cost in stats and status bar. */
  private showCost = false;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
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

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  /** Set whether to show cost in stats and status bar. */
  setShowCost(enabled: boolean) {
    this.showCost = enabled;
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

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), WIDGET_REFRESH_INTERVAL);
    }
  }

  /** Categorize all agents into running, queued, and visible finished groups. */
  private categorizeAgents() {
    const allAgents = this.manager.listAgents();
    const running: AgentRecord[] = [];
    const queued: AgentRecord[] = [];
    const finished: AgentRecord[] = [];
    for (const a of allAgents) {
      if (a.status === "running") running.push(a);
      else if (a.status === "queued") queued.push(a);
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) finished.push(a);
    }
    return { running, queued, finished };
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
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
      case "steered":
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
  private renderFinishedLine(a: {
    id: string; type: SubagentType; status: string; description: string;
    toolUses: number; startedAt: number; completedAt?: number; error?: string;
    compactionCount: number; lifetimeUsage: LifetimeUsage;
    turnCount?: number; maxTurns?: number; session?: SessionLike;
    outputFile?: string;
  }, theme: Theme): string {
    const name = getDisplayName(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);
    const { icon, statusText } = this.finishedIconAndStatus(a.status, a.error, theme);

    const activity = this.agentActivity.get(a.id);
    const usage = activity?.lifetimeUsage ?? a.lifetimeUsage;
    const statsParts = buildStatsParts({
      toolUses: a.toolUses,
      turnCount: activity?.turnCount ?? a.turnCount,
      maxTurns: activity?.maxTurns ?? a.maxTurns,
      tokens: getLifetimeTotal(usage),
      contextPercent: getSessionContextPercent(activity?.session ?? a.session),
      compactions: a.compactionCount,
      cost: this.showCost ? usage.cost : undefined,
    }, theme);
    statsParts.push(duration);

    const statsLine = statsParts.join("·");
    return `${icon} ${theme.fg("dim", name)}  ${theme.fg("dim", a.description)}  ${wrapInDim(theme, statsLine)}${statusText}`;
  }

  /** Build the stats line (toolUses · turns · tokens · cost · elapsed) for a running agent. */
  private buildStatsLine(
    agent: { toolUses: number; compactionCount: number; startedAt: number },
    activity: AgentActivity | undefined,
    theme: Theme,
  ): string {
    const parts = buildStatsParts({
      toolUses: activity?.toolUses ?? agent.toolUses,
      turnCount: activity?.turnCount,
      maxTurns: activity?.maxTurns,
      tokens: getLifetimeTotal(activity?.lifetimeUsage),
      contextPercent: getSessionContextPercent(activity?.session),
      compactions: agent.compactionCount,
      cost: this.showCost ? activity?.lifetimeUsage?.cost : undefined,
    }, theme);
    parts.push(formatMs(Date.now() - agent.startedAt));
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
      blocks.push({
        header: truncate(`${theme.fg("dim", BRANCH)} ${this.renderFinishedLine(a, theme)}`),
        continuations: a.outputFile
          ? [truncate(theme.fg("dim", `${VLINE}    tail -f ${a.outputFile}`))]
          : [],
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
      const name = getDisplayName(a.type);
      const bg = this.agentActivity.get(a.id);
      const statsLine = this.buildStatsLine(a, bg, theme);
      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : THINKING_TEXT;

      if (this.isCompact()) {
        // Compact: single line with activity inline, truncated description
        const desc = a.description.length > 30 ? a.description.slice(0, 27) + "..." : a.description;
        const headerLine = `${BRANCH} ${theme.fg("accent", frame)} ${theme.bold(name)}  ${desc}  ${statsLine}  ${theme.fg("dim", activity)}`;
        blocks.push({
          header: truncate(headerLine),
          continuations: [],
        });
      } else {
        // Full: header + continuation lines
        const headerLine = `${BRANCH} ${theme.fg("accent", frame)} ${theme.bold(name)}  ${a.description}  ${statsLine}`;
        blocks.push({
          header: truncate(headerLine),
          continuations: [
            ...(a.outputFile
              ? [truncate(`${VLINE}  ` + theme.fg("dim", `${VLINE} tail -f ${a.outputFile}`))]
              : []),
            truncate(`${VLINE}  ` + theme.fg("dim", `└ ${activity}`)),
          ],
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
    const header = `${theme.fg("dim", BRANCH)} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`;
    return { header: truncate(header), continuations: [] };
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   *
   * Strategy: build a list of RenderBlocks with placeholder connectors (BRANCH / VLINE),
   * determine which blocks are visible (overflow logic), then render with correct
   * connectors in a single pass. Last visible block gets CORNER + spaces, all others
   * keep BRANCH + VLINE.
   */
  /** Whether the widget should render in compact mode. */
  private isCompact(): boolean {
    return this.forceCompact || (this.widgetShortcut && this.compactMode);
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
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build blocks with placeholder connectors (BRANCH for headers, VLINE for continuations)
    // Separate arrays so overflow logic can apply priority: running > queued > finished.
    const finishedBlocks = this.buildFinishedBlocks(finished, theme, w);
    const runningBlocks = this.buildRunningBlocks(running, theme, w, frame);
    const queuedBlock = this.buildQueuedBlock(queued, theme, w);

    // All blocks in display order: finished → running → queued.
    const blocks: RenderBlock[] = [
      ...finishedBlocks,
      ...runningBlocks,
      ...(queuedBlock ? [queuedBlock] : []),
    ];

    // ---- Overflow logic (works with blocks, not lines) ----

    const maxBodyLines = this.isCompact() ? this.maxLinesCompact : this.maxLines;
    const maxBody = maxBodyLines - 1; // heading takes 1 line
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.continuations.length, 0);

    const heading = `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`;
    const lines: string[] = [truncate(heading)];

    if (totalBody <= maxBody) {
      // Everything fits — render all blocks with correct connectors.
      lines.push(...this.renderBlocks(blocks));
    } else {
      const { visible, overflowLine } = this.applyOverflow(
        runningBlocks, queuedBlock, finishedBlocks, maxBody, theme,
      );
      lines.push(...this.renderBlocks(visible));
      if (overflowLine) lines.push(truncate(overflowLine));
    }

    return lines;
  }

  /**
   * Render a single block: replace placeholder BRANCH→CORNER and VLINE→space on the last block.
   */
  private renderBlock(block: RenderBlock, isLast: boolean): string[] {
    const header = isLast ? block.header.replace(BRANCH, CORNER) : block.header;
    const continuations = isLast
      ? block.continuations.map(c => c.replace(VLINE, " "))
      : block.continuations;
    return [header, ...continuations];
  }

  /** Render a list of blocks with correct last-block connectors. */
  private renderBlocks(blocks: RenderBlock[]): string[] {
    return blocks.flatMap((b, i) => this.renderBlock(b, i === blocks.length - 1));
  }

  /**
   * Overflow logic — prioritize running > queued > finished.
   * Reserve 1 line for the overflow summary indicator.
   */
  private applyOverflow(
    runningBlocks: RenderBlock[],
    queuedBlock: RenderBlock | undefined,
    finishedBlocks: RenderBlock[],
    maxBody: number,
    theme: Theme,
  ): { visible: RenderBlock[]; overflowLine?: string } {
    let budget = maxBody - 1;
    let hiddenRunning = 0;
    let hiddenFinished = 0;
    const visible: RenderBlock[] = [];

    // 1. Running blocks (highest priority)
    for (const b of runningBlocks) {
      const height = 1 + b.continuations.length;
      if (budget >= height) {
        visible.push(b);
        budget -= height;
      } else {
        hiddenRunning++;
      }
    }

    // 2. Queued block
    if (queuedBlock && budget >= 1) {
      visible.push(queuedBlock);
      budget--;
    }

    // 3. Finished blocks (lowest priority)
    for (const b of finishedBlocks) {
      if (budget >= 1) {
        visible.push(b);
        budget--;
      } else {
        hiddenFinished++;
      }
    }

    // Overflow summary line
    const overflowLine = hiddenRunning + hiddenFinished > 0
      ? (() => {
          const parts: string[] = [];
          if (hiddenRunning > 0) parts.push(`${hiddenRunning} running`);
          if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
          const summary = `+${hiddenRunning + hiddenFinished} more (${parts.join(", ")})`;
          return `${theme.fg("dim", CORNER)} ${theme.fg("dim", summary)}`;
        })()
      : undefined;

    return { visible, overflowLine };
  }

  /** Clear widget, status bar, timer, and stale finished-turn-age entries. */
  private clearWidget() {
    if (this.widgetRegistered) {
      this.uiCtx?.setWidget(WIDGET_KEY, undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.lastStatusText !== undefined) {
      this.uiCtx?.setStatus(STATUS_KEY, undefined);
      this.lastStatusText = undefined;
    }
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    // Clean up stale entries
    const allAgents = this.manager.listAgents();
    for (const [id] of this.finishedTurnAge) {
      if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
    }
  }

  /** Update the status bar text, only if it changed. */
  private updateStatusBar(runningCount: number, queuedCount: number, running: AgentRecord[]) {
    const total = runningCount + queuedCount;
    let statusText = total > 0 ? `${total} agent${total === 1 ? "" : "s"}` : `agents`;
    if (this.showCost) {
      const sessionCost = this.manager.getTotalAgentCost();
      // Also include in-flight running agents (not yet completed, so not in accumulator)
      const runningCost = running.reduce((sum, a) => sum + a.lifetimeUsage.cost, 0);
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

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      this.clearWidget();
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
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
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
    this.lastStatusText = undefined;
  }
}
