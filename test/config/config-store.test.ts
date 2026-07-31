/**
 * config-store.test.ts — Tests the ConfigStore interface directly.
 *
 * Interface is the test surface: in-memory ConfigIO, stub widget/manager.
 * No state.ts / config-io / config-mutator mocking — the store owns its state.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { AgentWidget } from "../../src/ui/agent-widget.ts";
import type { AgentManager } from "../../src/agents/agent-manager.ts";
import type { SubagentsConfig } from "../../src/models/model-precedence.ts";

function defaultConfig(): SubagentsConfig {
  // Matches the defaults merged by loadConfig when no config file exists
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
      showTools: false,
      showTurns: true,
      showInput: true,
      showOutput: true,
      showContext: true,
      showCost: false,
      showTime: true,
    },
    concurrency: { default: 4 },
  };
}

/** In-memory ConfigIO. Merges initial config with defaults (matches loadConfig behavior). */
function memIO(initial: Partial<SubagentsConfig> = defaultConfig()): { io: ConfigIO; saves: SubagentsConfig[]; current: () => SubagentsConfig } {
  // Merge with defaults like loadConfig does
  const merged: SubagentsConfig = {
    agent: { ...(defaultConfig().agent), ...(initial.agent ?? {}) },
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
    current: () => cur,
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

function managerStub(): { m: AgentManager; concurrencies: unknown[]; retentions: number[] } {
  const concurrencies: unknown[] = [];
  const retentions: number[] = [];
  const m = {
    setConcurrency: (c: unknown) => concurrencies.push(c),
    setRetentionMinutes: (n: number) => retentions.push(n),
  };
  return { m: m as unknown as AgentManager, concurrencies, retentions };
}

/* ------------------------------------------------------------------ */
/*  Reads & defaults                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore reads", () => {
  it("bakes in scalar defaults when fields are absent", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.graceTurns).toBe(6);
    expect(store.agent.showCost).toBe(false);
    expect(store.agent.forceBackground).toBe(false);
    expect(store.agent.widgetMaxLines).toBe(12);
    expect(store.agent.widgetMaxLinesCompact).toBe(6);
    expect(store.agent.widgetCompact).toBe(false);
    expect(store.agent.widgetShortcut).toBe(false);
    expect(store.agent.defaultModel).toBeNull();
    expect(store.agent.finishedRetentionMinutes).toBe(10);
  });

  it("returns configured values when present", () => {
    const { io } = memIO({
      agent: { default: "config/default", forceBackground: true, graceTurns: 9, showCost: true, widgetMaxLines: 20, widgetMaxLinesCompact: 7, widgetCompact: true, widgetShortcut: true },
      concurrency: { default: 2 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.showCost).toBe(true);
    expect(store.agent.widgetMaxLines).toBe(20);
    expect(store.agent.widgetMaxLinesCompact).toBe(7);
    expect(store.concurrency.default).toBe(2);
    expect(store.agent.defaultModel).toBe("config/default");
  });

  it("concurrency providers/models default to {}", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.concurrency.providers).toEqual({});
    expect(store.concurrency.models).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/*  Model resolution                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore model resolution", () => {
  it("session per-type override wins", () => {
    const { io } = memIO({ agent: { default: "config/default", forceBackground: false, Explore: "config/explore" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    expect(store.modelFor("Explore", "parent", { model: "frontmatter" })).toBe("session/explore");
  });

  it("falls through config -> frontmatter -> parent", () => {
    const { io } = memIO({ agent: { default: "config/default", forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.modelFor("Explore", "parent", { model: "frontmatter" })).toBe("config/default");
    expect(store.modelFor("Explore", "parent")).toBe("config/default");
  });

  it("returns parentModelId when nothing else is set", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
  });
});

/* ------------------------------------------------------------------ */
/*  Persisted mutations — behavioral tests                              */
/* ------------------------------------------------------------------ */

describe("ConfigStore persisted mutations", () => {
  it("setShowCost persists and syncs the widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.agent.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.showCost).toBe(true);
    expect(calls).toContain("setShowCost:true");
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
  });

  it("setWidgetMaxLines derives compact when unset and syncs the widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;

    store.mutate.widget.setMaxLines(20);
    expect(saves[0].agent.widgetMaxLines).toBe(20);
    expect(saves[0].agent.widgetMaxLinesCompact).toBe(10);
    expect(calls).toContain("setMaxLines:20");
    expect(calls).toContain("setMaxLinesCompact:10");
  });

  it("setMaxLines does not overwrite an explicitly-set compact value", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, widgetMaxLinesCompact: 3 }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.widget.setMaxLines(20);
    expect(store.agentConfigSnapshot().widgetMaxLinesCompact).toBe(3);
  });

  it("setWidgetCompact persists and syncs widget", () => {
    const { io } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.widget.setCompact(true);
    expect(store.agent.widgetCompact).toBe(true);
    expect(calls).toContain("setForceCompact:true");
  });

  it("setShortcut persists but does not sync widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.widget.setShortcut(true);
    expect(saves[0].agent.widgetShortcut).toBe(true);
    expect(calls.some((c) => c.startsWith("setWidgetShortcut"))).toBe(false);
  });

  it("concurrency setters persist and call manager.setConcurrency", () => {
    const { io, saves } = memIO();
    const { m, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    concurrencies.length = 0;

    store.mutate.concurrency.setDefault(8);
    store.mutate.concurrency.setProvider("llamacpp", 2);
    store.mutate.concurrency.setModel("anthropic/claude", 3);

    expect(store.concurrency.default).toBe(8);
    expect(store.concurrency.providers).toEqual({ llamacpp: 2 });
    expect(store.concurrency.models).toEqual({ "anthropic/claude": 3 });
    expect(saves).toHaveLength(3);
    expect(concurrencies).toHaveLength(3);
  });

  it("removeProvider / removeModel delete and re-sync", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4, providers: { llamacpp: 2 }, models: { "a/b": 1 } } });
    const { m } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    store.mutate.concurrency.removeProvider("llamacpp");
    store.mutate.concurrency.removeModel("a/b");
    expect(store.concurrency.providers).toEqual({});
    expect(store.concurrency.models).toEqual({});
  });

  it("resetConcurrency restores defaults and re-syncs", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4, providers: { x: 1 } } });
    const store = new ConfigStore(io);
    store.mutate.concurrency.reset();
    expect(store.concurrency.default).toBe(4);
    expect(store.concurrency.providers).toEqual({});
  });

  it("setFinishedRetentionMinutes persists and calls manager", () => {
    const { io, saves } = memIO();
    const { m, retentions } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    retentions.length = 0;

    store.mutate.agent.setFinishedRetentionMinutes(15);
    expect(store.agent.finishedRetentionMinutes).toBe(15);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.finishedRetentionMinutes).toBe(15);
    expect(retentions).toEqual([15]);
  });

  it("setFinishedRetentionMinutes clamps to minimum 1", () => {
    const { io, saves } = memIO();
    const { m, retentions } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    retentions.length = 0;

    store.mutate.agent.setFinishedRetentionMinutes(0);
    expect(store.agent.finishedRetentionMinutes).toBe(1);
    expect(saves[0].agent.finishedRetentionMinutes).toBe(1);
    expect(retentions).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ */
/*  Model-override clearing                                             */
/* ------------------------------------------------------------------ */

describe("ConfigStore model-override clearing", () => {
  it("clearModelOverride removes a single per-type override", () => {
    const { io, saves } = memIO({ agent: { default: null, forceBackground: false, Explore: "m1", general: "m2" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.agent.clearModelOverride("Explore");
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
    expect(store.agentConfigSnapshot().general).toBe("m2");
    expect(saves).toHaveLength(1);
  });

  it("clearAllModelOverrides preserves non-model settings, drops per-type overrides", () => {
    const { io } = memIO({
      agent: { default: "keep-default", forceBackground: true, graceTurns: 7, showCost: true, widgetMaxLines: 14, Explore: "m1", general: "m2" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.Explore).toBeUndefined();
    expect(snap.general).toBeUndefined();
    expect(snap.default).toBe("keep-default");
    expect(snap.forceBackground).toBe(true);
    expect(snap.graceTurns).toBe(7);
    expect(snap.showCost).toBe(true);
    expect(snap.widgetMaxLines).toBe(14);
  });
});

/* ------------------------------------------------------------------ */
/*  Session showCost override                                           */
/* ------------------------------------------------------------------ */

describe("ConfigStore session showCost override", () => {
  it("session setShowCost overrides config value", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.showCost).toBe(false);
    store.mutate.session.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
  });

  it("session setShowCost is not persisted", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.session.setShowCost(true);
    expect(saves).toHaveLength(0);
    expect(store.agent.showCost).toBe(true);
  });

  it("session clearShowCost reverts to config value", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.session.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    store.mutate.session.clearShowCost();
    expect(store.agent.showCost).toBe(false);
  });

  it("session setShowCost syncs to widget", () => {
    const { io } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.session.setShowCost(true);
    expect(calls).toContain("setShowCost:true");
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
  });

  it("session clearShowCost syncs config value to widget", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: true }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.session.setShowCost(false);
    expect(calls).toContain("setShowCost:false");
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
    calls.length = 0;
    store.mutate.session.clearShowCost();
    expect(calls).toContain("setShowCost:true");
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
  });

  it("reload clears session showCost override", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.session.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    store.reload();
    expect(store.agent.showCost).toBe(false);
  });

  it("hasSessionShowCost reflects session state", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    expect(store.hasSessionShowCost).toBe(false);
    store.mutate.session.setShowCost(true);
    expect(store.hasSessionShowCost).toBe(true);
    store.mutate.session.clearShowCost();
    expect(store.hasSessionShowCost).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Session overrides                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore session overrides", () => {
  it("are not persisted", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.session.setOverride("Explore", "session/model");
    store.mutate.session.clearOverride("Explore");
    store.mutate.session.clearAll();
    expect(saves).toHaveLength(0);
  });

  it("are readable and affect modelFor", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.session.setOverride("Explore", "session/explore");
    expect(store.sessionModelOverride("Explore")).toBe("session/explore");
    expect(store.modelFor("Explore", "parent")).toBe("session/explore");
  });

  it("clearAll resets to { default: null }", () => {
    const store = new ConfigStore(memIO().io);
    store.mutate.session.setOverride("Explore", "x");
    store.mutate.session.setOverride("default", "y");
    store.mutate.session.clearAll();
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.sessionDefaultModel).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Generic agent properties — defaults, configured, persist, preserve  */
/* ------------------------------------------------------------------ */

describe("ConfigStore agent properties", () => {
  it("boolean properties default correctly", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.includeContextFiles).toBe(true);
    expect(store.agent.loadSkillsImplicitly).toBe(true);
    expect(store.agent.loadExtensionsImplicitly).toBe(true);
    expect(store.agent.disableDefaultAgents).toBe(false);
  });

  it("string property defaults to 'replace'", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.systemPromptMode).toBe("replace");
  });

  it("optional properties default to undefined", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
  });

  it("widgetDescLength defaults: full=50, compact=30", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.widgetDescLengthFull).toBe(50);
    expect(store.agent.widgetDescLengthCompact).toBe(30);
  });

  it("configured values override defaults", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, includeContextFiles: false, systemPromptMode: "custom", defaultThinking: "high", defaultMaxTurns: 50, widgetDescLengthFull: 80, widgetDescLengthCompact: 20, loadSkillsImplicitly: false, loadExtensionsImplicitly: false, disableDefaultAgents: true },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.includeContextFiles).toBe(false);
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(store.agent.defaultThinking).toBe("high");
    expect(store.agent.defaultMaxTurns).toBe(50);
    expect(store.agent.widgetDescLengthFull).toBe(80);
    expect(store.agent.widgetDescLengthCompact).toBe(20);
    expect(store.agent.loadSkillsImplicitly).toBe(false);
    expect(store.agent.loadExtensionsImplicitly).toBe(false);
    expect(store.agent.disableDefaultAgents).toBe(true);
  });

  it("setters persist values", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setIncludeContextFiles(false);
    store.mutate.agent.setSystemPromptMode("custom");
    store.mutate.agent.setDefaultThinking("medium");
    store.mutate.agent.setDefaultMaxTurns(30);
    store.mutate.agent.setLoadSkillsImplicitly(false);
    store.mutate.agent.setLoadExtensionsImplicitly(false);
    store.mutate.agent.setDisableDefaultAgents(true);

    expect(store.agent.includeContextFiles).toBe(false);
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(store.agent.defaultThinking).toBe("medium");
    expect(store.agent.defaultMaxTurns).toBe(30);
    expect(store.agent.loadSkillsImplicitly).toBe(false);
    expect(store.agent.loadExtensionsImplicitly).toBe(false);
    expect(store.agent.disableDefaultAgents).toBe(true);
    expect(saves).toHaveLength(7);
  });

  it("setDescLengthFull/Compact persist and sync widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.widget.setDescLengthFull(80);
    expect(store.agent.widgetDescLengthFull).toBe(80);
    expect(saves).toHaveLength(1);
    expect(calls).toContain("setDescLengthFull:80");

    calls.length = 0;
    saves.length = 0;
    store.mutate.widget.setDescLengthCompact(20);
    expect(store.agent.widgetDescLengthCompact).toBe(20);
    expect(saves).toHaveLength(1);
    expect(calls).toContain("setDescLengthCompact:20");
  });

  it("setDefaultThinking/MaxTurns(undefined) removes the field", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, defaultThinking: "high", defaultMaxTurns: 50 }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultThinking(undefined);
    store.mutate.agent.setDefaultMaxTurns(undefined);
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultThinking).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultMaxTurns).toBeUndefined();
  });

  it("clearAllModelOverrides preserves all agent properties", () => {
    const { io } = memIO({
      agent: { default: "keep", forceBackground: true, includeContextFiles: false, systemPromptMode: "custom", defaultThinking: "low", defaultMaxTurns: 25, widgetDescLengthFull: 80, widgetDescLengthCompact: 20, loadSkillsImplicitly: false, loadExtensionsImplicitly: false, disableDefaultAgents: true, showTools: false, Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.includeContextFiles).toBe(false);
    expect(snap.systemPromptMode).toBe("custom");
    expect(snap.defaultThinking).toBe("low");
    expect(snap.defaultMaxTurns).toBe(25);
    expect(snap.widgetDescLengthFull).toBe(80);
    expect(snap.widgetDescLengthCompact).toBe(20);
    expect(snap.loadSkillsImplicitly).toBe(false);
    expect(snap.loadExtensionsImplicitly).toBe(false);
    expect(snap.disableDefaultAgents).toBe(true);
    expect(snap.showTools).toBe(false);
    expect(snap.Explore).toBeUndefined();
  });

  it("reload syncs desc length settings to widget", () => {
    const { io, current } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    current().agent.widgetDescLengthFull = 100;
    current().agent.widgetDescLengthCompact = 15;
    store.reload();
    expect(calls).toContain("setDescLengthFull:100");
    expect(calls).toContain("setDescLengthCompact:15");
  });
});

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

