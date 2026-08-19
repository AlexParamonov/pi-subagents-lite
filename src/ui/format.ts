/**
 * format.ts — Consolidated display formatting helpers.
 *
 * Single source of truth for all display-formatting functions used across
 * the UI layer. Previously scattered across agent-widget.ts, output-file.ts,
 * and agent-types.ts by historical accident.
 *
 * Display formatting helpers with minimal runtime dependencies (config store, agent registry).
 *
 * Color-gated functions use applyAgentColor to check the showAgentColors toggle
 * via getStore() and disable agent-specific coloring globally.
 */

import { getAgentConfig } from "../agents/agent-types.js";
import { agentColorAnsi } from "../agent-color.js";
import { getStore } from "../shell.js";
import type { SubagentType, AgentInvocation } from "../agents/types.js";
import type { AgentRecord, AgentStatus } from "../types.js";
import type { Theme } from "./types.js";
import { formatTokens, formatCost } from "../agents/usage.js";
import type { ModelThinkingPlacement } from "../config/types.js";

// ---- Agent color toggle ----

/** Wrap text with an agent's ANSI color when showAgentColors is ON and a color is available.
 * @param text the text to wrap
 * @param ansiColor raw ANSI foreground code from agentColorAnsi()
 * @param fallback called when colors are off or no agent color is configured
 */
export function applyAgentColor(text: string, ansiColor: string, fallback: () => string): string {
  if (!getStore().agent.showAgentColors) return fallback();
  return ansiColor ? `${ansiColor}${text}\u001b[39m` : fallback();
}

// ---- Status icons ----

/** Single source of truth for per-agent status icons, shared by the tool call lines,
 * the subagent status widget, and the conversation viewer. */
const STATUS_ICON: Record<AgentStatus, { icon: string; color: "accent" | "success" | "warning" | "error" | "dim" }> = {
  queued: { icon: "◆", color: "accent" },
  running: { icon: "◈", color: "accent" },
  completed: { icon: "✓", color: "success" },
  turn_limited: { icon: "✓", color: "warning" },
  error: { icon: "✗", color: "error" },
  aborted: { icon: "✗", color: "error" },
  stopped: { icon: "■", color: "dim" },
};

/** Colored icon for an agent status, or a plain ▸ when no status is known yet.
 * When agentType has a configured color, the icon is tinted with that color
 * instead of the theme's status color. */
export function statusIcon(status: string | undefined, theme: Theme, agentType?: string): string {
  const entry = STATUS_ICON[status as AgentStatus];
  if (!entry) return "▸";
  return applyAgentColor(entry.icon, agentColorAnsi(agentType), () => theme.fg(entry.color, entry.icon));
}

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
 * Shared by the widget, viewer, and renderer for consistent stats display.
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
  if (visible?.showTurns !== false && args.turnCount != null)
    parts.push(formatTurns(args.turnCount, args.maxTurns, theme));
  if (visible?.showInput !== false || visible?.showOutput !== false) {
    const showIn = visible?.showInput !== false;
    const showOut = visible?.showOutput !== false;
    const inputTokens = showIn ? args.input : 0;
    const outputTokens = showOut ? args.output : 0;
    if (inputTokens > 0 || outputTokens > 0) {
      parts.push(
        formatSessionTokens(
          inputTokens,
          outputTokens,
          visible?.showContext !== false ? args.contextPercent : null,
          theme,
          visible?.showContext !== false ? args.compactions : 0,
        ),
      );
    }
  }
  if (visible?.showCost !== false && args.cost != null && args.cost > 0) parts.push(formatCost(args.cost));
  if (visible?.showTime !== false && args.durationMs != null) parts.push(formatMs(args.durationMs));
  return parts;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  const config = getAgentConfig(type);
  return config?.displayName ?? config?.name ?? "Agent";
}

/** Colored bullet prefix for agent names in pickers/menus.
 * Returns "• " with agent color when showAgentColors is ON and agent has a configured color,
 * or empty string when colors are off or agent has no color. */
