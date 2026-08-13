import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { LifetimeUsage, AgentUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation } from "./agents/types.js";

export type ThinkingLevel = ModelThinkingLevel;

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
  /** SDK tool call id; absent on synthetic events (e.g. extension-error end). */
  toolCallId?: string;
}

/** Widget live-view state: per-agent transient display data, fed by tool/stream callbacks. */
export interface LiveView {
  activeTools: Map<string, string>; // keyed by toolName_timestamp
  responseText: string;
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
  lifecycle: AgentLifecycle;
  display: AgentDisplayInfo;
  execution: AgentExecutionState;
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
  /**
   * Whether the subagent session treats the target project as trusted.
   * Absent/true = load project resources; false = ignore them (untrusted
   * cross-repo target, resolved by the trust gate).
   */
  projectTrusted?: boolean;
  invocation?: AgentInvocation;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionInfo {
  reason: CompactionReason;
  tokensBefore: number;
}

// --- Sub-object interfaces for decomposed AgentRecord ---

export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: "user" via UI menu, "agent" via StopAgent tool, or "watchdog" (stuck-agent detection). */
export type StopInitiator = "user" | "agent" | "watchdog";

/** Structured reason for a watchdog stop: which check fired, and the offending tool for tool kills. */
export type WatchdogStopDetail =
  { kind: "tool"; toolName: string; elapsedMs: number } | { kind: "idle"; elapsedMs: number };

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /** Reason detail for watchdog stops (tool name + elapsed). Absent for user/agent stops. */
  stopDetail?: WatchdogStopDetail;
  /**
   * Whether the agent ever started running. Set false at spawn, flipped true
   * synchronously in startAgent before the run — distinguishes never-started
   * stops from ran-then-stopped ones so the status note is accurate.
   */
  started: boolean;
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
  /**
   * Completion gate, created at spawn, opened exactly once at the terminal
   * transition; never the run's own promise.
   */
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
  /**
   * Model key the spawn reserved a concurrency slot for. Set at spawn; used
   * to re-reserve the slot when a settled agent is continued. Undefined when
   * the spawn had no model key (re-reservation is skipped entirely).
   */
  modelKey?: string;
  /**
   * Whether the run promise chain has fully settled (its .finally ran).
   * False at spawn and while a continuation is running; true after every
   * settlement. Guards continuation against racing settlement cleanup.
   */
  settled: boolean;
  /**
   * Number of settlements so far (first run = 1, each continuation run
   * increments). Written at the top of the shared settlement chain's
   * .finally, before the completion callback fires, so the coordinator can
   * tell a continuation settlement from the first one. Never-started stops
   * (queued stop, already-aborted spawn) never increment it.
   */
  settlementCount: number;
  /**
   * Spawning-session ExtensionContext, attached by the coordinator at spawn
   * for every spawn. Kept for the record's lifetime so the UI-notify
   * fallback can reach a live context on any later nudge (continuations of
   * foreground agents included). Dies with the record at Clear/dispose.
   */
  spawnCtx?: ExtensionContext;
  /**
   * Lifetime cost already added to the session total (tallyCompletion
   * baseline). Undefined until the first settlement; continuations add only
   * the delta since the last tally.
   */
  talliedCost?: number;
  /**
   * Widget live-view state, attached by the coordinator at spawn. Retained
   * across settlement so a continuation keeps feeding the same view.
   */
  liveView?: LiveView;
  /**
   * Coordinator-supplied live-view bridge (tool activity + streamed text),
   * captured at spawn and re-wired on continuation. Without it the widget
   * would show a static "thinking…" while a continued agent runs.
   */
  liveViewCallbacks?: Pick<RunCallbacks, "onToolActivity" | "onTextDelta">;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by widget (stats display), tool-execution (details building), menus (result viewer).
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output (see getLifetimeTotal; cacheRead/cacheWrite
   * and cost deliberately excluded — see issue #38). Initialized to zeros at spawn.
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
