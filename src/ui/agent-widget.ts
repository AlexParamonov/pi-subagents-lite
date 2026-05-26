/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Ported from upstream pi-subagents. Adaptations:
 *   - buildInvocationTags removes inheritContext and isolation: "worktree" (fields
 *     we cut from AgentInvocation)
 *   - Import paths use relative imports within our extension
 *   - addUsage/getLifetimeTotal/getSessionContextPercent imported from ../usage.js
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, SubagentType } from "../types.js";
import { getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

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

/** Format a token count compactly: "33.8k", "1.2M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

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
export function formatSessionTokens(
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
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `${turnCount}≤${maxTurns}⟳ ` : `${turnCount}⟳ `;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "0.0s";
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/**
 * Build invocation tags from the invocation record.
 * Adapted from upstream: removed inheritContext and isolation: "worktree" checks
 * because our AgentInvocation doesn't have those fields.
 */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return { modelName: invocation.modelName, tags };
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
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
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
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();


  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: TUI | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

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
    const running: AgentInvocation[] = [];
    const queued: AgentInvocation[] = [];
    const finished: AgentInvocation[] = [];
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
  private finishedIconAndStatus(status: string, error?: string, theme?: Theme): { icon: string; statusText: string } {
    if (!theme) return { icon: "?", statusText: "" }; // should not happen
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

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);

    // Tool uses
    if (a.toolUses > 0) parts.push(`${a.toolUses}🛠 `);

    // Turn count — prefer activity (live), fall back to record (after cleanup)
    if (activity) {
      parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    } else if (a.turnCount != null) {
      parts.push(formatTurns(a.turnCount, a.maxTurns));
    }

    // Token usage with context % — read from record if activity was cleaned up
    const tokens = getLifetimeTotal(activity?.lifetimeUsage ?? a.lifetimeUsage);
    if (tokens > 0) {
      const contextPct = getSessionContextPercent(activity?.session ?? a.session);
      const tokenText = formatSessionTokens(tokens, contextPct, theme, a.compactionCount);
      parts.push(tokenText);
    }

    parts.push(duration);

    // Wrap stats in dim, re-applying after any ANSI reset from formatSessionTokens.
    const statsLine = parts.join("·");
    return `${icon} ${theme.fg("dim", name)}  ${theme.fg("dim", a.description)}  ${wrapInDim(theme, statsLine)}${statusText}`;
  }

  /** Build the stats line (toolUses · turns · tokens · elapsed) for a running agent. */
  private buildStatsLine(
    agent: { toolUses: number; compactionCount: number; startedAt: number },
    activity: AgentActivity | undefined,
    theme: Theme,
  ): string {
    const toolUses = activity?.toolUses ?? agent.toolUses;
    const elapsed = formatMs(Date.now() - agent.startedAt);

    const tokens = getLifetimeTotal(activity?.lifetimeUsage);
    const contextPercent = getSessionContextPercent(activity?.session);
    const tokenText = tokens > 0
      ? formatSessionTokens(tokens, contextPercent, theme, agent.compactionCount)
      : "";

    const parts: string[] = [];
    if (toolUses > 0) parts.push(`${toolUses}🛠 `);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (tokenText) parts.push(tokenText);
    parts.push(elapsed);
    return parts.join("·");
  }

  /** Build RenderBlocks for finished (completed/errored) agents. */
  private buildFinishedBlocks(
    finished: AgentInvocation[],
    theme: Theme,
    w: number,
  ): RenderBlock[] {
    const truncate = (line: string) => truncateToWidth(line, w);
    const blocks: RenderBlock[] = [];
    for (const a of finished) {
      blocks.push({
        header: truncate(theme.fg("dim", BRANCH) + " " + this.renderFinishedLine(a, theme)),
        continuations: a.outputFile
          ? [truncate(theme.fg("dim", `${VLINE}    tail -f ${a.outputFile}`))]
          : [],
      });
    }
    return blocks;
  }

  /** Build RenderBlocks for running agents. */
  private buildRunningBlocks(
    running: AgentInvocation[],
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

      blocks.push({
        header: truncate(`${BRANCH} ${theme.fg("accent", frame)} ${theme.bold(name)}  ${a.description}  ${statsLine}`),
        continuations: [
          ...(a.outputFile
            ? [truncate(`${VLINE}  ` + theme.fg("dim", `${VLINE} tail -f ${a.outputFile}`))]
            : []),
          truncate(`${VLINE}  ` + theme.fg("dim", `└ ${activity}`)),
        ],
      });
    }
    return blocks;
  }

  /** Build a single RenderBlock for queued agents, or undefined if none. */
  private buildQueuedBlock(
    queued: AgentInvocation[],
    theme: Theme,
    w: number,
  ): RenderBlock | undefined {
    if (queued.length === 0) return undefined;
    const truncate = (line: string) => truncateToWidth(line, w);
    return {
      header: truncate(theme.fg("dim", BRANCH) + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`),
      continuations: [],
    };
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

    // ---- Build blocks with placeholder connectors (BRANCH for headers, VLINE for continuations) ----
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

    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = blocks.reduce((sum, b) => sum + 1 + b.continuations.length, 0);

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

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
          return theme.fg("dim", CORNER) + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${parts.join(", ")})`)}`;
        })()
      : undefined;

    return { visible, overflowLine };
  }

  /** Clear widget, status bar, timer, and stale finished-turn-age entries. */
  private clearWidget() {
    if (this.widgetRegistered) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
    }
    if (this.lastStatusText !== undefined) {
      this.uiCtx.setStatus(STATUS_KEY, undefined);
      this.lastStatusText = undefined;
    }
    if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
    // Clean up stale entries
    const allAgents = this.manager.listAgents();
    for (const [id] of this.finishedTurnAge) {
      if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
    }
  }

  /** Update the status bar text, only if it changed. */
  private updateStatusBar(runningCount: number, queuedCount: number) {
    const statusParts: string[] = [];
    if (runningCount > 0) statusParts.push(`${runningCount} running`);
    if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
    const total = runningCount + queuedCount;
    const newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus(STATUS_KEY, newStatusText);
      this.lastStatusText = newStatusText;
    }
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const { running, queued, finished } = this.categorizeAgents();

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      this.clearWidget();
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    this.updateStatusBar(running.length, queued.length);

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
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined);
      this.uiCtx.setStatus(STATUS_KEY, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
