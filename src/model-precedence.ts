/**
 * model-precedence.ts — Model resolution with explicit precedence.
 *
 * Pure function — no side effects, no file I/O, no pi SDK imports.
 *
 * Precedence chain (highest to lowest):
 *   1. config.agent[subagentType]  (per-type override)
 *   2. config.agent["default"]     (global default)
 *   3. agentConfig?.model          (agent config / frontmatter)
 *   4. parentModelId               (inherit from parent)
 */

/** Shape of the subagents-lite.json config file. */
export interface SubagentsConfig {
  agent: {
    default: string | null;
    [agentType: string]: string | null | undefined;
  };
  concurrency: {
    default: number;
    providers?: Record<string, number>;
    models?: Record<string, number>;
  };
}

/**
 * Resolve the model for a subagent invocation.
 *
 * Returns the first non-null, non-undefined, non-empty-string value
 * from the precedence chain. If all are empty/null, returns parentModelId.
 *
 * @param subagentType - The type of subagent being spawned
 * @param agentConfig - The agent's config (from .md frontmatter or defaults)
 * @param config - The global subagents-lite.json config (model overrides)
 * @param parentModelId - The parent agent's model ID (final fallback)
 * @returns The resolved model ID string
 */
export function resolveModel(
  subagentType: string,
  agentConfig: { model?: string } | undefined,
  config: SubagentsConfig,
  parentModelId: string,
): string {
  // Level 1: per-type override
  const perTypeOverride = config.agent[subagentType];
  if (isValidValue(perTypeOverride)) {
    return perTypeOverride;
  }

  // Level 2: global default override
  const globalDefault = config.agent["default"];
  if (isValidValue(globalDefault)) {
    return globalDefault;
  }

  // Level 3: agent config/frontmatter model
  if (agentConfig && isValidValue(agentConfig.model)) {
    return agentConfig.model;
  }

  // Level 4: parent model (final fallback)
  return parentModelId;
}

/**
 * Check if a value is a valid non-empty model string.
 * Returns true for non-null, non-undefined, non-empty strings.
 */
function isValidValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
