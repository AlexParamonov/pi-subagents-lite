/**
 * Agent model/thinking resolution with explicit, shared precedence.
 *
 * Highest to lowest for both settings:
 *   1. explicit value for this spawn
 *   2. session override for this agent type
 *   3. persisted override for this agent type
 *   4. agent Markdown/frontmatter
 *   5. global default (session, then persisted)
 *   6. parent session value
 */

import type { ThinkingLevel } from "../types.js";
import type { SystemPromptMode } from "../agents/types.js";
import { parseThinkingLevel } from "../utils.js";

export type SettingSource =
  | "spawn"
  | "session-agent"
  | "config-agent"
  | "agent-md"
  | "session-global"
  | "config-global"
  | "parent";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  agent: {
    default: string | null;
    forceBackground: boolean;
    graceTurns?: number;
    showCost?: boolean;
    widgetMaxLines?: number;
    widgetMaxLinesCompact?: number;
    widgetCompact?: boolean;
    widgetShortcut?: boolean;
    systemPromptMode?: SystemPromptMode;
    includeContextFiles?: boolean;
    defaultThinking?: ThinkingLevel;
    defaultMaxTurns?: number;
    loadSkillsImplicitly?: boolean;
    loadExtensionsImplicitly?: boolean;
    disableDefaultAgents?: boolean;
    showTools?: boolean;
    showTurns?: boolean;
    showInput?: boolean;
    showOutput?: boolean;
    showContext?: boolean;
    showTime?: boolean;
    widgetNavHint?: boolean;
    widgetDescLengthFull?: number;
    widgetDescLengthCompact?: number;
    deltaInputTokens?: boolean;
    outputThinkingBufferSize?: number;
    finishedRetentionMinutes?: number;
    [agentType: string]: string | null | undefined | boolean | number;
  };
  /** Persisted per-agent thinking overrides. */
  thinkingOverrides?: Record<string, ThinkingLevel | null | undefined>;
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}

/** Session-only model overrides. `default` is the session global fallback. */
export interface SessionModelOverrides {
  default: string | null;
  [agentType: string]: string | null | undefined;
}

/** Session-only thinking overrides. `default` is the session global fallback. */
export interface SessionThinkingOverrides {
  default?: ThinkingLevel;
  [agentType: string]: ThinkingLevel | undefined;
}

export interface ResolveModelOptions {
  subagentType: string;
  explicitModel?: string;
  agentConfig?: { model?: string };
  config: SubagentsConfig;
  parentModelId: string;
  sessionOverrides?: SessionModelOverrides;
}

export interface ResolveThinkingOptions {
  subagentType: string;
  explicitThinking?: ThinkingLevel;
  agentConfig?: { thinkingLevel?: ThinkingLevel };
  config: SubagentsConfig;
  parentThinking?: ThinkingLevel;
  sessionOverrides?: SessionThinkingOverrides;
}

function firstDefined<T>(
  candidates: Array<{ value: T | null | undefined; source: SettingSource }>,
): ResolvedSetting<T> | undefined {
  for (const candidate of candidates) {
    if (candidate.value !== undefined && candidate.value !== null && candidate.value !== "") {
      return candidate as ResolvedSetting<T>;
    }
  }
  return undefined;
}

/** Resolve a model and retain the source for transparent UI display. */
export function resolveModelSetting(options: ResolveModelOptions): ResolvedSetting<string> {
  const { subagentType, explicitModel, agentConfig, config, parentModelId, sessionOverrides } = options;
  const candidates: Array<{ value: unknown; source: SettingSource }> = [
    { value: explicitModel, source: "spawn" },
    { value: sessionOverrides?.[subagentType], source: "session-agent" },
    { value: config.agent[subagentType], source: "config-agent" },
    { value: agentConfig?.model, source: "agent-md" },
    { value: sessionOverrides?.default, source: "session-global" },
    { value: config.agent.default, source: "config-global" },
    { value: parentModelId, source: "parent" },
  ];
  const resolved = candidates.find(
    (candidate): candidate is { value: string; source: SettingSource } =>
      typeof candidate.value === "string" && candidate.value.length > 0,
  );
  return resolved ?? { value: parentModelId, source: "parent" };
}

/** Backwards-compatible value-only model resolver. */
export function resolveModel(options: ResolveModelOptions): string {
  return resolveModelSetting(options).value;
}

/** Resolve thinking and retain its source. Undefined means the parent has no explicit level. */
export function resolveThinkingSetting(
  options: ResolveThinkingOptions,
): ResolvedSetting<ThinkingLevel | undefined> {
  const { subagentType, explicitThinking, agentConfig, config, parentThinking, sessionOverrides } = options;
  // Persisted config is parsed JSON and may contain values outside its
  // TypeScript shape. Validate those values at the precedence boundary so an
  // invalid saved override falls through instead of reaching the provider.
  const persistedAgentThinking = parseThinkingLevel(config.thinkingOverrides?.[subagentType]);
  const persistedDefaultThinking = parseThinkingLevel(config.agent.defaultThinking);
  return firstDefined<ThinkingLevel>([
    { value: explicitThinking, source: "spawn" },
    { value: sessionOverrides?.[subagentType], source: "session-agent" },
    { value: persistedAgentThinking, source: "config-agent" },
    { value: agentConfig?.thinkingLevel, source: "agent-md" },
    { value: sessionOverrides?.default, source: "session-global" },
    { value: persistedDefaultThinking, source: "config-global" },
    { value: parentThinking, source: "parent" },
  ]) ?? { value: undefined, source: "parent" };
}
