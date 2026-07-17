/**
 * Type definitions for the subagent system.
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { LifetimeUsage, AgentUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation } from "./agents/types.js";

/** Thinking level for agent models (sourced from @earendil-works/pi-ai). */
export type ThinkingLevel = ModelThinkingLevel;

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
  onAssistantUsage?: (usage: AgentUsage) => void;
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
export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: "user" via UI menu, or "agent" via StopAgent tool. */
export type StopInitiator = "user" | "agent";

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /**
   * Whether the result has been read by the LLM (foreground return or background nudge).
   * cleanup() preserves terminal records until this is set, so a completed background
   * agent whose nudge hasn't fired yet isn't evicted before the LLM reads the result.
   */
  resultConsumed?: boolean;
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
  /** Previous input token count for delta estimation (vLLM doesn't report cache hits). */
  prevInputTokens?: number;
  /** Last-known context usage percentage (0–100), captured at completion. */
  contextPercent?: number | null;
}


