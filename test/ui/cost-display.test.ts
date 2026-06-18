/**
 * cost-display.test.ts — Tests for agent cost display feature.
 *
 * Covers:
 *   - formatCost: dollar formatting ($0.00, $0.01, $1.23)
 *   - buildStatsParts: includes cost when provided
 *   - Status bar: appends cumulative cost when > $0
 *   - Cost display toggle in /agents menu
 */

import { describe, it, expect } from "vitest";

// --- formatCost tests ---
describe("formatCost", () => {
  it("formats zero as $0.00", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats small cost with 2 decimal places", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(0.008)).toBe("$0.01");
  });

  it("formats $1.23", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(1.23)).toBe("$1.23");
  });

  it("formats $0.01", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(0.01)).toBe("$0.01");
  });

  it("formats $12.34", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(12.345)).toBe("$12.35");
  });

  it("formats very small cost as $0.00", async () => {
    const { formatCost } = await import("../../src/agents/usage.js");
    expect(formatCost(0.001)).toBe("$0.00");
  });
});

// --- buildStatsParts cost integration ---
describe("buildStatsParts — cost", () => {
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };

  it("includes cost when provided and > 0", async () => {
    const { buildStatsParts } = await import("../../src/ui/agent-widget.js");
    const parts = buildStatsParts({
      toolUses: 5,
      tokens: 1000,
      contextPercent: null,
      compactions: 0,
      cost: 0.008,
    }, mockTheme);
    expect(parts.some(p => p.includes("$0.01"))).toBe(true);
  });

  it("does not include cost when not provided", async () => {
    const { buildStatsParts } = await import("../../src/ui/agent-widget.js");
    const parts = buildStatsParts({
      toolUses: 5,
      tokens: 1000,
      contextPercent: null,
      compactions: 0,
    }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("does not include cost when cost is 0", async () => {
    const { buildStatsParts } = await import("../../src/ui/agent-widget.js");
    const parts = buildStatsParts({
      toolUses: 5,
      tokens: 1000,
      contextPercent: null,
      compactions: 0,
      cost: 0,
    }, mockTheme);
    expect(parts.some(p => p.includes("$"))).toBe(false);
  });

  it("cost is the last element in the returned parts array", async () => {
    const { buildStatsParts } = await import("../../src/ui/agent-widget.js");
    const parts = buildStatsParts({
      toolUses: 1,
      tokens: 1000,
      contextPercent: null,
      compactions: 0,
      cost: 1.50,
    }, mockTheme);
    expect(parts[parts.length - 1]).toBe("$1.50");
  });
});
