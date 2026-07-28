/**
 * model-thinking-tag.test.ts — Tests for buildModelThinkingTag.
 *
 * Tests the widget model/thinking tag formatting:
 *   (modelName · thinkingLevel) with independent visibility toggles.
 */

import { describe, it, expect } from "vitest";
import { buildModelThinkingTag } from "../../src/ui/format.js";
import type { AgentInvocation } from "../../src/agents/types.js";

describe("buildModelThinkingTag", () => {
  const defaultVisible = { showModel: true, showThinking: true };

  it("returns empty string when invocation is undefined", () => {
    expect(buildModelThinkingTag(undefined, defaultVisible)).toBe("");
  });

  it("returns empty string when invocation has no model or thinking", () => {
    expect(buildModelThinkingTag({}, defaultVisible)).toBe("");
  });

  it("formats model name only", () => {
    const inv: AgentInvocation = { modelName: "haiku" };
    expect(buildModelThinkingTag(inv, { showModel: true, showThinking: true })).toBe("(haiku)");
  });

  it("formats thinking level only", () => {
    const inv: AgentInvocation = { thinkingLevel: "low" };
    expect(buildModelThinkingTag(inv, { showModel: true, showThinking: true })).toBe("(low)");
  });

  it("formats both model and thinking with middle dot separator", () => {
    const inv: AgentInvocation = { modelName: "haiku", thinkingLevel: "medium" };
    expect(buildModelThinkingTag(inv, { showModel: true, showThinking: true })).toBe("(haiku · medium)");
  });

  it("hides model when showModel is false", () => {
    const inv: AgentInvocation = { modelName: "haiku", thinkingLevel: "low" };
    expect(buildModelThinkingTag(inv, { showModel: false, showThinking: true })).toBe("(low)");
  });

  it("hides thinking when showThinking is false", () => {
    const inv: AgentInvocation = { modelName: "haiku", thinkingLevel: "low" };
    expect(buildModelThinkingTag(inv, { showModel: true, showThinking: false })).toBe("(haiku)");
  });

  it("returns empty string when both toggles are off", () => {
    const inv: AgentInvocation = { modelName: "haiku", thinkingLevel: "low" };
    expect(buildModelThinkingTag(inv, { showModel: false, showThinking: false })).toBe("");
  });

  it("returns empty string when only model is set but showModel is false", () => {
    const inv: AgentInvocation = { modelName: "haiku" };
    expect(buildModelThinkingTag(inv, { showModel: false, showThinking: true })).toBe("");
  });

  it("returns empty string when only thinking is set but showThinking is false", () => {
    const inv: AgentInvocation = { thinkingLevel: "high" };
    expect(buildModelThinkingTag(inv, { showModel: true, showThinking: false })).toBe("");
  });

  it("trims whitespace from model name", () => {
    const inv: AgentInvocation = { modelName: "  haiku  " };
    expect(buildModelThinkingTag(inv, defaultVisible)).toBe("(haiku)");
  });

  it("returns empty string for empty model name", () => {
    const inv: AgentInvocation = { modelName: "" };
    expect(buildModelThinkingTag(inv, defaultVisible)).toBe("");
  });

  it("returns empty string for whitespace-only model name", () => {
    const inv: AgentInvocation = { modelName: "   " };
    expect(buildModelThinkingTag(inv, defaultVisible)).toBe("");
  });

  it("handles all thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "max"] as const) {
      const inv: AgentInvocation = { thinkingLevel: level };
      expect(buildModelThinkingTag(inv, defaultVisible)).toBe(`(${level})`);
    }
  });
});
