/**
 * model-precedence.test.ts — Focused tests for the model resolution precedence chain.
 *
 * Precedence (highest to lowest):
 *   1. sessionOverrides[subagentType]
 *   2. sessionOverrides["default"]
 *   3. config.agent[subagentType]
 *   4. config.agent["default"]
 *   5. agentConfig?.model  (frontmatter)
 *   6. parentModelId       (final fallback)
 *
 * Returns first non-null, non-undefined, non-empty-string value.
 */

import { describe, it, expect } from "vitest";
import { resolveModel } from "../../src/models/model-precedence.ts";
import type { SubagentsConfig } from "../../src/models/model-precedence.ts";

const baseConfig: SubagentsConfig = {
  agent: { default: null, forceBackground: false },
  concurrency: { default: 4 },
};

describe("model resolution precedence chain", () => {
  it("1 — session per-type override wins over everything", () => {
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: baseConfig,
      parentModelId: "parent",
      sessionOverrides: {
        default: null,
        Explore: "session-per-type",
      },
    });
    expect(r).toBe("session-per-type");
  });

  it("2 — session global default beats config", () => {
    const cfg = { ...baseConfig, agent: { default: "config-global", Explore: "config-per-type", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
      sessionOverrides: { default: "session-default" },
    });
    expect(r).toBe("session-default");
  });

  it("3 — config per-type override beats config global", () => {
    const cfg = { ...baseConfig, agent: { default: "config-global", Explore: "config-per-type", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
    });
    expect(r).toBe("config-per-type");
  });

  it("4 — config global beats frontmatter", () => {
    const cfg = { ...baseConfig, agent: { default: "config-global", forceBackground: false } };
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: cfg,
      parentModelId: "parent",
    });
    expect(r).toBe("config-global");
  });

  it("5 — frontmatter beats parent model", () => {
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: { model: "frontmatter" },
      config: baseConfig,
      parentModelId: "parent",
    });
    expect(r).toBe("frontmatter");
  });

  it("6 — parent model as final fallback", () => {
    const r = resolveModel({
      subagentType: "Explore",
      agentConfig: undefined,
      config: baseConfig,
      parentModelId: "parent",
    });
    expect(r).toBe("parent");
  });
});

