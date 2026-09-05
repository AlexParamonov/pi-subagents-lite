/**
 * thinking-resolution.test.ts — The shared thinking precedence chain.
 *
 * Pins the spawn-effective precedence:
 *   explicit > frontmatter > per-model > defaultThinking > undefined
 *
 * `undefined` means "nothing set": the caller passes nothing to session
 * creation and pi's own fallback applies (defaultThinkingLevel setting,
 * else medium, clamped to the model's supported levels). Display surfaces
 * additionally fall through to pi's global default, then medium — that
 * display-only tail is resolveDisplayThinkingLevel, pinned below.
 */

import { describe, it, expect } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveThinkingLevel, resolveDisplayThinkingLevel } from "../../src/models/thinking-resolution.js";

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

describe("resolveDisplayThinkingLevel", () => {
  // Minimal reasoning model; real clampThinkingLevel runs against it.
  const MODEL = {
    provider: "test",
    id: "model",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  } as Model<Api>;

  it("returns the chain result when a source wins", () => {
    expect(resolveDisplayThinkingLevel({ perModel: "high", defaultThinking: "low" }, "xhigh", MODEL)).toBe("high");
  });

  it("falls through the chain to pi's global defaultThinkingLevel", () => {
    expect(resolveDisplayThinkingLevel({}, "xhigh", MODEL)).toBe("xhigh");
  });

  it("falls through to medium when no source and no pi default is set", () => {
    expect(resolveDisplayThinkingLevel({}, undefined, MODEL)).toBe("medium");
  });

  it("clamps the result to the model's supported levels", () => {
    expect(resolveDisplayThinkingLevel({ defaultThinking: "xhigh" }, undefined, MODEL)).toBe("xhigh");
    expect(clampThinkingLevel(MODEL, "max")).toBe("xhigh"); // sanity: the model really lacks max
    expect(resolveDisplayThinkingLevel({ defaultThinking: "max" }, undefined, MODEL)).toBe("xhigh");
  });

  it("leaves the result unclamped when the model is not in the registry", () => {
    expect(resolveDisplayThinkingLevel({ defaultThinking: "max" }, undefined, undefined)).toBe("max");
  });
});
