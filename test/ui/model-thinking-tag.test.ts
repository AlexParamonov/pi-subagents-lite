/**
 * model-thinking-tag.test.ts — Tests for buildModelThinkingTag.
 *
 * Tests the widget model/thinking tag formatting:
 *   (modelName · thinkingLevel) with independent visibility toggles.
 */

import { describe, it, expect } from "vitest";
import { buildModelThinkingTag } from "../../src/ui/format.js";
import { agentNameLabel } from "../../src/ui/renderer.js";

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

describe("agentNameLabel", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

  it("returns just the type name when no model or thinking", () => {
    const d = { type: "builder" };
    expect(agentNameLabel(d, theme)).toBe("Agent");
  });

  it("includes model name in parens", () => {
    const d = { type: "builder", modelName: "haiku", modelId: "haiku" };
    expect(agentNameLabel(d, theme)).toBe("Agent (haiku)");
  });

  it("includes thinking level in parens", () => {
    const d = { type: "builder", thinkingLevel: "medium" };
    expect(agentNameLabel(d, theme)).toBe("Agent (medium)");
  });

  it("includes both model and thinking with middle dot", () => {
    const d = { type: "builder", modelName: "haiku", modelId: "haiku", thinkingLevel: "medium" };
    expect(agentNameLabel(d, theme)).toBe("Agent (haiku · medium)");
  });

  it("ignores empty model name", () => {
    const d = { type: "builder", modelName: "", modelId: "", thinkingLevel: "low" };
    expect(agentNameLabel(d, theme)).toBe("Agent (low)");
  });

  it("ignores whitespace-only model name", () => {
    const d = { type: "builder", modelName: "   ", modelId: "   ", thinkingLevel: "low" };
    expect(agentNameLabel(d, theme)).toBe("Agent (low)");
  });

  it("trims whitespace from values", () => {
    const d = { type: "builder", modelName: "  haiku  ", modelId: "  haiku  ", thinkingLevel: "  low  " };
    expect(agentNameLabel(d, theme)).toBe("Agent (haiku · low)");
  });
});
