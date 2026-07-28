/**
 * widget-stats-filtering.test.ts — Tests for configurable widget stats filtering.
 *
 * buildStatsParts accepts a `visible` parameter controlling which stat
 * parts appear in the output. All flags default to true for backward
 * compatibility.
 */

import { describe, it, expect } from "vitest";
import { buildInvocationTags, buildStatsParts, formatThinkingTag, formatUsageBlock, getAgentStatusDisplay } from "../../src/ui/format.js";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const allStats = {
  toolUses: 5,
  turnCount: 3,
  maxTurns: 30,
  input: 1000,
  output: 500,
  contextPercent: 50,
  contextWindow: 272000,
  autoCompactionEnabled: true,
  cacheRead: 1300000,
  cacheWrite: 12000,
  latestCacheHitRate: 99.1,
  cost: 1.23,
  durationMs: 65000,
};

describe("getAgentStatusDisplay", () => {
  it.each([
    ["completed", "✓"],
    ["turn_limited", "✓"],
    ["stopped", "■"],
    ["error", "✗"],
    ["aborted", "✗"],
  ] as const)("maps %s to %s", (status, icon) => {
    expect(getAgentStatusDisplay(status).icon).toBe(icon);
  });
});

describe("buildStatsParts — visible flag: showTools", () => {
  it("excludes toolUses when showTools is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTools: false });
    expect(parts.some(p => p.includes("⚙︎"))).toBe(false);
  });

  it("includes toolUses when showTools is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("⚙︎"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showTurns", () => {
  it("excludes turns when showTurns is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTurns: false });
    expect(parts.some(p => p.includes("⟳"))).toBe(false);
  });

  it("includes turns when showTurns is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("⟳"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showInput/showOutput", () => {
  it("excludes token display when showInput and showOutput are both false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false, showOutput: false });
    expect(parts.some(p => p.includes("↑") || p.includes("↓"))).toBe(false);
  });

  it("excludes only input when showInput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false });
    expect(parts.some(p => p.includes("↑"))).toBe(false);
    expect(parts.some(p => p.includes("↓"))).toBe(true);
  });

  it("excludes only output when showOutput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showOutput: false });
    expect(parts.some(p => p.includes("↑"))).toBe(true);
    expect(parts.some(p => p.includes("↓"))).toBe(false);
  });
});

describe("buildStatsParts — visible flag: showContext", () => {
  it("excludes context/window/auto when showContext is false", () => {
    expect(buildStatsParts(allStats, mockTheme, { showContext: false }).join(" · "))
      .toBe("5⚙︎ · 3⟳ · ↑1.0k ↓500 R1.3M W12k CH99.1% $1.230 · 1m 5s");
  });

  it("includes Pi context/window/auto but keeps compaction tracking out of usage", () => {
    expect(buildStatsParts(allStats, mockTheme).join(" · "))
      .toBe("5⚙︎ · 3⟳ · ↑1.0k ↓500 R1.3M W12k CH99.1% $1.230 50.0%/272k (auto) · 1m 5s");
  });
});

describe("buildStatsParts — Pi context colors", () => {
  const markerTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => text,
  };

  it("uses Pi's strict warning and error context thresholds without splitting usage spacing", () => {
    const usageAt = (contextPercent: number | null) => buildStatsParts(
      { ...allStats, contextPercent }, markerTheme,
    ).at(2)!;

    expect(usageAt(null)).toContain("?/272k (auto)");
    expect(usageAt(null)).not.toMatch(/\[(?:warning|error):/);
    expect(usageAt(70.0)).toContain("70.0%/272k (auto)");
    expect(usageAt(70.0)).not.toMatch(/\[(?:warning|error):/);
    expect(usageAt(70.1)).toContain("[warning:70.1%/272k (auto)]");
    expect(usageAt(90.0)).toContain("[warning:90.0%/272k (auto)]");
    expect(usageAt(90.1)).toContain("[error:90.1%/272k (auto)]");
    expect(usageAt(90.1)).toBe("↑1.0k ↓500 R1.3M W12k CH99.1% $1.230 [error:90.1%/272k (auto)]");
  });

  it("uses Pi's zero-window fallback only when context percent is known", () => {
    expect(formatUsageBlock({ input: 0, output: 0, contextPercent: 70.1 }, undefined, markerTheme))
      .toBe("[warning:70.1%/0]");
    expect(formatUsageBlock({ input: 0, output: 0, contextPercent: 90.1 }, undefined, markerTheme))
      .toBe("[error:90.1%/0]");
    expect(formatUsageBlock({ input: 0, output: 0 })).toBeUndefined();
  });
});

describe("buildStatsParts — visible flag: showCost", () => {
  it("excludes cost when showCost is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showCost: false });
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("includes cost when showCost is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showTime", () => {
  it("excludes time when showTime is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTime: false });
    expect(parts.some(p => p.includes("m") || p.includes("s") || p.includes("<1s"))).toBe(false);
  });

  it("includes time when durationMs is provided and showTime is true", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("1m"))).toBe(true);
  });

  it("includes time by default when durationMs is provided", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("1m"))).toBe(true);
  });
});

