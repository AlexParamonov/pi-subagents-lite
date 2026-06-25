/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };

/**
 * A single per-turn usage event as emitted upstream. Adds `cacheRead`, which
 * LifetimeUsage omits from totals (see issue #38). Used to estimate input
 * deltas for providers like vLLM that don't report cache hits.
 */
export type AgentUsage = LifetimeUsage & { cacheRead: number };

/** Sum of lifetime usage components (including cost), or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite + u.cost : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cost += delta.cost;
}

/** Minimal shape we read from upstream `getSessionStats()`. */
type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/** Format a token count compactly: "12.3k", "1.2M", or raw number. When compact is true, thousands round to whole numbers. */
export function formatTokens(count: number, compact = false): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return compact ? `${Math.round(count / 1_000)}k` : `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/** Format cost as a dollar amount: "$0.00", "$0.01", "$1.23". */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