describe("ConfigStore lifecycle", () => {
  it("reload re-reads disk and resets session overrides", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    store.mutate.agent.setGraceTurns(11);

    current().agent.graceTurns = 5;
    store.reload();

    expect(store.agent.graceTurns).toBe(5);
    expect(store.sessionModelOverride("Explore")).toBeNull();
  });

  it("reload re-syncs deps", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: true, widgetCompact: true }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.reload();
    expect(calls).toContain("setShowCost:true");
    expect(calls).toContain("setForceCompact:true");
  });

  it("reload re-syncs retention to manager", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, finishedRetentionMinutes: 20 } });
    const { m, retentions } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    retentions.length = 0;
    store.reload();
    expect(retentions).toContain(20);
  });

  it("setDeps re-syncs widget settings from current config", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, widgetMaxLines: 30, showCost: true }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    expect(calls).toContain("setMaxLines:30");
    expect(calls).toContain("setShowCost:true");
  });

  it("dispose drops deps so mutations no longer sync", () => {
    const { io } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    store.dispose();
    calls.length = 0;
    store.mutate.agent.setShowCost(true);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  notifyToolsExpanded                                                 */
/* ------------------------------------------------------------------ */

describe("ConfigStore notifyToolsExpanded", () => {
  it("toggles widget compact mode only when shortcut is enabled and compact is off", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, widgetShortcut: true, widgetCompact: false }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });

    store.notifyToolsExpanded(false); // initial transition from undefined -> ignored
    calls.length = 0;
    store.notifyToolsExpanded(true); // expanded -> full
    store.notifyToolsExpanded(false); // collapsed -> compact
    expect(calls).toContain("setCompactMode:true");
  });

  it("is a no-op when widgetShortcut is disabled", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, widgetShortcut: false }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.notifyToolsExpanded(true);
    store.notifyToolsExpanded(false);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when widgetCompact is forced on", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, widgetShortcut: true, widgetCompact: true }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.notifyToolsExpanded(true);
    store.notifyToolsExpanded(false);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  show* stats visibility                                               */
