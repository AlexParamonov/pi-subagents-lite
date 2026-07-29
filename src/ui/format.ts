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
import type { AgentRecord } from "../types.js";
import type { Theme } from "./types.js";
import { formatTokens, formatCost } from "../agents/usage.js";

/** Truncate a description string to `maxLen` characters, appending "..." if truncated. */
export function truncateDesc(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

/** Max length for a truncated command in tool arg summaries. */
const MAX_COMMAND_DISPLAY_LENGTH = 350;

/** Max length for a truncated string value in default tool arg summaries. */
const MAX_DEFAULT_STRING_DISPLAY_LENGTH = 350;

// ---- Internal helpers (used by buildStatsParts) ----

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `↻ N` in dim.
 *
 *   "↑12k↓8k"                    — no annotations
 *   "↑12k↓8k 45%"                — percent only
 *   "↑12k↓8k ↻ 2"                 — compactions only (e.g. right after compact)
 *   "↑12k↓8k 45% ↻ 2"             — both
 */
export function formatSessionTokens(
  inputTokens: number,
  outputTokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenParts: string[] = [];
  if (inputTokens > 0) tokenParts.push(`↑${formatTokens(inputTokens, true)}`);
  if (outputTokens > 0) tokenParts.push(`↓${formatTokens(outputTokens, true)}`);
  const tokenStr = tokenParts.join("");
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `↻ ${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} ${annot.join(" ")}`;
}

/** Format turn count with optional max limit. Shows max when >= 80% of limit. */
function formatTurns(turnCount: number, maxTurns: number | null | undefined, theme: Theme): string {
  if (maxTurns == null) return `${turnCount}⟳ `;
  const ratio = turnCount / maxTurns;
  const text = ratio >= 0.8 ? `${turnCount}≤${maxTurns}⟳ ` : `${turnCount}⟳ `;
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
  showModel?: boolean;
  showThinking?: boolean;
}

/**
 * Build common stats parts: toolUses · turns · input↓ output with context % · cost · time.
 * Shared by AgentWidget and index.ts for consistent stats display.
 *
 * @param visible - Optional visibility flags. All default to true for backward compatibility.
 * @param durationMs - Optional duration in ms. When provided and showTime is not false, appends formatted time.
 */
export function buildStatsParts(
  args: {
    toolUses: number;
    turnCount?: number;
    maxTurns?: number;
    input: number;
    output: number;
    contextPercent: number | null;
    compactions: number;
    cost?: number;
    durationMs?: number;
  },
  theme: Theme,
  visible?: StatsVisibility,
): string[] {
  const parts: string[] = [];
  if (visible?.showTools !== false && args.toolUses > 0) parts.push(`${args.toolUses}🛠︎ `);
  if (visible?.showTurns !== false && args.turnCount != null) parts.push(formatTurns(args.turnCount, args.maxTurns, theme));
  if (visible?.showInput !== false || visible?.showOutput !== false) {
    const showIn = visible?.showInput !== false;
    const showOut = visible?.showOutput !== false;
    const inputTokens = showIn ? args.input : 0;
    const outputTokens = showOut ? args.output : 0;
    if (inputTokens > 0 || outputTokens > 0) {
      parts.push(formatSessionTokens(
        inputTokens, outputTokens,
        visible?.showContext !== false ? args.contextPercent : null,
        theme,
        visible?.showContext !== false ? args.compactions : 0,
      ));
    }
  }
  if (visible?.showCost !== false && args.cost != null && args.cost > 0) parts.push(formatCost(args.cost));
  if (visible?.showTime !== false && args.durationMs != null) parts.push(formatMs(args.durationMs));
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

/** Build invocation display tags from an AgentInvocation. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): string[] {
  const tags: string[] = [];
  if (!invocation) return [];
  if (invocation.thinkingLevel) tags.push(`thinking: ${invocation.thinkingLevel}`);
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return tags;
}

/** Build a parenthesized model/thinking tag for widget display.
 *
 * Returns `(modelName • thinkingLevel)`, one of them, or empty string
 * when neither is visible or data is undefined. Never returns `()`. */
export function buildModelThinkingTag(
  modelName: string | undefined,
  thinkingLevel: string | undefined,
  visible?: StatsVisibility,
): string {
  const showModel = visible?.showModel !== false;
  const showThinking = visible?.showThinking !== false;
  const model = showModel ? modelName?.trim() : undefined;
  const thinking = showThinking ? thinkingLevel?.trim() : undefined;
  const parts = [model, thinking].filter((p): p is string => p !== undefined && p.length > 0);
  return parts.length > 0 ? `(${parts.join(" • ")})` : "";
}

/** Pick the model label based on display style, trimming whitespace. Returns undefined for empty. */
export function resolveModelLabel(style: "id" | "name", labelName: string | undefined, labelId: string | undefined): string | undefined {
  const label = style === "name" ? labelName : labelId;
  return label?.trim() || undefined;
}

/** Resolve model label from an AgentRecord, preferring session model over invocation fallback. */
export function resolveAgentModelLabel(a: AgentRecord, style: "id" | "name"): string | undefined {
  const model = a.execution.session?.model;
  const label = model
    ? (style === "name" ? model.name : model.id)
    : a.display.invocation?.modelName;
  return label?.trim() || undefined;
}
