/**
 * Type definitions for the subagent system.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { LifetimeUsage } from "./agents/usage.js";

/** Thinking level for agent models. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Tool activity event: start/end of a tool invocation. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

/**
 * Resolved model + run-limit tunables shared by every spawn/run shape
 * (RunOptions, SpawnOptions, SpawnIntent). Add a tunable here once and it
 * flows through the whole chain.
 */
export interface RunTunables {
  model?: Model<any>;
  maxTurns?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns?: number;
}

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** How the subagent system prompt is constructed. */
export type SystemPromptMode = "replace" | "inherit" | "custom";

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
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  /** Max output tokens per LLM response. Passed to provider as max_tokens or max_completion_tokens. */
  maxTokens?: number;
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
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  runInBackground?: boolean;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/**
 * Streaming/callback surface shared by RunOptions and SpawnOptions.
 * Bridges agent-runner events to record tracking and live-view updates.
 */
export interface RunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  description: string;
  modelKey?: string;
  worktreePath?: string;
  worktreeLabel?: string;
  invocation?: AgentInvocation;
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
  "systemPromptMode",
  "includeContextFiles",
  "defaultThinking",
  "defaultMaxTurns",
  "loadSkillsImplicitly",
  "loadExtensionsImplicitly",
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
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
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


