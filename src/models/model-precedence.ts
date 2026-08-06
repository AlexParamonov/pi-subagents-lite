/**
 * model-precedence.ts — Model resolution with explicit precedence.
 *
 * Pure function — no side effects, no file I/O, no pi SDK imports.
 *
 * Precedence chain (highest to lowest):
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. sessionOverrides["default"]     (session global default)
 *   3. config.agent[subagentType]      (config per-type override)
 *   4. config.agent["default"]         (config global default)
 *   5. agentConfig?.model              (agent config / frontmatter)
 *   6. parentModelId                   (inherit from parent)
 */

import type { ThinkingLevel } from "../types.js";
import type { SystemPromptMode } from "../agents/types.js";

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  agent: {
    default: string | null;
    forceBackground: boolean;
    graceTurns?: number;
    showCost?: boolean;
    /** Stop an agent when a single tool call runs longer than this (minutes). 0 disables. Default: 45. */
    toolTimeoutMinutes?: number;
    /** Stop an agent showing no activity (tool events, streamed text) for this long (minutes). 0 disables. Default: 45. */
    idleTimeoutMinutes?: number;
    widgetMaxLines?: number;
    widgetMaxLinesCompact?: number;
    widgetCompact?: boolean;
    /** Show background completion cards in the TUI. Default: true. */
    showCompletionCards?: boolean;
    widgetShortcut?: boolean;
    /** System prompt mode: replace (default), inherit parent, or custom file. */
    systemPromptMode?: SystemPromptMode;
    /** Whether to include AGENTS.md context files in the subagent system prompt. Default: true. */
    includeContextFiles?: boolean;
    /** Default thinking level for spawned agents. Undefined = inherit from agent config. */
    defaultThinking?: ThinkingLevel;
    /** Default max turns for spawned agents. Undefined = unlimited. */
    defaultMaxTurns?: number;
    /** Global default for skills loading when agent doesn't explicitly set skills. true (default) or false. */
    loadSkillsImplicitly?: boolean;
    /** Global default for extensions loading when agent doesn't explicitly set extensions. true (default) or false. */
    loadExtensionsImplicitly?: boolean;
    /** When true, skip built-in default agents (general-purpose, Explore) at registration. */
    disableDefaultAgents?: boolean;
    /** When true, use strict-mode schema for the Agent tool. Costs more tokens due to nullable field encoding. */
    agentToolStrictMode?: boolean;
    /** Whether to show toolUses count in widget stats line. Default: true. */
    showTools?: boolean;
    /** Whether to show turn count in widget stats line. Default: true. */
    showTurns?: boolean;
    /** Whether to show input tokens in widget stats line. Default: true. */
    showInput?: boolean;
    /** Whether to show output tokens in widget stats line. Default: true. */
    showOutput?: boolean;
    /** Whether to show context percent and compactions in widget stats line. Default: true. */
    showContext?: boolean;
    /** Whether to show elapsed time in widget stats line. Default: true. */
    showTime?: boolean;
    /** Whether to write streaming JSON-lines transcript to .output file. Default: true. */
    outputTranscript?: boolean;
    /** Max description length in widget full mode. Default: 50. */
    widgetDescLengthFull?: number;
    /** Max description length in widget compact mode. Default: 30. */
    widgetDescLengthCompact?: number;
    /** When > 0, thinking deltas stream to output file during message_update events. Default: 0 (disabled). */
    outputThinkingBufferSize?: number;
    /** Minutes to retain finished agents in the widget. Default: 10. */
    finishedRetentionMinutes?: number;
    /** Turns to keep finished agents visible in the widget. 0 = disabled. Default: 4. */
    finishedEvictTurns?: number;
    /** How to display the model label: short ID or full name. Default: 'id'. */
    modelDisplayStyle?: "id" | "name";
    /** Status bar format: 'full' (default) or 'compact'. */
    statusBarFormat?: "full" | "compact";
    [agentType: string]: string | null | undefined | boolean | number;
  };
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}

/**
 * Shape of session-only model overrides.
 * Same as config.agent but without the forceBackground flag.
 * Not persisted — cleared on session_start.
 */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

/** Options for resolveModel. */
export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The global subagents-lite.json config (model overrides). */
  config: SubagentsConfig;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only overrides (checked first). */
  sessionOverrides?: SessionModelOverrides;
}

/**
 * Resolve the model for a subagent invocation.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain. If all are empty/null, returns parentModelId.
 */
export function resolveModel(options: ResolveModelOptions): string {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides } = options;

  // Precedence chain: session > config > frontmatter > parent
  // Cast agent values: index signature includes number (graceTurns), but models are always strings
  const candidates: Array<string | boolean | null | undefined> = [
    sessionOverrides?.[subagentType],
    sessionOverrides?.["default"],
    config.agent[subagentType] as string | null | undefined,
    config.agent["default"],
    agentConfig?.model,
    parentModelId, // final fallback (always a valid string)
  ];
  return candidates.find(isValidValue) ?? parentModelId;
}

/**
 * Check if a value is a valid non-empty model string.
 * Returns true for non-null, non-undefined, non-empty strings.
 */
function isValidValue(value: string | boolean | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
