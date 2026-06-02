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
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite + cost (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Final turn count (set on completion). Used by widget after activity cleanup. */
  turnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
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


