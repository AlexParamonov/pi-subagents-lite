/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Billable token usage accumulated from `message_end` events. Cache reads are
 * tracked separately on AgentAccumulatedStats so their Pi display total can be
 * maintained without changing this long-standing lifetime usage shape.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };

/**
 * A single per-turn usage event as emitted upstream. Adds `cacheRead`, which
 * LifetimeUsage omits from totals (see issue #38). Used to estimate input
 * deltas for providers like vLLM that don't report cache hits.
 */
export type AgentUsage = LifetimeUsage & { cacheRead: number };

/** Sum of lifetime token components (never dollar cost), or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cost += delta.cost;
}

/** Minimal session surface used by UI accounting. Methods are optional for test doubles. */
export type SessionLike = {
  getSessionStats?: () => { contextUsage?: { percent: number | null; contextWindow?: number } };
  getContextUsage?: () => { percent: number | null; contextWindow: number } | undefined;
  autoCompactionEnabled?: boolean;
  model?: { provider?: string; contextWindow?: number };
  state?: { model?: { provider?: string; contextWindow?: number } };
  modelRuntime?: { isUsingOAuth?: (provider: string) => boolean };
};

/** Context/auth values which must survive after an AgentSession is no longer live. */
export interface SessionUsageSnapshot {
  contextPercent: number | null;
  contextWindow?: number;
  autoCompactionEnabled?: boolean;
  usingSubscription?: boolean;
}

/** Format a token count exactly like Pi's interactive footer. */
export function formatTokens(count: number, _compact?: boolean): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Format cost exactly like Pi's interactive footer. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

/** Read Pi context and authentication state defensively, including model fallback. */
export function getSessionUsageSnapshot(session: SessionLike | undefined): SessionUsageSnapshot | undefined {
  if (!session) return undefined;
  try {
    const contextUsage = session.getContextUsage?.() ?? session.getSessionStats?.().contextUsage;
    const model = session.model ?? session.state?.model;
    const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow;
    const provider = model?.provider;
    let usingSubscription: boolean | undefined;
    if (provider) {
      usingSubscription = provider === "kimi-coding";
      if (!usingSubscription) {
        try { usingSubscription = session.modelRuntime?.isUsingOAuth?.(provider) ?? false; }
        catch { usingSubscription = false; }
      }
    }
    return {
      contextPercent: contextUsage?.percent ?? null,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof session.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: session.autoCompactionEnabled } : {}),
      ...(usingSubscription !== undefined ? { usingSubscription } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Context-window utilization (0–100), or null when unavailable. */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  return getSessionUsageSnapshot(session)?.contextPercent ?? null;
}
