/**
 * format.ts — Consolidated display formatting helpers.
 *
 * Single source of truth for all display-formatting functions used across
 * the UI layer. Previously scattered across agent-widget.ts, output-file.ts,
 * and agent-types.ts by historical accident.
 *
 * Pure functions — no module-level state, no side effects.
 */

import { getConfig } from "../agents/agent-types.js";
import type { SubagentType, AgentInvocation } from "../agents/types.js";
import type { AgentStatus } from "../types.js";
import type { Theme } from "./types.js";
import { formatTokens, formatCost } from "../agents/usage.js";
import { parseThinkingLevel } from "../utils.js";
import { visibleWidth } from "@earendil-works/pi-tui";

/** Truncate a description string to `maxLen` characters, appending "..." if truncated. */
export function truncateDesc(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

/** Max length for a truncated command in tool arg summaries. */
const MAX_COMMAND_DISPLAY_LENGTH = 350;

/** Max length for a truncated string value in default tool arg summaries. */
const MAX_DEFAULT_STRING_DISPLAY_LENGTH = 350;

// ---- Usage formatting -----------------------------------------------------

/** Fields for Pi's contiguous usage block. */
export interface UsageDisplay {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  latestCacheHitRate?: number;
  cost?: number;
  usingSubscription?: boolean;
  contextPercent?: number | null;
  contextWindow?: number;
  autoCompactionEnabled?: boolean;
}

/** Individually addressable fields in the shared agent statistics display. */
export interface StatsCells {
  tools?: string;
  turns?: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
  hitRate?: string;
  cost?: string;
  context?: string;
  duration?: string;
}

type UsageCellName = "input" | "output" | "cacheRead" | "cacheWrite" | "hitRate" | "cost" | "context";
const USAGE_CELL_NAMES: UsageCellName[] = ["input", "output", "cacheRead", "cacheWrite", "hitRate", "cost", "context"];
const PLAIN_THEME: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * Build individually addressable agent stat cells. Keeping Pi footer fields
 * separate lets multi-agent displays align each metric without changing the
 * established single-row Pi sequence.
 */
export function buildStatsCells(
  args: UsageDisplay & {
    toolUses: number;
    turnCount?: number;
    maxTurns?: number;
    durationMs?: number;
  },
  theme: Theme,
  visible?: StatsVisibility,
): StatsCells {
  const cells: StatsCells = {};
  if (visible?.showTools !== false && args.toolUses > 0) cells.tools = `${args.toolUses}⚙︎`;
  if (visible?.showTurns !== false && args.turnCount != null) cells.turns = formatTurns(args.turnCount, args.maxTurns, theme);
  if (visible?.showInput !== false && args.input > 0) cells.input = `↑${formatTokens(args.input)}`;
  if (visible?.showOutput !== false && args.output > 0) cells.output = `↓${formatTokens(args.output)}`;
  if (visible?.showInput !== false) {
    if ((args.cacheRead ?? 0) > 0) cells.cacheRead = `R${formatTokens(args.cacheRead!)}`;
    if ((args.cacheWrite ?? 0) > 0) cells.cacheWrite = `W${formatTokens(args.cacheWrite!)}`;
    if (((args.cacheRead ?? 0) > 0 || (args.cacheWrite ?? 0) > 0) && args.latestCacheHitRate != null) {
      cells.hitRate = `CH${args.latestCacheHitRate.toFixed(1)}%`;
    }
  }
  if (visible?.showCost !== false && args.cost != null && (args.cost > 0 || args.usingSubscription)) {
    cells.cost = `${formatCost(args.cost)}${args.usingSubscription ? " (sub)" : ""}`;
  }
  if (visible?.showContext !== false && (args.contextPercent != null || args.contextWindow != null)) {
    const context = args.contextPercent == null ? "?" : `${args.contextPercent.toFixed(1)}%`;
    const display = `${context}/${formatTokens(args.contextWindow ?? 0)}${args.autoCompactionEnabled ? " (auto)" : ""}`;
    const color = args.contextPercent != null && args.contextPercent > 90
      ? "error"
      : args.contextPercent != null && args.contextPercent > 70 ? "warning" : undefined;
    cells.context = color ? theme.fg(color, display) : display;
  }
  if (visible?.showTime !== false && args.durationMs != null) cells.duration = formatMs(args.durationMs);
  return cells;
}

/** Format the exact contiguous Pi footer usage sequence. */
export function formatUsageBlock(args: UsageDisplay, visible?: StatsVisibility, theme?: Theme): string | undefined {
  // The usage cells do not need turn styling; use the supplied theme only for
  // Pi's warning/error context foreground when one is available.
  const cells = buildStatsCells({ ...args, toolUses: 0 }, theme ?? PLAIN_THEME, visible);
  const parts = USAGE_CELL_NAMES.map((name) => cells[name]).filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Shared widths for a set of widget stat rows. */
export interface StatsLayout {
  hasCounters: boolean;
  hasUsage: boolean;
  toolWidth: number;
  turnWidth: number;
  usageWidths: Record<UsageCellName, number>;
}

/** Compute ANSI- and wide-character-aware widths for aligned stat rows. */
export function buildStatsLayout(rows: StatsCells[]): StatsLayout {
  const usageWidths = Object.fromEntries(USAGE_CELL_NAMES.map((name) => [name, 0])) as Record<UsageCellName, number>;
  let toolWidth = 0;
  let turnWidth = 0;
  for (const row of rows) {
    toolWidth = Math.max(toolWidth, visibleWidth(row.tools ?? ""));
    turnWidth = Math.max(turnWidth, visibleWidth(row.turns ?? ""));
    for (const name of USAGE_CELL_NAMES) usageWidths[name] = Math.max(usageWidths[name], visibleWidth(row[name] ?? ""));
  }
  return {
    hasCounters: toolWidth > 0 || turnWidth > 0,
    hasUsage: USAGE_CELL_NAMES.some((name) => usageWidths[name] > 0),
    toolWidth,
    turnWidth,
    usageWidths,
  };
}

function padStatsCell(text: string | undefined, width: number, rightAlign = false): string {
  const padding = " ".repeat(Math.max(0, width - visibleWidth(text ?? "")));
  return rightAlign ? padding + (text ?? "") : (text ?? "") + padding;
}

/**
 * Render one structured stats row. Without a layout this is the compact,
 * single-row form. With one, counter cells are right-aligned and Pi cells are
 * padded by metric so the following duration column has a shared start.
 */
export function formatStatsRow(cells: StatsCells, layout?: StatsLayout): string | undefined {
  if (!layout) {
    const counters = [cells.tools, cells.turns].filter((cell): cell is string => cell !== undefined).join("  ");
    const usage = USAGE_CELL_NAMES.map((name) => cells[name]).filter((cell): cell is string => cell !== undefined).join(" ");
    const groups = [counters, usage, cells.duration].filter((group): group is string => group !== undefined && group.length > 0);
    return groups.length > 0 ? groups.join(" · ") : undefined;
  }

  const groups: string[] = [];
  if (layout.hasCounters) {
    const counters = layout.toolWidth > 0 && layout.turnWidth > 0
      ? `${padStatsCell(cells.tools, layout.toolWidth, true)}  ${padStatsCell(cells.turns, layout.turnWidth, true)}`
      : layout.toolWidth > 0 ? padStatsCell(cells.tools, layout.toolWidth, true) : padStatsCell(cells.turns, layout.turnWidth, true);
    groups.push(counters);
  }
  if (layout.hasUsage) {
    const usage = USAGE_CELL_NAMES
      .filter((name) => layout.usageWidths[name] > 0)
      .map((name) => padStatsCell(cells[name], layout.usageWidths[name]))
      .join(" ");
    groups.push(usage);
  }
  if (cells.duration !== undefined) groups.push(cells.duration);
  return groups.length > 0 ? groups.join(" · ") : undefined;
}

/** Format turn count with optional max limit. Shows max when >= 80% of limit. */
function formatTurns(turnCount: number, maxTurns: number | null | undefined, theme: Theme): string {
  if (maxTurns == null) return `${turnCount}⟳`;
  const ratio = turnCount / maxTurns;
  const text = ratio >= 0.8 ? `${turnCount}≤${maxTurns}⟳` : `${turnCount}⟳`;
  if (ratio >= 1) return theme.fg("error", text);
  if (ratio >= 0.8) return theme.fg("warning", text);
  return text;
}

// ---- Exported formatting functions ----

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

/** Visibility flags for stats parts. All default to true. */
export interface StatsVisibility {
  showTools?: boolean;
  showTurns?: boolean;
  showInput?: boolean;
  showOutput?: boolean;
  showContext?: boolean;
  showCost?: boolean;
  showTime?: boolean;
}

/**
 * Build common stats groups. Tools, turns, Pi usage, and duration are kept
 * separate so every caller can join the groups with ` · ` consistently.
 */
export function buildStatsParts(
  args: UsageDisplay & {
    toolUses: number;
    turnCount?: number;
    maxTurns?: number;
    durationMs?: number;
  },
  theme: Theme,
  visible?: StatsVisibility,
): string[] {
  const cells = buildStatsCells(args, theme, visible);
  const parts: string[] = [];
  if (cells.tools) parts.push(cells.tools);
  if (cells.turns) parts.push(cells.turns);
  const usage = USAGE_CELL_NAMES.map((name) => cells[name]).filter((part): part is string => part !== undefined).join(" ");
  if (usage) parts.push(usage);
  if (cells.duration) parts.push(cells.duration);
  return parts;
}

/** Get display name for any known agent type; retain an unknown type's raw label for display. */
export function getDisplayName(type: SubagentType): string {
  try {
    return getConfig(type).displayName;
  } catch {
    return type;
  }
}

/** Shared lifecycle icon and color used by agent views. */
export function getAgentStatusDisplay(status: AgentStatus): { icon: string; color: string } {
  switch (status) {
    case "running":
      return { icon: "◈", color: "accent" };
    case "queued":
      return { icon: "◇", color: "dim" };
    case "completed":
      return { icon: "✓", color: "success" };
    case "turn_limited":
      return { icon: "✓", color: "warning" };
    case "stopped":
      return { icon: "■", color: "dim" };
    case "error":
    case "aborted":
      return { icon: "✗", color: "error" };
  }
}

/**
 * Summarize tool arguments for log-friendly display.
 *
 * Heavy tools (read, write, edit, bash, grep, rg) get compact summaries.
 * Other tools fall back to the default JSON formatting.
 */
export function summarizeToolArgs(name: string, rawArgs: Record<string, unknown> | undefined): string {
  if (!rawArgs || typeof rawArgs !== "object" || Object.keys(rawArgs).length === 0) return "";

  switch (name) {
    case "read": {
      // read("/path/to/file") — just the path
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(path)})`;
    }
    case "write": {
      // write("/path/to/file", <N> chars) — path + content size
      const path = typeof rawArgs.file_path === "string" ? rawArgs.file_path : "";
      const content = rawArgs.content;
      const size = typeof content === "string" ? content.length : 0;
      return `(${JSON.stringify(path)}, ${size} chars)`;
    }
    case "edit": {
      // edit("/path/to/file", <N> edits) — path + edit count
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      const edits = rawArgs.edits;
      const editCount = Array.isArray(edits) ? edits.length : 0;
      return `(${JSON.stringify(path)}, ${editCount} edits)`;
    }
    case "bash": {
      // bash("command") — just the command, strip heredoc, truncate long
      const cmd = typeof rawArgs.command === "string" ? rawArgs.command : "";
      // Strip heredoc: truncate at << followed by delimiter
      const heredocIdx = cmd.search(/<<\s*['"]?\w+['"]?/);
      const cleanCmd = heredocIdx >= 0 ? cmd.slice(0, heredocIdx).trim() : cmd.trim();
      // Truncate long commands
      const display = cleanCmd.length > MAX_COMMAND_DISPLAY_LENGTH
        ? cleanCmd.slice(0, MAX_COMMAND_DISPLAY_LENGTH) + "…" : cleanCmd;
      return `(${JSON.stringify(display)})`;
    }
    case "grep":
    case "rg": {
      // grep("pattern", "/path") — pattern + path
      const pattern = typeof rawArgs.pattern === "string" ? rawArgs.pattern : "";
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(pattern)}, ${JSON.stringify(path)})`;
    }
    default: {
      // Default behavior for other tools: single-arg shorthand or JSON dump
      const keys = Object.keys(rawArgs);
      if (keys.length === 1) {
        const val = rawArgs[keys[0]];
        const display = typeof val === "string" && val.length > MAX_DEFAULT_STRING_DISPLAY_LENGTH
          ? JSON.stringify(val.slice(0, MAX_DEFAULT_STRING_DISPLAY_LENGTH) + "...")
          : JSON.stringify(val);
        return `(${display})`;
      }
      return ` ${JSON.stringify(rawArgs)}`;
    }
  }
}

/** Tool name to human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  rg: "searching",
  find: "searching",
};

/** Truncate text to a single line, max len chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "\u2026";
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
    return parts.join(", ") + "\u2026";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking\u2026";
}

/** Apply foreground styling while restoring it after nested ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, (reset) => `${reset}${styleStart}`));
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Format a concrete thinking level for display; omitted or inherited values have no tag. */
export function formatThinkingTag(value: unknown): string | undefined {
  const thinkingLevel = typeof value === "string" ? parseThinkingLevel(value) : undefined;
  return thinkingLevel;
}

/** Build invocation display tags from an AgentInvocation. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): { modelName?: string; thinkingTag?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: invocation.modelName,
    thinkingTag: formatThinkingTag(invocation.thinkingLevel),
    tags,
  };
}