/* ------------------------------------------------------------------ */

describe("ConfigStore show* stats visibility", () => {
  it("showTools and deltaInputTokens default to false, rest default to true", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.showTools).toBe(false);
    expect(store.agent.showTurns).toBe(true);
    expect(store.agent.showInput).toBe(true);
    expect(store.agent.showOutput).toBe(true);
    expect(store.agent.showContext).toBe(true);
    expect(store.agent.showTime).toBe(true);
  });

  it("configured false values are respected", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, showTools: false, showTurns: false, showInput: false, showOutput: false, showContext: false, showTime: false },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.showTools).toBe(false);
    expect(store.agent.showTurns).toBe(false);
    expect(store.agent.showInput).toBe(false);
    expect(store.agent.showOutput).toBe(false);
    expect(store.agent.showContext).toBe(false);
    expect(store.agent.showTime).toBe(false);
  });

  it("setShowTools persists and syncs to widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.agent.setShowTools(false);
    expect(store.agent.showTools).toBe(false);
    expect(saves).toHaveLength(1);
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
  });

  it("reload syncs stats visibility to widget", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showTools: false }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.reload();
    expect(calls.some(c => c.startsWith("setStatsVisibility:" ))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  outputThinkingBufferSize                                            */
/* ------------------------------------------------------------------ */

describe("ConfigStore outputThinkingBufferSize", () => {
  it("defaults to 0 when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.outputThinkingBufferSize).toBe(0);
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, outputThinkingBufferSize: 80 },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputThinkingBufferSize).toBe(80);
  });

  it("setOutputThinkingBufferSize persists value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;

    store.mutate.agent.setOutputThinkingBufferSize(200);
    expect(store.agent.outputThinkingBufferSize).toBe(200);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.outputThinkingBufferSize).toBe(200);
  });

  it("setOutputThinkingBufferSize(0) persists and clears the setting", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, outputThinkingBufferSize: 80 },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputThinkingBufferSize).toBe(80);

    store.mutate.agent.setOutputThinkingBufferSize(0);
    expect(store.agent.outputThinkingBufferSize).toBe(0);
    expect(store.agentConfigSnapshot().outputThinkingBufferSize).toBe(0);
  });

  it("clearAllModelOverrides preserves outputThinkingBufferSize", () => {
    const { io } = memIO({
      agent: { default: "keep", forceBackground: true, outputThinkingBufferSize: 500, Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.outputThinkingBufferSize).toBe(500);
    expect(snap.Explore).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  statusBarFormat                                                     */
/* ------------------------------------------------------------------ */

describe("ConfigStore statusBarFormat", () => {
  it("defaults to 'full' when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.statusBarFormat).toBe("full");
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      agent: { default: null, forceBackground: false, statusBarFormat: "compact" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    expect(store.agent.statusBarFormat).toBe("compact");
  });

  it("setStatusBarFormat persists and syncs to widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.widget.setStatusBarFormat("compact");
    expect(store.agent.statusBarFormat).toBe("compact");
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.statusBarFormat).toBe("compact");
    expect(calls).toContain("setStatusBarFormat:compact");
  });

  it("reload syncs statusBarFormat to widget", () => {
    const { io, current } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    current().agent.statusBarFormat = "compact";
    store.reload();
    expect(calls).toContain("setStatusBarFormat:compact");
  });
});
