/**
 * widget-stats-filtering.test.ts — Tests for configurable widget stats filtering.
 *
 * buildStatsParts accepts a `visible` parameter controlling which stat
 * parts appear in the output. All flags default to true for backward
 * compatibility.
 */

import { describe, it, expect } from "vitest";
import { buildStatsParts } from "../../src/ui/format.js";

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
  compactions: 2,
  cost: 1.23,
  durationMs: 65000,
};

describe("buildStatsParts — visible flag: showTools", () => {
  it("excludes toolUses when showTools is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTools: false });
    expect(parts.some(p => p.includes("🛠"))).toBe(false);
  });

  it("includes toolUses when showTools is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("🛠"))).toBe(true);
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
  it("excludes context percent and compactions when showContext is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showContext: false });
    expect(parts.some(p => p.includes("%"))).toBe(false);
    expect(parts.some(p => p.includes("↻"))).toBe(false);
  });

  it("includes context percent when showContext is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p.includes("%"))).toBe(true);
    expect(parts.some(p => p.includes("↻"))).toBe(true);
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
    expect(parts.some(p => p.includes("🛠"))).toBe(true);
    expect(parts.some(p => p.includes("⟳"))).toBe(true);
    expect(parts.some(p => p.includes("↑"))).toBe(true);
    expect(parts.some(p => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — cost behavior", () => {
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

  it("includes cost formatted as dollar amount", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some(p => p === "$1.23")).toBe(true);
  });
});
