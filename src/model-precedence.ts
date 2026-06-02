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
