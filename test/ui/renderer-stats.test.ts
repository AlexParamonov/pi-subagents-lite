import { describe, expect, it } from "vitest";
import { buildStatsLine } from "../../src/ui/renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("renderer stats", () => {
  it("uses the structured single-row counter, Pi footer, and duration groups", () => {
    expect(buildStatsLine({
      toolUses: 5,
      turnCount: 10,
      input: 12_000,
      output: 8_000,
      cacheRead: 85_000,
      cacheWrite: 3_000,
      latestCacheHitRate: 89.2,
      contextPercent: 47,
      contextWindow: 128_000,
      cost: 0.024,
      durationMs: 30_000,
    }, theme as any, true)).toBe(
      "5⚙︎  10⟳ · ↑12k ↓8.0k R85k W3.0k CH89.2% $0.024 47.0%/128k · 30s",
    );
  });
});
