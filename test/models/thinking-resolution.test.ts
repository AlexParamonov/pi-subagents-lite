/**
 * thinking-resolution.test.ts — The shared thinking precedence chain, pure.
 *
 * Pins the spawn-effective precedence:
 *   explicit > frontmatter > per-model > defaultThinking > undefined
 *
 * `undefined` means "nothing set": the caller passes nothing to session
 * creation and pi's own fallback applies (defaultThinkingLevel setting,
 * else medium, clamped to the model's supported levels). Display surfaces
 * additionally fall through to pi's global default, then medium — that
 * display-only tail lives with the callers, not here.
 */

import { describe, it, expect } from "vitest";
import { resolveThinkingLevel } from "../../src/models/thinking-resolution.js";

describe("resolveThinkingLevel", () => {
  it("returns the explicit spawn param when set, beating every other source", () => {
    expect(
      resolveThinkingLevel({ explicit: "low", frontmatter: "high", perModel: "max", defaultThinking: "medium" }),
    ).toBe("low");
  });

  it("returns frontmatter when no explicit param is given", () => {
    expect(resolveThinkingLevel({ frontmatter: "high", perModel: "max", defaultThinking: "medium" })).toBe("high");
  });

  it("returns the per-model level when explicit and frontmatter are unset", () => {
    expect(resolveThinkingLevel({ perModel: "max", defaultThinking: "medium" })).toBe("max");
  });

  it("per-model beats defaultThinking (default thinking only overrides pi's global default)", () => {
    expect(resolveThinkingLevel({ perModel: "low", defaultThinking: "max" })).toBe("low");
  });

  it("returns defaultThinking when it is the only source set", () => {
    expect(resolveThinkingLevel({ defaultThinking: "high" })).toBe("high");
  });

  it("returns undefined when nothing is set (pi's fallback decides)", () => {
    expect(resolveThinkingLevel({})).toBeUndefined();
  });

  it("treats explicit undefined keys the same as absent keys", () => {
    expect(resolveThinkingLevel({ explicit: undefined, frontmatter: undefined, perModel: undefined })).toBeUndefined();
  });
});
