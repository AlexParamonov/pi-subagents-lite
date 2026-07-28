import { describe, expect, it } from "vitest";
import { normalizeThinkingLevel, supportedThinkingLevels } from "../../src/models/thinking.js";

const deepSeekV4ProLike = {
  provider: "deepseek",
  id: "deepseek-v4-pro",
  reasoning: true,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    max: "max",
  },
} as any;

const noReasoning = {
  provider: "openai",
  id: "gpt-4o",
  reasoning: false,
} as any;

describe("model-aware thinking", () => {
  it("exposes and clamps the levels from a DeepSeek V4 Pro-style map", () => {
    expect(supportedThinkingLevels(deepSeekV4ProLike)).toEqual(["off", "high", "max"]);
    expect(normalizeThinkingLevel(deepSeekV4ProLike, "medium")).toBe("high");
    expect(normalizeThinkingLevel(deepSeekV4ProLike, "xhigh")).toBe("max");
  });

  it("forces explicit thinking on models without reasoning to off", () => {
    expect(supportedThinkingLevels(noReasoning)).toEqual(["off"]);
    expect(normalizeThinkingLevel(noReasoning, "high")).toBe("off");
  });

  it("leaves a missing request undefined for Pi's session default", () => {
    expect(normalizeThinkingLevel(deepSeekV4ProLike, undefined)).toBeUndefined();
    expect(normalizeThinkingLevel(noReasoning, undefined)).toBeUndefined();
  });
});
