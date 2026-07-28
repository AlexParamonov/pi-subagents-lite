import { describe, expect, it } from "vitest";
import {
  addUsage,
  formatCost,
  formatTokens,
  getLifetimeTotal,
  getSessionUsageSnapshot,
  type LifetimeUsage,
} from "../../src/agents/usage.js";

describe("usage accounting", () => {
  it("accumulates billable usage but never treats dollars as tokens", () => {
    const usage: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(usage, { input: 10, output: 5, cacheWrite: 1, cost: 2 });
    expect(usage).toEqual({ input: 110, output: 55, cacheWrite: 11, cost: 7 });
    expect(getLifetimeTotal(usage)).toBe(176);
    expect(getLifetimeTotal(undefined)).toBe(0);
  });
});

describe("Pi footer primitives", () => {
  it("uses Pi token thresholds exactly", () => {
    expect([
      formatTokens(999),
      formatTokens(1_000),
      formatTokens(9_999),
      formatTokens(10_000),
      formatTokens(999_999),
      formatTokens(1_000_000),
      formatTokens(9_999_999),
      formatTokens(10_000_000),
    ]).toEqual(["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10.0M", "10M"]);
  });

  it("formats costs to exactly three decimals", () => {
    expect([formatCost(0), formatCost(0.008), formatCost(1.23), formatCost(12.3456)])
      .toEqual(["$0.000", "$0.008", "$1.230", "$12.346"]);
  });

  it("reads context/model fallback, auto compaction, and subscription defensively", () => {
    const session = {
      getContextUsage: () => ({ percent: null, contextWindow: 272_000 }),
      model: { provider: "oauth-provider" },
      autoCompactionEnabled: true,
      modelRuntime: { isUsingOAuth: (provider: string) => provider === "oauth-provider" },
    };
    expect(getSessionUsageSnapshot(session)).toEqual({
      contextPercent: null,
      contextWindow: 272_000,
      autoCompactionEnabled: true,
      usingSubscription: true,
    });
    expect(getSessionUsageSnapshot({ model: { provider: "kimi-coding", contextWindow: 128_000 } }))
      .toMatchObject({ contextPercent: null, contextWindow: 128_000, usingSubscription: true });
    expect(getSessionUsageSnapshot({
      getSessionStats: () => ({ contextUsage: { percent: 70.1 } }),
    })).toEqual({ contextPercent: 70.1 });
    expect(getSessionUsageSnapshot({ getContextUsage: () => { throw new Error("mock"); } })).toBeUndefined();
  });
});