describe("buildStatsParts — all visible flags false", () => {
  it("returns empty array when all flags are false", () => {
    const parts = buildStatsParts(allStats, mockTheme, {
      showTools: false,
      showTurns: false,
      showInput: false,
      showOutput: false,
      showContext: false,
      showCost: false,
      showTime: false,
    });
    expect(parts).toEqual([]);
  });
});

describe("buildStatsParts — backward compatibility", () => {
  it("without visible parameter, behaves the same as before", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some(p => p.includes("⚙︎"))).toBe(true);
    expect(parts.some(p => p.includes("⟳"))).toBe(true);
    expect(parts.some(p => p.includes("↑"))).toBe(true);
    expect(parts.some(p => p.includes("$"))).toBe(true);
  });
});

describe("buildInvocationTags", () => {
  it("returns a concrete thinking tag separately from other invocation tags", () => {
    expect(buildInvocationTags({ modelName: "sonnet", thinkingLevel: "high", runInBackground: true, maxTurns: 10 })).toEqual({
      modelName: "sonnet",
      thinkingTag: "high",
      tags: ["background", "max turns: 10"],
    });
  });

  it("formats concrete levels compactly and omits inherited or invalid values", () => {
    expect(formatThinkingTag("high")).toBe("high");
    expect(formatThinkingTag("inherit")).toBeUndefined();
    expect(formatThinkingTag("unknown")).toBeUndefined();
  });
});

describe("formatUsageBlock — Pi ordering and visibility", () => {
  const usage = {
    input: 83_000,
    output: 7_100,
    cacheRead: 1_300_000,
    cacheWrite: 12_000,
    latestCacheHitRate: 99.1,
    cost: 1.262,
    usingSubscription: true,
    contextPercent: 23.4,
    contextWindow: 272_000,
    autoCompactionEnabled: true,
  };

  it("matches Pi's complete space-separated sequence", () => {
    expect(formatUsageBlock(usage)).toBe("↑83k ↓7.1k R1.3M W12k CH99.1% $1.262 (sub) 23.4%/272k (auto)");
  });

  it("uses unknown context without inventing a percentage", () => {
    expect(formatUsageBlock({ ...usage, contextPercent: null }))
      .toBe("↑83k ↓7.1k R1.3M W12k CH99.1% $1.262 (sub) ?/272k (auto)");
  });

  it("honors input, output, context, and cost visibility independently", () => {
    expect(formatUsageBlock(usage, { showInput: false, showContext: false, showCost: false }))
      .toBe("↓7.1k");
  });

  it("shows the zero subscription cost like Pi", () => {
    expect(formatUsageBlock({ ...usage, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }))
      .toBe("$0.000 (sub) 23.4%/272k (auto)");
  });
});

describe("buildStatsParts — cost behavior",  () => {
  it("does not include cost when not provided", () => {
    const parts = buildStatsParts({
      toolUses: 5, turnCount: 3, maxTurns: 30, input: 1000, output: 500,
      contextPercent: 50, compactions: 2, durationMs: 65000,
    }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("does not include cost when cost is 0", () => {
    const parts = buildStatsParts({ ...allStats, cost: 0 }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("includes a three-decimal cost in the contiguous usage group", () => {
    expect(buildStatsParts(allStats, mockTheme).at(2)).toContain("$1.230");
  });
});
