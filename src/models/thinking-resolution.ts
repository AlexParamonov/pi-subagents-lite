/**
 * thinking-resolution.ts — The shared thinking precedence chain.
 *
 * No store access, no file I/O, no pi-coding-agent imports (pi-ai's
 * clampThinkingLevel is a pure helper). The spawn runtime and every display
 * surface call this so the chain cannot drift between them.
 *
 * Precedence is the CONFIGURED_SOURCES table below: the explicit spawn param
 * sits above it, pi's own fallback below it. Per-model sits above
 * defaultThinking by design: defaultThinking exists to override pi's global
 * default, not a per-model choice.
 *
 * Any configurable position may hold `parent`, which resolves to the parent
 * session's current level: a value on that position, not a position of its own.
 * `parentLevel` is the parent's level; with none available a source holding
 * `parent` reads as unwritten and the chain continues.
 */

import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ThinkingChoice, ThinkingLevel } from "../types.js";

/** pi's fallback when defaultThinkingLevel is unset (mirrors pi's DEFAULT_THINKING_LEVEL). */
const PI_FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

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

/** The configured positions, in precedence order, each with the word it prints when it wins. */
const CONFIGURED_SOURCES = [
  ["frontmatter", "frontmatter"],
  ["perModel", "pi per-model"],
  ["defaultThinking", "subagent default"],
] as const satisfies ReadonlyArray<readonly [keyof DisplayThinkingSources, ThinkingSource]>;

/** The first configured source holding a level, with the word that explains it. */
function decideConfiguredSource(sources: ThinkingLevelSources): DisplayedThinking | undefined {
  for (const [key, word] of CONFIGURED_SOURCES) {
    const value = sources[key];
    const level = resolveValue(value, sources.parentLevel);
    if (level === undefined) continue;
    // Following the parent answers "why this level" better than naming the file.
    return { level, source: value === PARENT_THINKING_CHOICE ? "parent" : word };
  }
  return undefined;
}

/** The first source holding a level in precedence order; undefined when all are unset. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel | undefined {
  return resolveValue(sources.explicit, sources.parentLevel) ?? decideConfiguredSource(sources)?.level;
}

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
  const decided = decideConfiguredSource(sources) ?? {
    level: piDefaultThinking ?? PI_FALLBACK_THINKING_LEVEL,
    source: "pi default" as const,
  };
  return toDisplayed(model, decided.level, decided.source);
}

/**
 * `level` as `model` would run it: clamped to the model's supported levels,
 * unclamped when the model is not in the registry (nothing to clamp against).
 */
export function clampThinkingToModel(model: Model<any> | undefined, level: ThinkingLevel): ThinkingLevel {
  return model ? clampThinkingLevel(model, level) : level;
}

/** Builds the displayed pair from a winning level and its source word. */
function toDisplayed(model: Model<any> | undefined, level: ThinkingLevel, source: ThinkingSource): DisplayedThinking {
  return { level: clampThinkingToModel(model, level), source };
}

/** The row label for a displayed level: `high (frontmatter)`. */
export function formatDisplayedThinking(displayed: DisplayedThinking): string {
  return `${displayed.level} (${displayed.source})`;
}
