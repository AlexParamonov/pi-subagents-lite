/**
 * model-precedence.test.ts — Focused tests for the model resolution precedence chain.
 *
 * Precedence (highest to lowest):
 *   1. sessionOverrides[subagentType]  (session per-type override)
 *   2. sessionOverrides["default"]     (session global default)
 *   3. config.agent[subagentType]      (config per-type override)
 *   4. config.agent["default"]         (config global default)
 *   5. agentConfig?.model              (frontmatter)
 *   6. parentModelId                   (final fallback)
 *
 * Returns first non-null, non-undefined, non-empty-string value.
 */

import { describe, it, expect } from "vitest";
import { resolveModel } from "../../src/models/model-precedence.js";
import type { SubagentsConfig } from "../../src/models/model-precedence.js";

const baseConfig: SubagentsConfig = {
  agent: { default: null, forceBackground: false },
  concurrency: { default: 4 },
};

describe("model resolution precedence chain", () => {
  it("1 — session per-type override wins over every other layer", () => {
    const cfg = {
      ...baseConfig,
      agent: { default: "config-default", Explore: "config-per-type", forceBackground: false },
    };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default", Explore: "session-per-type" },
    });
    expect(r).toBe("session-per-type");
  });

  it("2 — config per-type override beats frontmatter", () => {
    const cfg = {
      ...baseConfig,
      agent: { default: null, Explore: "config-per-type", forceBackground: false },
    };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
    });
    expect(r).toBe("config-per-type");
  });

  it("3 — session default beats the config per-type override", () => {
    const cfg = {
      ...baseConfig,
      agent: { default: null, Explore: "config-per-type", forceBackground: false },
    };
    const r = resolveModel({
      subagentType: "Explore",
      config: cfg,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default" },
    });
    expect(r).toBe("session-default");
  });

  it("4 — session default beats the frontmatter model", () => {
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: baseConfig,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default" },
    });
    expect(r).toBe("session-default");
  });

  it("5 — config default beats the frontmatter model", () => {
    const cfg = { ...baseConfig, agent: { default: "config-default", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
    });
    expect(r).toBe("config-default");
  });

  it("6 — session default beats the config default", () => {
    const cfg = { ...baseConfig, agent: { default: "config-default", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      config: cfg,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default" },
    });
    expect(r).toBe("session-default");
  });

  it("7 — session default beats the parent model", () => {
    const r = resolveModel({
      subagentType: "Explore",
      config: baseConfig,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default" },
    });
    expect(r).toBe("session-default");
  });

  it("8 — config default beats the parent model", () => {
    const cfg = { ...baseConfig, agent: { default: "config-default", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      config: cfg,
      parentModelId: "parent",
    });
    expect(r).toBe("config-default");
  });

  it("9 — parent model as final fallback", () => {
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: undefined,
      config: baseConfig,
      parentModelId: "parent",
    });
    expect(r).toBe("parent");
  });

  it("skips empty-string candidates at every level, falling back to parent", () => {
    // Header contract: "first non-null, non-undefined, non-empty-string value".
    // Empty-string overrides must fall through, not win.
    const cfg = {
      ...baseConfig,
      agent: { default: "", Explore: "", forceBackground: false },
    };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "" },
      config: cfg,
      parentModelId: "parent",
      sessionOverrides: { default: "", Explore: "" },
    });
    expect(r).toBe("parent");
  });
});
