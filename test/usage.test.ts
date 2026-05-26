/**
 * usage.test.ts — Tests for usage tracking utilities.
 *
 * Tests cover:
 *   - LifetimeUsage type includes cost field
 *   - addUsage accumulates cost alongside tokens
 *   - getLifetimeTotal includes cost in sum
 *   - Backward compatibility (existing token fields unchanged)
 */

import { describe, it, expect } from "vitest";
import {
  type LifetimeUsage,
  addUsage,
  getLifetimeTotal,
  formatTokens,
} from "../src/usage.js";

/* ------------------------------------------------------------------ */
/*  LifetimeUsage type — cost field                                    */
/* ------------------------------------------------------------------ */

describe("LifetimeUsage", () => {
  it("includes cost field", () => {
    const u: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    expect(u.cost).toBe(5);
  });

  it("has correct shape with all fields", () => {
    const u: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
    expect(u).toHaveProperty("input");
    expect(u).toHaveProperty("output");
    expect(u).toHaveProperty("cacheWrite");
    expect(u).toHaveProperty("cost");
  });
});

/* ------------------------------------------------------------------ */
/*  addUsage — cost accumulation                                       */
/* ------------------------------------------------------------------ */

describe("addUsage", () => {
  it("accumulates cost into target", () => {
    const target: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(target, { input: 10, output: 5, cacheWrite: 1, cost: 2 });
    expect(target).toEqual({ input: 110, output: 55, cacheWrite: 11, cost: 7 });
  });

  it("handles zero cost delta", () => {
    const target: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    addUsage(target, { input: 10, output: 5, cacheWrite: 1, cost: 0 });
    expect(target.cost).toBe(5);
  });

  it("accumulates multiple deltas", () => {
    const target: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
    addUsage(target, { input: 100, output: 50, cacheWrite: 10, cost: 2.5 });
    addUsage(target, { input: 200, output: 100, cacheWrite: 20, cost: 5.0 });
    addUsage(target, { input: 50, output: 25, cacheWrite: 5, cost: 1.25 });
    expect(target).toEqual({ input: 350, output: 175, cacheWrite: 35, cost: 8.75 });
  });
});

/* ------------------------------------------------------------------ */
/*  getLifetimeTotal — includes cost                                   */
/* ------------------------------------------------------------------ */

describe("getLifetimeTotal", () => {
  it("returns sum of input + output + cacheWrite + cost", () => {
    const u: LifetimeUsage = { input: 100, output: 50, cacheWrite: 10, cost: 5 };
    // 100 + 50 + 10 + 5 = 165
    expect(getLifetimeTotal(u)).toBe(165);
  });

  it("returns 0 for undefined", () => {
    expect(getLifetimeTotal(undefined)).toBe(0);
  });

  it("returns 0 when all components are 0", () => {
    const u: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cost: 0 };
    expect(getLifetimeTotal(u)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  formatTokens — compact token formatting                            */
/* ------------------------------------------------------------------ */

describe("formatTokens", () => {
  it("formats values below 1000 as raw number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats values >= 1000 with k suffix (1 decimal)", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12300)).toBe("12.3k");
    expect(formatTokens(100500)).toBe("100.5k");
  });

  it("formats values >= 1000000 with M suffix (1 decimal)", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12.3M");
  });

  it("rounds down (no decimal rounding issues)", () => {
    // 1234 → 1.234 → 1.2k
    expect(formatTokens(1234)).toBe("1.2k");
  });

  it("handles exactly 1 million", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });
});
