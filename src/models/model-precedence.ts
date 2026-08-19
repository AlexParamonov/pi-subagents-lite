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
import type { ModelThinkingPlacement } from "../config/types.js";

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
    /** Whether to show toolUses count in widget stats line. Default: false. */
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
    /** Whether to stream the agent transcript to the output file. Default: false. */
    outputTranscript?: boolean;
    /** When true, agent colors (spinner, status icons, picker bullets) are enabled. Default: true. */
    showAgentColors?: boolean;

    /** When > 0, thinking deltas stream to output file during message_update events. Default: 0 (disabled). */
    outputThinkingBufferSize?: number;
    /** Minutes to retain finished agents in the widget. Default: 1. */
    finishedRetentionMinutes?: number;
    /** Max settled agents the AgentStatus tool lists. 0 or absent = auto: 2 × default concurrency. */
    agentStatusLimit?: number;
    /** How to display the model label: short ID or full name. Default: 'name'. */
    modelDisplayStyle?: "id" | "name";
    /** Where model/thinking appears in full mode: 'header' (1st line) or 'metadata' (2nd line). Default: 'header'. */
    modelThinkingPlacement?: ModelThinkingPlacement;
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
 * Session-only model overrides: "default" plus per-agent-type entries.
 * Not persisted — cleared on session_start.
 */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

export interface ResolveModelOptions {
  /** The type of subagent being spawned. */
  subagentType: string;
  /** The agent's config (from .md frontmatter or defaults). */
  agentConfig?: { model?: string };
  /** The subagents-lite.json config (model overrides); only the agent section is read. */
  config: Pick<SubagentsConfig, "agent">;
  /** The parent agent's model ID (final fallback). */
  parentModelId: string;
  /** Session-only overrides (checked first). */
  sessionOverrides?: SessionModelOverrides;
}

/** Which chain position won resolution (see resolveModelSource). */
export type ModelSource =
  "session-per-type" | "session-default" | "config-per-type" | "config-default" | "frontmatter" | "parent";

/**
 * Resolve the model for a subagent invocation and report which chain
 * position won. resolveModel() is the model-only projection; callers that
 * need the winning layer (the Model settings menu's provenance tags) use
 * this instead of re-deriving precedence from the inputs.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain; parentModelId (always valid) is the final
 * fallback.
 */
export function resolveModelSource(options: ResolveModelOptions): { model: string; source: ModelSource } {
  const { subagentType, agentConfig, config, parentModelId, sessionOverrides } = options;

  // Cast agent values: index signature includes number (graceTurns), but models are always strings
  const candidates: Array<[ModelSource, string | null | undefined]> = [
    ["session-per-type", sessionOverrides?.[subagentType]],
    ["session-default", sessionOverrides?.["default"]],
    ["config-per-type", config.agent[subagentType] as string | null | undefined],
    ["config-default", config.agent["default"]],
    ["frontmatter", agentConfig?.model],
  ];
  for (const [source, value] of candidates) {
    if (isValidModelValue(value)) return { model: value, source };
  }
  // Parent model id is the final fallback (always a valid string).
  return { model: parentModelId, source: "parent" };
}

/**
 * Resolve the model for a subagent invocation — model-only projection of
 * resolveModelSource() for callers that do not need the winning source.
 */
export function resolveModel(options: ResolveModelOptions): string {
  return resolveModelSource(options).model;
}

/** True when the value is a usable model string (null/undefined/empty are unset). */
export function isValidModelValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
