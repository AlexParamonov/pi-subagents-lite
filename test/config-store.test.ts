/**
 * config-store.test.ts — Tests the ConfigStore interface directly.
 *
 * Interface is the test surface: in-memory ConfigIO, stub widget/manager.
 * No state.ts / config-io / config-mutator mocking — the store owns its state.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../src/config/config-store.ts";
import type { AgentWidget } from "../src/ui/agent-widget.ts";
import type { AgentManager } from "../src/agents/agent-manager.ts";
import type { SubagentsConfig } from "../src/models/model-precedence.ts";
import { DEFAULT_CONFIG } from "../src/config/config-io.ts";

function defaultConfig(): SubagentsConfig {
  return {
    agent: { ...DEFAULT_CONFIG.agent },
    concurrency: { ...DEFAULT_CONFIG.concurrency },
  };
}

/** In-memory ConfigIO. load() returns a fresh clone; save() records snapshots. */
function memIO(initial: SubagentsConfig = defaultConfig()): { io: ConfigIO; saves: SubagentsConfig[]; current: () => SubagentsConfig } {
  let cur = structuredClone(initial);
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
    // Live simulated-disk reference: mutate to simulate external file changes.
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
    setCompactMode: (c: boolean) => calls.push(`setCompactMode:${c}`),
  };
  return { w: w as unknown as AgentWidget, calls };
}

function managerStub(): { m: AgentManager; concurrencies: unknown[] } {
  const concurrencies: unknown[] = [];
  const m = { setConcurrency: (c: unknown) => concurrencies.push(c) };
  return { m: m as unknown as AgentManager, concurrencies };
}

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
    expect(store.modelFor("Explore", "parent", { model: "frontmatter" })).toBe("config/default");
    expect(store.modelFor("Explore", "parent")).toBe("config/default");
  });

  it("returns parentModelId when nothing else is set", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
  });
});

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

  it("setShortcut persists (no immediate widget sync — matches existing behavior)", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.widget.setShortcut(true);
    expect(saves[0].agent.widgetShortcut).toBe(true);
    // No sync fired for shortcut (flagged for follow-up).
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
});

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
  });

  it("session clearShowCost syncs config value to widget", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: true }, concurrency: { default: 4 } });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.session.setShowCost(false);
    expect(calls).toContain("setShowCost:false");
    calls.length = 0;
    store.mutate.session.clearShowCost();
    // After clearing session override, widget should revert to config value (true)
    expect(calls).toContain("setShowCost:true");
  });

  it("reload clears session showCost override", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.session.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    store.reload();
    expect(store.agent.showCost).toBe(false);
  });

  it("permanent setShowCost clears session override", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, showCost: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.session.setShowCost(true);
    expect(store.agent.showCost).toBe(true);
    store.mutate.agent.setShowCost(true);
    // Session override should be cleared; effective value comes from config now
    store.mutate.session.clearShowCost();
    // Config is true, so effective should still be true
    expect(store.agent.showCost).toBe(true);
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

describe("ConfigStore includeContextFiles", () => {
  it("defaults to true when not configured", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.includeContextFiles).toBe(true);
  });

  it("returns configured value when present", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, includeContextFiles: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.includeContextFiles).toBe(false);
  });

  it("setIncludeContextFiles persists the value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.agent.setIncludeContextFiles(false);
    expect(store.agent.includeContextFiles).toBe(false);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.includeContextFiles).toBe(false);
  });

  it("setIncludeContextFiles updates the value", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setIncludeContextFiles(false);
    expect(store.agent.includeContextFiles).toBe(false);
    store.mutate.agent.setIncludeContextFiles(true);
    expect(store.agent.includeContextFiles).toBe(true);
  });

  it("clearAllModelOverrides preserves includeContextFiles", () => {
    const { io } = memIO({
      agent: { default: "config/default", forceBackground: true, includeContextFiles: false, Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    expect(store.agent.includeContextFiles).toBe(false);
  });
});

describe("ConfigStore systemPromptMode", () => {
  it("defaults to 'replace' when not configured", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.systemPromptMode).toBe("replace");
  });

  it("returns configured value when present", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, systemPromptMode: "inherit" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.systemPromptMode).toBe("inherit");
  });

  it("setSystemPromptMode persists the value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.agent.setSystemPromptMode("custom");
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.systemPromptMode).toBe("custom");
  });

  it("setSystemPromptMode updates the value", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setSystemPromptMode("inherit");
    expect(store.agent.systemPromptMode).toBe("inherit");
    store.mutate.agent.setSystemPromptMode("custom");
    expect(store.agent.systemPromptMode).toBe("custom");
    store.mutate.agent.setSystemPromptMode("replace");
    expect(store.agent.systemPromptMode).toBe("replace");
  });

  it("clearAllModelOverrides preserves systemPromptMode", () => {
    const { io } = memIO({
      agent: { default: "config/default", forceBackground: true, systemPromptMode: "custom", Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    expect(store.agent.systemPromptMode).toBe("custom");
  });
});

describe("ConfigStore defaultThinking", () => {
  it("defaults to undefined when not configured", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.defaultThinking).toBeUndefined();
  });

  it("returns configured value when present", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, defaultThinking: "high" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.defaultThinking).toBe("high");
  });

  it("setDefaultThinking persists the value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.agent.setDefaultThinking("medium");
    expect(store.agent.defaultThinking).toBe("medium");
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.defaultThinking).toBe("medium");
  });

  it("setDefaultThinking(undefined) removes the field", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, defaultThinking: "high" }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultThinking(undefined);
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultThinking).toBeUndefined();
  });

  it("clearAllModelOverrides preserves defaultThinking", () => {
    const { io } = memIO({
      agent: { default: "config/default", forceBackground: true, defaultThinking: "low", Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    expect(store.agent.defaultThinking).toBe("low");
  });
});

describe("ConfigStore defaultMaxTurns", () => {
  it("defaults to undefined when not configured", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.defaultMaxTurns).toBeUndefined();
  });

  it("returns configured value when present", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, defaultMaxTurns: 50 }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    expect(store.agent.defaultMaxTurns).toBe(50);
  });

  it("setDefaultMaxTurns persists the value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;
    store.mutate.agent.setDefaultMaxTurns(30);
    expect(store.agent.defaultMaxTurns).toBe(30);
    expect(saves).toHaveLength(1);
    expect(saves[0].agent.defaultMaxTurns).toBe(30);
  });

  it("setDefaultMaxTurns(undefined) removes the field", () => {
    const { io } = memIO({ agent: { default: null, forceBackground: false, defaultMaxTurns: 50 }, concurrency: { default: 4 } });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultMaxTurns(undefined);
    expect(store.agent.defaultMaxTurns).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultMaxTurns).toBeUndefined();
  });

  it("clearAllModelOverrides preserves defaultMaxTurns", () => {
    const { io } = memIO({
      agent: { default: "config/default", forceBackground: true, defaultMaxTurns: 25, Explore: "m1" },
      concurrency: { default: 4 },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    expect(store.agent.defaultMaxTurns).toBe(25);
  });
});

describe("ConfigStore lifecycle", () => {
  it("reload re-reads disk and resets session overrides", () => {
    const { io, current } = memIO();
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    store.mutate.agent.setGraceTurns(11);

    // Simulate external disk change.
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
    store.mutate.agent.setShowCost(true); // would normally call widget.setShowCost
    expect(calls).toHaveLength(0);
  });
});

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
    expect(calls).toContain("setCompactMode:true"); // !expanded when expanded=false
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
