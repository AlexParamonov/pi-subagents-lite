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
 *
 * Any configurable position may hold `parent`, which resolves to the parent
 * session's current level: a value on that position, not a position of its own.
 * `parentLevel` is the parent's level; with none available a source holding
 * `parent` reads as unwritten and the chain continues.
 */

import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingChoice, ThinkingLevel } from "../types.js";

/** pi's fallback when defaultThinkingLevel is unset (mirrors pi's DEFAULT_THINKING_LEVEL). */
export const PI_FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

/** The value that makes a source follow the parent session's current Thinking level. */
export const PARENT_THINKING_CHOICE = "parent" satisfies ThinkingChoice;

/**
 * Picker entry that writes nothing, leaving the chain to decide. Named after the
 * source it lets win, so it is also the menu's "not set" display.
 */
export const PI_DEFAULT_CHOICE = "pi default";

/** The two entries every thinking picker offers after its levels, in order. */
export const THINKING_CHOICE_TAIL = [PARENT_THINKING_CHOICE, PI_DEFAULT_CHOICE] as const;

/** The inputs of the chain, in precedence order. Absent = source unset. */
export interface ThinkingLevelSources {
  explicit?: ThinkingChoice;
  frontmatter?: ThinkingChoice;
  /** pi's own per-model setting; pi validates it, so it holds concrete levels only. */
  perModel?: ThinkingLevel;
  defaultThinking?: ThinkingChoice;
  /**
   * The parent session's current level, for a source holding `parent`. Absent =
   * no parent level available, which makes that source read as unwritten.
   */
  parentLevel?: ThinkingLevel;
}

/**
 * What one written value resolves to. `parent` resolves to the parent's level,
 * so with no parent level available it reads as unwritten and the chain walks
 * on to the next source.
 */
function resolveValue(
  value: ThinkingChoice | undefined,
  parentLevel: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (value === PARENT_THINKING_CHOICE) return parentLevel;
  return value;
}

/** The first defined source in precedence order; undefined when all are unset. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel | undefined {
  const { parentLevel } = sources;
  return (
    resolveValue(sources.explicit, parentLevel) ??
    resolveValue(sources.frontmatter, parentLevel) ??
    resolveValue(sources.perModel, parentLevel) ??
    resolveValue(sources.defaultThinking, parentLevel)
  );
}

/**
 * The source that decided a displayed level, in the words the menus print.
 * `parent` names any position holding `parent`.
 */
export type ThinkingSource = "frontmatter" | "pi per-model" | "subagent default" | "parent" | "pi default";

/** A displayed level and the source that produced it. */
export interface DisplayedThinking {
  level: ThinkingLevel;
  source: ThinkingSource;
}

/** Sources the pre-spawn surfaces show: the chain without the explicit spawn param. */
type DisplayThinkingSources = Omit<ThinkingLevelSources, "explicit">;

/**
 * The displayed thinking level with its winning source: the chain, then pi's
 * global defaultThinkingLevel, then medium, clamped to the model's supported
 * levels (unclamped when the model is not in the registry).
 */
export function resolveDisplayedThinking(
  sources: DisplayThinkingSources,
  piDefaultThinking: ThinkingLevel | undefined,
  model: Model<any> | undefined,
): DisplayedThinking {
  const { parentLevel } = sources;
  // resolveThinkingLevel's chain minus `explicit`, which these surfaces never
  // hold; each position carries the word it prints when it wins.
  const candidates = [
    { value: sources.frontmatter, word: "frontmatter" },
    { value: sources.perModel, word: "pi per-model" },
    { value: sources.defaultThinking, word: "subagent default" },
  ] as const;
  for (const { value, word } of candidates) {
    const level = resolveValue(value, parentLevel);
    if (level === undefined) continue;
    // The question a user asks is why this level; when a source holds `parent`
    // the answer is that it follows the parent session, not which file said so.
    return toDisplayed(model, level, value === PARENT_THINKING_CHOICE ? "parent" : word);
  }
  return toDisplayed(model, piDefaultThinking ?? PI_FALLBACK_THINKING_LEVEL, "pi default");
}

/**
 * `level` as `model` would run it: clamped to the model's supported levels,
 * unclamped when the model is not in the registry (nothing to clamp against).
 */
export function clampThinkingToModel(model: Model<any> | undefined, level: ThinkingLevel): ThinkingLevel {
  return model ? clampThinkingLevel(model, level) : level;
}

/** A level as displayed, clamped to the model (unclamped when it's not in the registry). */
function toDisplayed(model: Model<any> | undefined, level: ThinkingLevel, source: ThinkingSource): DisplayedThinking {
  return { level: clampThinkingToModel(model, level), source };
}

/** The row label for a displayed level: `high (frontmatter)`. */
export function formatDisplayedThinking(displayed: DisplayedThinking): string {
  return `${displayed.level} (${displayed.source})`;
}
