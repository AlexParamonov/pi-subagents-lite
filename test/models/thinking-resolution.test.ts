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
 * display-only tail is resolveDisplayedThinking, pinned below.
 */

import { describe, it, expect } from "vite-plus/test";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveThinkingLevel,
  resolveDisplayedThinking,
  formatDisplayedThinking,
} from "../../src/models/thinking-resolution.js";

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

describe("resolveThinkingLevel — the `parent` value", () => {
  it("resolves to the parent level when frontmatter holds `parent`", () => {
    expect(resolveThinkingLevel({ frontmatter: "parent", parentLevel: "minimal" })).toBe("minimal");
  });

  it("resolves to the parent level when defaultThinking holds `parent`", () => {
    expect(resolveThinkingLevel({ defaultThinking: "parent", parentLevel: "low" })).toBe("low");
  });

  it("a frontmatter `parent` beats a concrete pi per-model level", () => {
    expect(resolveThinkingLevel({ frontmatter: "parent", perModel: "high", parentLevel: "minimal" })).toBe("minimal");
  });

  it("a concrete higher source beats a lower `parent`", () => {
    expect(resolveThinkingLevel({ frontmatter: "low", defaultThinking: "parent", parentLevel: "minimal" })).toBe("low");
  });

  it("an explicit pick beats a frontmatter `parent`", () => {
    expect(resolveThinkingLevel({ explicit: "max", frontmatter: "parent", parentLevel: "minimal" })).toBe("max");
  });

  it("treats a source holding `parent` as unwritten when no parent level is available", () => {
    expect(resolveThinkingLevel({ frontmatter: "parent", perModel: "high" })).toBe("high");
    expect(resolveThinkingLevel({ frontmatter: "parent", parentLevel: undefined })).toBeUndefined();
  });
});

describe("resolveDisplayedThinking", () => {
  // Minimal reasoning model; real clampThinkingLevel runs against it.
  const MODEL = {
    provider: "test",
    id: "model",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  } as Model<Api>;

  it("names frontmatter the winning source", () => {
    expect(resolveDisplayedThinking({ frontmatter: "high" }, undefined, MODEL)).toEqual({
      level: "high",
      source: "frontmatter",
    });
  });

  it("names pi per-model when it wins over the subagent default", () => {
    expect(resolveDisplayedThinking({ perModel: "high", defaultThinking: "low" }, undefined, MODEL)).toEqual({
      level: "high",
      source: "pi per-model",
    });
  });

  it("names subagent default when defaultThinking wins", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "low" }, "high", MODEL)).toEqual({
      level: "low",
      source: "subagent default",
    });
  });

  it("names parent when a source holds `parent`, not the source that holds it", () => {
    expect(resolveDisplayedThinking({ frontmatter: "parent", parentLevel: "minimal" }, undefined, MODEL)).toEqual({
      level: "minimal",
      source: "parent",
    });
    expect(resolveDisplayedThinking({ defaultThinking: "parent", parentLevel: "minimal" }, undefined, MODEL)).toEqual({
      level: "minimal",
      source: "parent",
    });
  });

  it("clamps a followed parent level to the model's supported levels", () => {
    expect(resolveDisplayedThinking({ frontmatter: "parent", parentLevel: "max" }, undefined, MODEL)).toEqual({
      level: "xhigh",
      source: "parent",
    });
    expect(clampThinkingLevel(MODEL, "max")).toBe("xhigh"); // sanity: the model really lacks max
  });

  it("reports the next source when the only `parent` has no parent level available", () => {
    expect(resolveDisplayedThinking({ frontmatter: "parent", defaultThinking: "low" }, undefined, MODEL)).toEqual({
      level: "low",
      source: "subagent default",
    });
  });

  it("falls through the chain to pi's global defaultThinkingLevel", () => {
    expect(resolveDisplayedThinking({}, "xhigh", MODEL)).toEqual({ level: "xhigh", source: "pi default" });
  });

  it("falls through to medium when no source and no pi default is set", () => {
    expect(resolveDisplayedThinking({}, undefined, MODEL)).toEqual({ level: "medium", source: "pi default" });
  });

  it("clamps the result to the model's supported levels", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "xhigh" }, undefined, MODEL).level).toBe("xhigh");
    expect(resolveDisplayedThinking({ defaultThinking: "max" }, undefined, MODEL).level).toBe("xhigh");
  });

  it("leaves the result unclamped when the model is not in the registry", () => {
    expect(resolveDisplayedThinking({ defaultThinking: "max" }, undefined, undefined).level).toBe("max");
  });
});

describe("formatDisplayedThinking", () => {
  it("prints the level with its winning source in brackets", () => {
    expect(formatDisplayedThinking({ level: "high", source: "frontmatter" })).toBe("high (frontmatter)");
    expect(formatDisplayedThinking({ level: "medium", source: "pi default" })).toBe("medium (pi default)");
  });
});
