/**
 * model-thinking-tag.test.ts — Tests for buildModelThinkingTag.
 *
 * Tests the widget model/thinking tag formatting:
 *   (modelName · thinkingLevel) with independent visibility toggles.
 */

import { describe, it, expect } from "vitest";
import { buildModelThinkingTag } from "../../src/ui/format.js";

describe("buildModelThinkingTag", () => {
  const defaultVisible = { showModel: true, showThinking: true };

  it("returns empty string when both are undefined", () => {
    expect(buildModelThinkingTag(undefined, undefined, defaultVisible)).toBe("");
  });

  it("returns empty string when both are empty", () => {
    expect(buildModelThinkingTag("", "", defaultVisible)).toBe("");
  });

  it("formats model name only", () => {
    expect(buildModelThinkingTag("haiku", undefined, { showModel: true, showThinking: true })).toBe("(haiku)");
  });

  it("formats thinking level only", () => {
    expect(buildModelThinkingTag(undefined, "low", { showModel: true, showThinking: true })).toBe("(low)");
  });

  it("formats both model and thinking with middle dot separator", () => {
    expect(buildModelThinkingTag("haiku", "medium", { showModel: true, showThinking: true })).toBe("(haiku · medium)");
  });

  it("hides model when showModel is false", () => {
    expect(buildModelThinkingTag("haiku", "low", { showModel: false, showThinking: true })).toBe("(low)");
  });

  it("hides thinking when showThinking is false", () => {
    expect(buildModelThinkingTag("haiku", "low", { showModel: true, showThinking: false })).toBe("(haiku)");
  });

  it("returns empty string when both toggles are off", () => {
    expect(buildModelThinkingTag("haiku", "low", { showModel: false, showThinking: false })).toBe("");
  });

  it("returns empty string when only model is set but showModel is false", () => {
    expect(buildModelThinkingTag("haiku", undefined, { showModel: false, showThinking: true })).toBe("");
  });

  it("returns empty string when only thinking is set but showThinking is false", () => {
    expect(buildModelThinkingTag(undefined, "high", { showModel: true, showThinking: false })).toBe("");
  });

  it("trims whitespace from model name", () => {
    expect(buildModelThinkingTag("  haiku  ", undefined, defaultVisible)).toBe("(haiku)");
  });

  it("returns empty string for empty model name", () => {
    expect(buildModelThinkingTag("", undefined, defaultVisible)).toBe("");
  });

  it("returns empty string for whitespace-only model name", () => {
    expect(buildModelThinkingTag("   ", undefined, defaultVisible)).toBe("");
  });

  it("handles all thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "max"] as const) {
      expect(buildModelThinkingTag(undefined, level, defaultVisible)).toBe(`(${level})`);
    }
  });
});