export function agentBulletPrefix(agentType: string | undefined): string {
  const bullet = applyAgentColor("•", agentColorAnsi(agentType), () => "");
  return bullet ? `${bullet} ` : "";
}

/** Wrap text with agent color when showAgentColors is ON and agent has a configured color.
 * Returns plain text when colors are off, agent has no color, or agentType is undefined. */
export function agentColoredText(text: string, agentType: string | undefined): string {
  return applyAgentColor(text, agentColorAnsi(agentType), () => text);
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

  // No tools active — show first line of response text if available
  if (responseText && responseText.trim().length > 0) {
    const firstLine = responseText.trim().split("\n")[0] ?? "";
    return firstLine;
  }

  return "thinking\u2026";
}

/** Apply foreground styling while restoring it after nested ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(
    color,
    text.replace(/\u001b\[(?:0|39)m/g, (reset) => `${reset}${styleStart}`),
  );
}

export function buildInvocationTags(invocation: AgentInvocation | undefined): string[] {
  const tags: string[] = [];
  if (!invocation) return [];
  if (invocation.thinkingLevel) tags.push(`thinking: ${invocation.thinkingLevel}`);
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return tags;
}

/** Build the visible model/thinking parts (no parentheses) for widget display.
 *
 * Returns `[modelName, thinkingLevel]` (empty entries dropped), or `[]`
 * when neither is visible or data is undefined. */
export function buildModelThinkingParts(
  modelName: string | undefined,
  thinkingLevel: string | undefined,
  visible?: StatsVisibility,
): string[] {
  const showModel = visible?.showModel !== false;
  const showThinking = visible?.showThinking !== false;
  const model = showModel ? modelName?.trim() : undefined;
  const thinking = showThinking ? thinkingLevel?.trim() : undefined;
  return [model, thinking].filter((p): p is string => p !== undefined && p.length > 0);
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
  const parts = buildModelThinkingParts(modelName, thinkingLevel, visible);
  return parts.length > 0 ? `(${parts.join(" • ")})` : "";
}

/** Pick the model label based on display style, trimming whitespace. Returns undefined for empty. */
export function resolveModelLabel(
  style: "id" | "name",
  labelName: string | undefined,
  labelId: string | undefined,
): string | undefined {
  const label = style === "name" ? labelName : labelId;
  return label?.trim() || undefined;
}

/** Resolve model label from an AgentRecord, preferring session model over invocation fallback. */
export function resolveAgentModelLabel(a: AgentRecord, style: "id" | "name"): string | undefined {
  const model = a.execution.session?.model;
  if (model) return resolveModelLabel(style, model.name, model.id);
  return a.display.invocation?.modelName?.trim() || undefined;
}

export function resolveAgentModelThinking(a: AgentRecord, style: "id" | "name"): { model?: string; thinking?: string } {
  const model = resolveAgentModelLabel(a, style);
  const thinking = a.execution.session?.thinkingLevel ?? a.display.invocation?.thinkingLevel;
  return { model, thinking };
}

/** Build metadata line parts for an agent record.
 * Model/thinking is included (bare format, no parentheses) only when
 * modelThinkingPlacement is "metadata". With "header" placement it stays
 * in the widget header line.
 */
export function buildMetadataLineParts(
  a: AgentRecord,
  modelDisplayStyle: "id" | "name",
  statsVisibility?: StatsVisibility,
  modelThinkingPlacement: ModelThinkingPlacement = "header",
): string[] {
  const parts: string[] = [];

  if (modelThinkingPlacement === "metadata") {
    const { model, thinking } = resolveAgentModelThinking(a, modelDisplayStyle);
    const modelThinkingParts = buildModelThinkingParts(model, thinking, statsVisibility);
    if (modelThinkingParts.length > 0) {
      parts.push(modelThinkingParts.join(" • "));
    }
  }

  if (a.display.worktreeLabel) parts.push(`@${a.display.worktreeLabel}`);

  if (a.display.outputFile) parts.push(`tail -f ${a.display.outputFile}`);

  return parts;
}
