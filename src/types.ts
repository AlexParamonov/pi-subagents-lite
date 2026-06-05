/**
 * Type definitions for the subagent system.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

/** Thinking level for agent models. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Tools to register with the session (controls availability, not LLM visibility). */
  registeredTools?: string[];
  /**
   * Controls which tool schemas the LLM sees. Can reference built-in tools
   * and extension tools. true = all, string[] = listed, false = none.
   * Supports ext/* syntax to include all tools from an extension.
   * Mutually exclusive with excludeTools.
   */
  tools?: true | string[] | false;
  /** Tool blacklist — all tools except these are visible. Mutually exclusive with tools (when tools is string[]). */
  excludeTools?: string[];
  /** true = inherit all, string[] = only listed, false = none. Mutually exclusive with excludeExtensions. */
  extensions: true | string[] | false;
  /** Extension blacklist — all extensions except these load. Mutually exclusive with extensions (when extensions is string[]). */
  excludeExtensions?: string[];
  /** Whitelist of allowed skills (metadata only in system prompt). true = all, string[] = listed, false = none */
  skills: true | string[] | false;
  /** Skills to preload with full content into system prompt. string[] = listed, false/undefined = none */
  preloadSkills?: string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  systemPrompt: string;

  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** true = agent is hidden from the schema enum but can still be called by name. */
  hidden?: boolean;
  /** Where this agent was loaded from */
  source?: "project" | "global";
}

export interface AgentRecord {
  id: string;
  result?: string;
  error?: string;
  /** Lifecycle state: status, timestamps. */
  lifecycle: AgentLifecycle;
  /** Display-oriented info: type, description, output file, invocation. */
  display: AgentDisplayInfo;
  /** Execution internals: session, abort controller, pending steers. */
  execution: AgentExecutionState;
  /** Accumulated statistics: usage, tool uses, turns. */
  stats: AgentAccumulatedStats;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  runInBackground?: boolean;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

/**
 * Theme for terminal rendering — used by format.ts, renderer.ts, and UI widgets.
 * Defined here (not in ui/agent-widget.ts) so non-UI modules can import it
 * without depending on the UI layer.
 */
export type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic?: (text: string) => string;
};

/** Non-model keys in config.agent — preserved when clearing all overrides. */
export const CONFIG_AGENT_NON_MODEL_KEYS = [
  "default",
  "forceBackground",
  "graceTurns",
  "showCost",
  "widgetMaxLines",
  "widgetMaxLinesCompact",
  "widgetCompact",
  "widgetShortcut",
];

/** Reason for a context compaction event. */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** Info payload emitted when a session compacts successfully. */
export interface CompactionInfo {
  reason: CompactionReason;
  tokensBefore: number;
}

// ---------------------------------------------------------------------------
// Sub-object interfaces for decomposed AgentRecord
// ---------------------------------------------------------------------------

/** Possible agent lifecycle statuses. */
export type AgentStatus = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
}

/**
 * Display-oriented fields: type name, description, output file, invocation params.
 * Used by widget (rendering), menus (listing), renderer (display).
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Resolved absolute path of the worktree this agent is running in. */
  worktreePath?: string;
  /** Short display label for the worktree (e.g., "feature" or "feature/packages/web"). */
  worktreeLabel?: string;
}

/**
 * Execution internals: session handle, abort controller, pending steers.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
export interface AgentExecutionState {
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by widget (stats display), tool-execution (details building), menus (result viewer).
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite + cost (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  toolUses: number;
  /** Final turn count (set on completion). Used by widget after activity cleanup. */
  turnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Last-known context usage percentage (0–100), captured at completion. */
  contextPercent?: number | null;
}


