/**
 * model-precedence.test.ts — Tests for model resolution precedence.
 *
 * Precedence chain (highest to lowest):
 *   1. config.agent[subagentType]  (per-type override)
 *   2. config.agent["default"]     (global default)
 *   3. agentConfig?.model          (agent config / frontmatter)
 *   4. parentModelId               (inherit from parent)
 *
 * Returns first non-null, non-undefined, non-empty-string value.
 * If all empty/null, returns parentModelId.
 */

import { describe, it, expect } from "vitest";
import { resolveModel } from "../extensions/model-precedence.ts";
import type { SubagentsConfig } from "../extensions/model-precedence.ts";

const defaultConfig: SubagentsConfig = {
  agent: { default: null },
  concurrency: { default: 4, models: {} },
};

function makeConfig(overrides?: Partial<SubagentsConfig>): SubagentsConfig {
  return { ...defaultConfig, ...overrides };
}

/* ------------------------------------------------------------------ */
/*  resolveModel                                                      */
/* ------------------------------------------------------------------ */

describe("resolveModel", () => {
  it("per-type override wins over everything", () => {
    const config = makeConfig({ agent: { default: "global-default", Explore: "per-type-model" } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("per-type-model");
  });

  it("global default wins when per-type is not set", () => {
    const config = makeConfig({ agent: { default: "global-default" } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("global-default");
  });

  it("agent config model wins when no overrides", () => {
    const config = makeConfig({ agent: { default: null } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("agent-config-model");
  });

  it("parent model is fallback when nothing else is set", () => {
    const config = makeConfig({ agent: { default: null } });
    const result = resolveModel("Explore", undefined, config, "parent-model");
    expect(result).toBe("parent-model");
  });

  it("empty string override falls through to next level", () => {
    const config = makeConfig({ agent: { default: null, Explore: "" } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("agent-config-model");
  });

  it("null override falls through to next level", () => {
    const config = makeConfig({ agent: { default: null, Explore: null } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("agent-config-model");
  });

  it("undefined override falls through to next level", () => {
    const config = makeConfig({ agent: { default: null, Explore: undefined } });
    const agentConfig = { model: "agent-config-model" };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("agent-config-model");
  });

  it("unknown type falls through to global default", () => {
    const config = makeConfig({ agent: { default: "global-default" } });
    const result = resolveModel("UnknownType", undefined, config, "parent-model");
    expect(result).toBe("global-default");
  });

  it("all empty/null returns parentModelId", () => {
    const config = makeConfig({ agent: { default: null } });
    const result = resolveModel("Explore", undefined, config, "parent-model");
    expect(result).toBe("parent-model");
  });

  it("per-type override can be empty string, falls through global default", () => {
    const config = makeConfig({ agent: { default: "global-fallback", Explore: "" } });
    const result = resolveModel("Explore", undefined, config, "parent-model");
    expect(result).toBe("global-fallback");
  });

  it("agentConfig without model field still falls through", () => {
    const config = makeConfig({ agent: { default: null } });
    const agentConfig = {} as { model?: string };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("parent-model");
  });

  it("agentConfig with undefined model falls through", () => {
    const config = makeConfig({ agent: { default: null } });
    const agentConfig = { model: undefined };
    const result = resolveModel("Explore", agentConfig, config, "parent-model");
    expect(result).toBe("parent-model");
  });
});
