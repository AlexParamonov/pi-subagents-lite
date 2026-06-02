/**
 * format.ts — Consolidated display formatting helpers.
 *
 * Single source of truth for all display-formatting functions used across
 * the UI layer. Previously scattered across agent-widget.ts, output-file.ts,
 * and agent-types.ts by historical accident.
 *
 * Pure functions — no module-level state, no side effects.
 */

import { getConfig } from "./agent-types.js";
import type { SubagentType, Theme } from "./types.js";
import { formatTokens, formatCost } from "./usage.js";

/** Max length for a truncated command in tool arg summaries. */
const MAX_COMMAND_DISPLAY_LENGTH = 100;

/** Max length for a truncated string value in default tool arg summaries. */
const MAX_DEFAULT_STRING_DISPLAY_LENGTH = 200;

// ---- Internal helpers (used by buildStatsParts) ----

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
