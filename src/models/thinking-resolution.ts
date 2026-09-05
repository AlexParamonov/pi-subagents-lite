/**
 * thinking-resolution.ts — The shared thinking precedence chain.
 *
 * No store access, no file I/O, no pi-coding-agent imports (pi-ai's
 * clampThinkingLevel is a pure helper). The spawn runtime and every display
 * surface call this so the chain cannot drift between them.
 *
 * Precedence (highest to lowest):
 *   1. explicit spawn param (Agent tool `thinking` / wizard selection)
 *   2. agent frontmatter `thinking`
 *   3. pi per-model modelThinkingLevels for the resolved model
 *   4. subagents-lite defaultThinking setting
 *   5. undefined → caller passes nothing; pi's own fallback applies
 *      (defaultThinkingLevel setting, else medium, clamped)
 *
 * Per-model sits above defaultThinking by design: defaultThinking exists to
 * override pi's global default, not a per-model choice.
 */

import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../types.js";

/** pi's fallback when defaultThinkingLevel is unset (mirrors pi's DEFAULT_THINKING_LEVEL). */
export const PI_FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

/** The inputs of the chain, in precedence order. Absent = source unset. */
export interface ThinkingLevelSources {
  explicit?: ThinkingLevel;
  frontmatter?: ThinkingLevel;
  perModel?: ThinkingLevel;
  defaultThinking?: ThinkingLevel;
}

/** The first defined source in precedence order; undefined when all are unset. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel | undefined {
  return sources.explicit ?? sources.frontmatter ?? sources.perModel ?? sources.defaultThinking;
}

/**
 * The spawn-effective thinking level as the display surfaces show it: the
 * precedence chain, then pi's global defaultThinkingLevel, then medium,
 * clamped to the model's supported levels (unclamped when the model is not
 * in the registry). The runtime counterpart deliberately stops at
 * resolveThinkingLevel — when it returns undefined, pi's session creation
 * applies this same fallback and clamp itself.
 */
export function resolveDisplayThinkingLevel(
  sources: ThinkingLevelSources,
  piDefaultThinking: ThinkingLevel | undefined,
  model: Model<any> | undefined,
): ThinkingLevel {
  const base = resolveThinkingLevel(sources) ?? piDefaultThinking ?? PI_FALLBACK_THINKING_LEVEL;
  return model ? clampThinkingLevel(model, base) : base;
}
