/**
 * model-display-style.test.ts — Tests for model display style config.
 *
 * Covers: config type, default, resolved field, mutation, widget sync,
 * and buildModelThinkingTag behavior with different model labels.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { AgentWidget } from "../../src/ui/agent-widget.ts";
import type { SubagentsConfig } from "../../src/models/model-precedence.ts";
import { buildModelThinkingTag } from "../../src/ui/format.ts";

function defaultConfig(): SubagentsConfig {
  return {
    agent: {
      default: null,
      forceBackground: false,
      graceTurns: 6,
      widgetMaxLines: 12,
      widgetDescLengthFull: 50,
      widgetDescLengthCompact: 30,
      widgetCompact: false,
      widgetShortcut: false,
      systemPromptMode: "replace",
      includeContextFiles: true,
      disableDefaultAgents: false,
      showTools: true,
      showTurns: true,
      showInput: true,
      showOutput: true,
      showContext: true,
      showCost: false,
      showTime: true,
      modelDisplayStyle: "id",
    },
    concurrency: { default: 4 },
  };
}

function memIO(initial: Partial<SubagentsConfig> = defaultConfig()): { io: ConfigIO; saves: SubagentsConfig[] } {
  const merged: SubagentsConfig = {
    agent: { ...defaultConfig().agent, ...(initial.agent ?? {}) },
    concurrency: { default: 4, ...(initial.concurrency ?? {}) },
  };
  let cur = structuredClone(merged);
  const saves: SubagentsConfig[] = [];
  return {
    io: {
      load: () => structuredClone(cur),
      save: (c) => {
        cur = structuredClone(c);
        saves.push(structuredClone(c));
      },
    },
    saves,
  };
}

function widgetStub(): { w: AgentWidget; calls: string[] } {
  const calls: string[] = [];
  const w = {
    setShowCost: (e: boolean) => calls.push(`setShowCost:${e}`),
    setForceCompact: (e: boolean) => calls.push(`setForceCompact:${e}`),
    setWidgetShortcut: (e: boolean) => calls.push(`setWidgetShortcut:${e}`),
    setMaxLines: (n: number) => calls.push(`setMaxLines:${n}`),
    setMaxLinesCompact: (n: number) => calls.push(`setMaxLinesCompact:${n}`),
    setDescLengthFull: (n: number) => calls.push(`setDescLengthFull:${n}`),
    setDescLengthCompact: (n: number) => calls.push(`setDescLengthCompact:${n}`),
    setNavHint: (e: boolean) => calls.push(`setNavHint:${e}`),
    setFinishedEvictTurns: (n: number) => calls.push(`setFinishedEvictTurns:${n}`),
    setCompactMode: (c: boolean) => calls.push(`setCompactMode:${c}`),
    setStatsVisibility: (v: any) => calls.push(`setStatsVisibility:${JSON.stringify(v)}`),
    setModelDisplayStyle: (s: string) => calls.push(`setModelDisplayStyle:${s}`),
    setStatusBarFormat: (f: string) => calls.push(`setStatusBarFormat:${f}`),
  };
  return { w: w as unknown as AgentWidget, calls };
}

/* ------------------------------------------------------------------ */
/*  ConfigStore: modelDisplayStyle                                    */
/* ------------------------------------------------------------------ */

describe("ConfigStore modelDisplayStyle", () => {
  it("defaults to 'id'", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.modelDisplayStyle).toBe("id");
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, modelDisplayStyle: "name" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.modelDisplayStyle).toBe("name");
  });

  it("setModelDisplayStyle persists and syncs widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.widget.setModelDisplayStyle("name");
    expect(store.agent.modelDisplayStyle).toBe("name");
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.modelDisplayStyle).toBe("name");
    expect(calls).toContain("setModelDisplayStyle:name");
  });

  it("setModelDisplayStyle cycles back to 'id'", () => {
    const { io, saves } = memIO({
      agent: { default: null, forceBackground: false, modelDisplayStyle: "name" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    saves.length = 0;

    store.mutate.widget.setModelDisplayStyle("id");
    expect(store.agent.modelDisplayStyle).toBe("id");
    expect(saves).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  buildModelThinkingTag: passes model label through unchanged        */
/* ------------------------------------------------------------------ */

describe("buildModelThinkingTag with model label", () => {
  it("includes model name in tag", () => {
    const tag = buildModelThinkingTag("Qwen3.6 27B FP8", undefined, { showModel: true, showThinking: true });
    expect(tag).toBe("(Qwen3.6 27B FP8)");
  });

  it("includes short model id in tag", () => {
    const tag = buildModelThinkingTag("27b_mtp", undefined, { showModel: true, showThinking: true });
    expect(tag).toBe("(27b_mtp)");
  });

  it("combines model and thinking", () => {
    const tag = buildModelThinkingTag("27b_mtp", "high", { showModel: true, showThinking: true });
    expect(tag).toBe("(27b_mtp • high)");
  });

  it("omits model when showModel is false", () => {
    const tag = buildModelThinkingTag("27b_mtp", "high", { showModel: false, showThinking: true });
    expect(tag).toBe("(high)");
  });
});
