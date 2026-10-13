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

/** The first defined source in precedence order; undefined when all are unset. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel | undefined {
  const winner = firstWrittenSource(sources, CHAIN_POSITIONS);
  if (!winner) return undefined;
  return winner.value === "parent" ? sources.parentLevel : winner.value;
}

/** A chain position carrying a written value. */
interface WrittenSource<P extends string> {
  position: P;
  value: ThinkingChoice;
}

/** The positions the pre-spawn surfaces read; they hold no explicit spawn param to name. */
const DISPLAY_POSITIONS = ["frontmatter", "perModel", "defaultThinking"] as const;

/** The full chain, highest first. */
const CHAIN_POSITIONS = ["explicit", ...DISPLAY_POSITIONS] as const;

type ChainPosition = (typeof CHAIN_POSITIONS)[number];

/**
 * The winning chain position: the first written source in `positions`.
 * A source holding `parent` with no parent level available reads as unwritten,
 * so resolution continues to the next source.
 */
function firstWrittenSource<P extends ChainPosition>(
  sources: ThinkingLevelSources,
  positions: readonly P[],
): WrittenSource<P> | undefined {
  for (const position of positions) {
    const value = sources[position];
    if (value === undefined) continue;
    if (value === "parent" && sources.parentLevel === undefined) continue;
    return { position, value };
  }
  return undefined;
}

/**
 * The chain position that decided a displayed level, in the words the menus
 * print. `parent` names any position holding `parent`: the question a user asks
 * is why this level, and the answer is that it follows the parent session.
 */
export type ThinkingSource = "frontmatter" | "pi per-model" | "subagent default" | "parent" | "pi default";

/** A displayed level and the source that produced it. */
export interface DisplayedThinking {
  level: ThinkingLevel;
  source: ThinkingSource;
}

/** Sources the pre-spawn surfaces show: the chain without the explicit spawn param. */
export type DisplayThinkingSources = Omit<ThinkingLevelSources, "explicit">;

const SOURCE_WORDS: Record<(typeof DISPLAY_POSITIONS)[number], ThinkingSource> = {
  frontmatter: "frontmatter",
  perModel: "pi per-model",
  defaultThinking: "subagent default",
};

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
  const winner = firstWrittenSource(sources, DISPLAY_POSITIONS);
  if (winner) {
    const base = winner.value === "parent" ? sources.parentLevel! : winner.value;
    return {
      level: model ? clampThinkingLevel(model, base) : base,
      source: winner.value === "parent" ? "parent" : SOURCE_WORDS[winner.position],
    };
  }
  const base = piDefaultThinking ?? PI_FALLBACK_THINKING_LEVEL;
  return { level: model ? clampThinkingLevel(model, base) : base, source: "pi default" };
}

/** The row label for a displayed level: `high (frontmatter)`. */
export function formatDisplayedThinking(displayed: DisplayedThinking): string {
  return `${displayed.level} (${displayed.source})`;
}
