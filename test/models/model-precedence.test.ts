import { describe, expect, it } from "vitest";
import {
  resolveModelSetting,
  resolveThinkingSetting,
  type SubagentsConfig,
} from "../../src/models/model-precedence.ts";

const baseConfig: SubagentsConfig = {
  agent: { default: null, forceBackground: false },
  thinkingOverrides: {},
  concurrency: { default: 4 },
};

describe("shared agent setting precedence", () => {
  it("resolves model as spawn > session agent > persisted agent > MD > global > parent", () => {
    const common = {
      subagentType: "reviewer",
      agentConfig: { model: "md/model" },
      config: {
        ...baseConfig,
        agent: { default: "global/model", forceBackground: false, reviewer: "saved/model" },
      },
      parentModelId: "parent/model",
      sessionOverrides: { default: "session-global/model", reviewer: "session/model" },
    };

    expect(resolveModelSetting({ ...common, explicitModel: "spawn/model" })).toEqual({ value: "spawn/model", source: "spawn" });
    expect(resolveModelSetting(common)).toEqual({ value: "session/model", source: "session-agent" });
    expect(resolveModelSetting({ ...common, sessionOverrides: { default: "session-global/model" } })).toEqual({ value: "saved/model", source: "config-agent" });
    expect(resolveModelSetting({
      ...common,
      config: { ...baseConfig, agent: { default: "global/model", forceBackground: false } },
      sessionOverrides: { default: "session-global/model" },
    })).toEqual({ value: "md/model", source: "agent-md" });
    expect(resolveModelSetting({ ...common, agentConfig: undefined, config: baseConfig, sessionOverrides: { default: "session-global/model" } }))
      .toEqual({ value: "session-global/model", source: "session-global" });
    expect(resolveModelSetting({ ...common, agentConfig: undefined, config: { ...baseConfig, agent: { default: "global/model", forceBackground: false } }, sessionOverrides: undefined }))
      .toEqual({ value: "global/model", source: "config-global" });
    expect(resolveModelSetting({ ...common, agentConfig: undefined, config: baseConfig, sessionOverrides: undefined }))
      .toEqual({ value: "parent/model", source: "parent" });
  });

  it("ignores malformed non-string model values from JSON config", () => {
    const malformed = {
      ...baseConfig,
      agent: { default: true, forceBackground: false, reviewer: false },
    } as unknown as SubagentsConfig;

    expect(resolveModelSetting({
      subagentType: "reviewer",
      agentConfig: { model: "md/model" },
      config: malformed,
      parentModelId: "parent/model",
    })).toEqual({ value: "md/model", source: "agent-md" });
  });

  it("ignores invalid persisted per-agent and global thinking values", () => {
    for (const invalid of ["invalid", true, {}]) {
      const perAgent = {
        ...baseConfig,
        agent: { default: null, forceBackground: false, defaultThinking: "low" },
        thinkingOverrides: { reviewer: invalid },
      } as unknown as SubagentsConfig;
      expect(resolveThinkingSetting({
        subagentType: "reviewer",
        agentConfig: { thinkingLevel: "high" },
        config: perAgent,
        parentThinking: "minimal",
      })).toEqual({ value: "high", source: "agent-md" });

      const global = {
        ...baseConfig,
        agent: { default: null, forceBackground: false, defaultThinking: invalid },
      } as unknown as SubagentsConfig;
      expect(resolveThinkingSetting({
        subagentType: "reviewer",
        config: global,
        parentThinking: "minimal",
      })).toEqual({ value: "minimal", source: "parent" });
    }
  });

  it("uses the same precedence for thinking", () => {
    const common = {
      subagentType: "reviewer",
      agentConfig: { thinkingLevel: "high" as const },
      config: {
        ...baseConfig,
        agent: { default: null, forceBackground: false, defaultThinking: "low" as const },
        thinkingOverrides: { reviewer: "medium" as const },
      },
      parentThinking: "minimal" as const,
      sessionOverrides: { default: "off" as const, reviewer: "xhigh" as const },
    };

    expect(resolveThinkingSetting({ ...common, explicitThinking: "max" })).toEqual({ value: "max", source: "spawn" });
    expect(resolveThinkingSetting(common)).toEqual({ value: "xhigh", source: "session-agent" });
    expect(resolveThinkingSetting({ ...common, sessionOverrides: { default: "off" } })).toEqual({ value: "medium", source: "config-agent" });
    expect(resolveThinkingSetting({ ...common, config: { ...common.config, thinkingOverrides: {} }, sessionOverrides: { default: "off" } }))
      .toEqual({ value: "high", source: "agent-md" });
    expect(resolveThinkingSetting({ ...common, agentConfig: undefined, config: baseConfig, sessionOverrides: { default: "off" } }))
      .toEqual({ value: "off", source: "session-global" });
    expect(resolveThinkingSetting({ ...common, agentConfig: undefined, config: { ...baseConfig, agent: { default: null, forceBackground: false, defaultThinking: "low" } }, sessionOverrides: undefined }))
      .toEqual({ value: "low", source: "config-global" });
    expect(resolveThinkingSetting({ ...common, agentConfig: undefined, config: baseConfig, sessionOverrides: undefined }))
      .toEqual({ value: "minimal", source: "parent" });
  });
});
