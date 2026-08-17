/**
 * config-store.test.ts — ConfigStore core semantics.
 *
 * Interface is the test surface: in-memory ConfigIO, stub widget/manager
 * (shared helpers in config-store-helpers.ts). The effective config resolves
 * session → project → global → defaults, and mutations write only the
 * targeted layer (ADR-0008). Session-only state and concurrency-layer
 * targeting live in config-store-session.test.ts and
 * config-store-concurrency.test.ts; widget-facing settings in
 * config-store-widget-sync.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import type { ConfigIO } from "../../src/config/config-store.js";
import type { RawConfig } from "../../src/config/config-io.js";
import { memIO, minimalIO, widgetStub, managerStub, statsVisibilityPayloads } from "./config-store-helpers.js";

/* ------------------------------------------------------------------ */
/*  Reads & defaults                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore reads", () => {
  it("bakes in scalar defaults when fields are absent", () => {
    // The loaded layers carry no values, so the assertions below pin the
    // defaults merge — deleting a default must fail this test.
    const store = new ConfigStore(minimalIO());
    expect(store.agent.graceTurns).toBe(6);
    expect(store.agent.showCost).toBe(false);
    expect(store.agent.forceBackground).toBe(false);
    expect(store.agent.widgetCompact).toBe(false);
    expect(store.agent.showCompletionCards).toBe(true);
    expect(store.agent.widgetShortcut).toBe(false);
    expect(store.agent.defaultModel).toBeNull();
    expect(store.agent.finishedRetentionMinutes).toBe(1);
    expect(store.agent.toolTimeoutMinutes).toBe(45);
    expect(store.agent.idleTimeoutMinutes).toBe(45);
  });

  it("derives widgetMaxLinesCompact from widgetMaxLines when absent", () => {
    // widgetMaxLines itself is guaranteed by the defaults merge; the store
    // only defaults the derived compact variant.
    const io: ConfigIO = {
      load: () => ({ global: { agent: { widgetMaxLines: 12 } }, project: null, projectStatus: "untrusted" }),
      saveGlobal: () => {},
      saveProject: () => {},
    };
    const store = new ConfigStore(io);
    expect(store.agent.widgetMaxLines).toBe(12);
    expect(store.agent.widgetMaxLinesCompact).toBe(6);
  });

  it("returns configured values when present", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: "config/default",
          forceBackground: true,
          graceTurns: 9,
          showCost: true,
          widgetMaxLines: 20,
          widgetMaxLinesCompact: 7,
          widgetCompact: true,
          widgetShortcut: true,
        },
        concurrency: { default: 2 },
      },
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
/*  Override layers                                                    */
/* ------------------------------------------------------------------ */

describe("ConfigStore override layers", () => {
  it("effective agent merges project over global per key; project non-model keys are ignored", () => {
    const { io } = memIO({
      global: { agent: { default: "g/default", Explore: "g/explore", graceTurns: 5 } },
      project: { agent: { default: "p/default", graceTurns: 9 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    expect(store.agent.defaultModel).toBe("p/default");
    // graceTurns is not a project-allowed key: ignored in the merge.
    expect(store.agent.graceTurns).toBe(5);
    expect(store.agentConfigSnapshot().Explore).toBe("g/explore");
  });

  it("concurrency getter merges project over global per entry", () => {
    const { io } = memIO({
      global: { concurrency: { default: 2, providers: { a: 1, b: 2 }, models: { m: 1 } } },
      project: { concurrency: { default: 8, providers: { b: 9 } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    expect(store.concurrency.default).toBe(8);
    expect(store.concurrency.providers).toEqual({ a: 1, b: 9 });
    expect(store.concurrency.models).toEqual({ m: 1 });
  });

  it("projectTargetOffered follows the project layer status", () => {
    expect(new ConfigStore(memIO().io).projectTargetOffered).toBe(false);
    expect(new ConfigStore(memIO({ projectStatus: "absent" }).io).projectTargetOffered).toBe(true);
    expect(new ConfigStore(memIO({ project: {}, projectStatus: "loaded" }).io).projectTargetOffered).toBe(true);
    expect(new ConfigStore(memIO({ projectStatus: "malformed" }).io).projectTargetOffered).toBe(false);
  });

  it("an empty project layer is inert: effective config equals global-only", () => {
    const base = { global: { agent: { default: "g" }, concurrency: { default: 2 } } };
    const withEmpty = new ConfigStore(memIO({ ...base, project: {}, projectStatus: "loaded" }).io);
    const without = new ConfigStore(memIO({ ...base, project: null, projectStatus: "absent" }).io);
    expect(withEmpty.agent.defaultModel).toBe("g");
    expect(withEmpty.concurrency.default).toBe(2);
    expect(withEmpty.agentConfigSnapshot()).toEqual(without.agentConfigSnapshot());
    expect(withEmpty.concurrency).toEqual(without.concurrency);
  });

  it("exposes layer membership for provenance tags", () => {
    const { io } = memIO({
      global: { agent: { default: "g" } },
      project: { agent: { Explore: "p" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("general", "s");
    expect(store.hasGlobalModelKey("default")).toBe(true);
    expect(store.hasGlobalModelKey("Explore")).toBe(false);
    expect(store.hasProjectModelKey("Explore")).toBe(true);
    expect(store.hasProjectModelKey("default")).toBe(false);
    expect(store.projectConcurrency).toEqual({});
    expect(store.sessionConcurrency).toEqual({});
  });

  it("reports per-level model settings (model family or per-type key) for clear availability", () => {
    const { io } = memIO({
      global: { agent: { default: "g", Explore: "g/explore", graceTurns: 5 } },
      project: { agent: { defaultThinking: "low" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    // No session overrides yet.
    expect(store.hasSessionModelSettings).toBe(false);
    // Global: default + per-type keys (graceTurns is not a model key).
    expect(store.hasGlobalModelSettings).toBe(true);
    // Project: defaultThinking is a model-family key, so clear-all applies to it.
    expect(store.hasProjectModelSettings).toBe(true);

    store.mutate.session.setOverride("default", "s/default");
    expect(store.hasSessionModelSettings).toBe(true);
    store.mutate.session.clearOverride("default");
    store.mutate.session.setOverride("Explore", "s/explore");
    expect(store.hasSessionModelSettings).toBe(true);
    store.mutate.session.clearOverride("Explore");
    expect(store.hasSessionModelSettings).toBe(false);

    store.mutate.agent.clearAllModelOverrides("global");
    expect(store.hasGlobalModelSettings).toBe(false);
    store.mutate.agent.setModelOverride("Explore", "g/explore", "project");
    expect(store.hasProjectModelSettings).toBe(true);
  });

  it("hasGlobalModelSettings is false for an empty global layer", () => {
    const store = new ConfigStore(minimalIO());
    expect(store.hasGlobalModelSettings).toBe(false);
    expect(store.hasProjectModelSettings).toBe(false);
  });

  it("a project mutation writes only the project layer and overrides the global value", () => {
    const { io, saves, global } = memIO({
      global: { agent: { default: "g/default" } },
      project: { agent: {} },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultModel("p/default", "project");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("project");
    expect(saves[0].config).toEqual({ agent: { default: "p/default" } });
    expect(global()).toEqual({ agent: { default: "g/default" } });
    expect(store.agent.defaultModel).toBe("p/default");
  });

  it("global writes leave the project file untouched and never carry merged or default values", () => {
    const { io, saves, project } = memIO({
      global: { agent: { graceTurns: 5 } },
      project: { agent: { default: "p" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.setModelOverride("Explore", "g/explore");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
    expect(saves[0].config).toEqual({ agent: { graceTurns: 5, Explore: "g/explore" } });
    // No baked defaults, no project keys: the merged config is never written.
    expect("widgetMaxLines" in saves[0].config.agent!).toBe(false);
    expect("default" in saves[0].config.agent!).toBe(false);
    expect(project()).toEqual({ agent: { default: "p" } });
  });

  it("non-model setters always write the global layer", () => {
    const { io, saves, project } = memIO({
      global: {},
      project: { agent: {} },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.setGraceTurns(9);
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
    expect(project()).toEqual({ agent: {} });
  });

  it("clearing a project model key deletes it and the global value applies again", () => {
    const { io, saves } = memIO({
      global: { agent: { default: "g", Explore: "g/explore" } },
      project: { agent: { Explore: "p/explore" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearModelOverride("Explore", "project");
    expect(saves[saves.length - 1].layer).toBe("project");
    expect(saves[saves.length - 1].config).toEqual({ agent: {} });
    expect(store.agentConfigSnapshot().Explore).toBe("g/explore");
  });

  it("clearModelOverride at session clears only the session layer", () => {
    const { io, saves } = memIO({
      global: { agent: { Explore: "g/explore" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "s/explore");
    store.mutate.agent.clearModelOverride("Explore", "session");
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.agentConfigSnapshot().Explore).toBe("g/explore");
    expect(saves).toHaveLength(0);
  });

  it("clearModelOverride at all levels clears session, global and project", () => {
    const { io, saves } = memIO({
      global: { agent: { Explore: "g/explore" } },
      project: { agent: { Explore: "p/explore" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "s/explore");
    store.mutate.agent.clearModelOverride("Explore", "all");
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
    expect(saves).toHaveLength(2);
    expect(saves[0].layer).toBe("global");
    expect(saves[1].layer).toBe("project");
    expect(saves[0].config.agent).toEqual({});
    expect(saves[1].config.agent).toEqual({});
  });

  it("mutating the project layer without a trusted project is refused with a warning", () => {
    const { io, saves } = memIO({ projectStatus: "untrusted" });
    const store = new ConfigStore(io);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      store.mutate.agent.setDefaultModel("x", "project");
      store.mutate.concurrency.setDefault(8, "project");
      expect(saves).toHaveLength(0);
      expect(store.agent.defaultModel).toBeNull();
      expect(store.concurrency.default).toBe(4);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("mutating the project layer when the file is malformed is refused; nothing is saved", () => {
    const { io, saves } = memIO({ projectStatus: "malformed" });
    const store = new ConfigStore(io);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      store.mutate.agent.setDefaultModel("x", "project");
      expect(saves).toHaveLength(0);
      expect(store.agent.defaultModel).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("the first project write in a trusted project without a file creates the layer", () => {
    const { io, saves, project } = memIO({ projectStatus: "absent" });
    const store = new ConfigStore(io);
    store.mutate.agent.setModelOverride("Explore", "p/explore", "project");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("project");
    expect(project()).toEqual({ agent: { Explore: "p/explore" } });
    expect(store.agentConfigSnapshot().Explore).toBe("p/explore");
  });

  it("setDefaultModel at session sets the session default without persisting", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultModel("s/default", "session");
    expect(store.sessionDefaultModel).toBe("s/default");
    expect(store.modelFor("Explore", "parent")).toBe("s/default");
    expect(saves).toHaveLength(0);
  });

  it("setDefaultThinking and setDefaultMaxTurns write to the project layer when targeted", () => {
    const { io, saves } = memIO({ project: { agent: {} }, projectStatus: "loaded" });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultThinking("high", "project");
    store.mutate.agent.setDefaultMaxTurns(30, "project");
    expect(store.agent.defaultThinking).toBe("high");
    expect(store.agent.defaultMaxTurns).toBe(30);
    expect(saves).toHaveLength(2);
    expect(saves[1].layer).toBe("project");
    expect(saves[1].config.agent).toEqual({ defaultThinking: "high", defaultMaxTurns: 30 });

    store.mutate.agent.setDefaultThinking(undefined, "project");
    store.mutate.agent.setDefaultMaxTurns(undefined, "project");
    expect(saves[saves.length - 1].config.agent).toEqual({});
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
  });

  it("clearDefaultMaxTurns at project deletes only the project key", () => {
    const { io, saves } = memIO({
      global: { agent: { defaultMaxTurns: 50 } },
      project: { agent: { defaultMaxTurns: 30 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearDefaultMaxTurns("project");
    expect(store.agent.defaultMaxTurns).toBe(50); // falls through to global
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("project");
    expect(saves[0].config.agent).toEqual({});
  });

  it("clearDefaultMaxTurns at all levels clears global and project", () => {
    const { io, saves } = memIO({
      global: { agent: { defaultMaxTurns: 50 } },
      project: { agent: { defaultMaxTurns: 30 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearDefaultMaxTurns("all");
    expect(store.agent.defaultMaxTurns).toBeUndefined();
    expect(saves).toHaveLength(2);
    expect(saves[0].layer).toBe("global");
    expect(saves[1].layer).toBe("project");
  });

  it("clearDefaultMaxTurns at all levels skips the project layer when it is not offered", () => {
    const { io, saves } = memIO({ global: { agent: { defaultMaxTurns: 50 } } });
    const store = new ConfigStore(io);
    store.mutate.agent.clearDefaultMaxTurns("all");
    expect(store.agent.defaultMaxTurns).toBeUndefined();
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
  });

  it("clearAllModelOverrides at project clears model keys and preserves unknown keys", () => {
    const { io, saves } = memIO({
      global: { agent: { default: "g", defaultThinking: "high", Explore: "g/explore" } },
      project: { agent: { default: "p", defaultThinking: "low", Explore: "p/explore", graceTurns: 9 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides("project");
    expect(saves[0].layer).toBe("project");
    expect(saves[0].config).toEqual({ agent: { graceTurns: 9 } });
    expect(store.agent.defaultModel).toBe("g");
    expect(store.agent.defaultThinking).toBe("high");
    expect(store.agentConfigSnapshot().Explore).toBe("g/explore");
  });

  it("clearAllModelOverrides at all levels clears session, global and project model keys", () => {
    const { io, saves } = memIO({
      global: { agent: { default: "g", Explore: "g/explore", graceTurns: 7 } },
      project: { agent: { default: "p" } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "s/explore");
    store.mutate.agent.clearAllModelOverrides("all");
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.agentConfigSnapshot().default).toBeNull(); // falls through to built-in
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
    expect(store.agentConfigSnapshot().graceTurns).toBe(7);
    expect(saves).toHaveLength(2);
    expect(saves[0].config.agent).toEqual({ graceTurns: 7 });
    expect(saves[1].config.agent).toEqual({});
  });

  it("clear-all at all levels skips the project layer when it is not offered", () => {
    const { io, saves } = memIO({ global: { agent: { Explore: "g/explore" } } });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides("all");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
  });

  it("clear-all at all levels in a trusted project without a file creates no project file", () => {
    const { io, saves, project } = memIO({ global: { agent: { Explore: "g" } }, projectStatus: "absent" });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides("all");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
    expect(project()).toBeNull();
  });

  it("clearModelOverride at all levels with no project file clears only global", () => {
    const { io, saves, project } = memIO({ global: { agent: { Explore: "g" } }, projectStatus: "absent" });
    const store = new ConfigStore(io);
    store.mutate.agent.clearModelOverride("Explore", "all");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
    expect(project()).toBeNull();
  });

  it("clearDefaultMaxTurns at all levels with no project file clears only global", () => {
    const { io, saves, project } = memIO({ global: { agent: { defaultMaxTurns: 50 } }, projectStatus: "absent" });
    const store = new ConfigStore(io);
    store.mutate.agent.clearDefaultMaxTurns("all");
    expect(saves).toHaveLength(1);
    expect(saves[0].layer).toBe("global");
    expect(project()).toBeNull();
  });

  it("clear-all at all levels after a project set still clears the layer created this session", () => {
    const { io, saves, project } = memIO({ global: { agent: { Explore: "g" } }, projectStatus: "absent" });
    const store = new ConfigStore(io);
    store.mutate.agent.setModelOverride("Explore", "p/explore", "project");
    store.mutate.agent.clearAllModelOverrides("all");
    expect(saves).toHaveLength(3);
    expect(saves[2].layer).toBe("project");
    expect(saves[2].config).toEqual({ agent: {} });
    expect(project()).toEqual({ agent: {} });
  });
});

/* ------------------------------------------------------------------ */
/*  Model resolution                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore model resolution", () => {
  it("session per-type override wins", () => {
    const { io } = memIO({
      global: {
        agent: { default: "config/default", forceBackground: false, Explore: "config/explore" },
        concurrency: { default: 4 },
      },
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    expect(store.modelFor("Explore", "parent", { model: "frontmatter" })).toBe("session/explore");
  });

  it("config default beats the frontmatter model; frontmatter applies without it", () => {
    const { io } = memIO({
      global: { agent: { default: "config/default", forceBackground: false }, concurrency: { default: 4 } },
    });
    const store = new ConfigStore(io);
    // The config default sits above the frontmatter model in the chain.
    expect(store.modelFor("Explore", "parent", { model: "frontmatter" })).toBe("config/default");
    expect(store.modelFor("Explore", "parent")).toBe("config/default");
  });

  it("returns parentModelId when nothing else is set", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
  });
});

/* ------------------------------------------------------------------ */
/*  Persisted mutations — behavioral tests                             */
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
    expect(saves[0].config.agent!.showCost).toBe(true);
    expect(calls).toContain("setShowCost:true");
    const payloads = statsVisibilityPayloads(calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].showCost).toBe(true);
    expect(payloads[0].showTools).toBe(false);
  });

  it("setWidgetMaxLines derives compact when unset and syncs the widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;

    store.mutate.widget.setMaxLines(20);
    expect(saves[0].config.agent!.widgetMaxLines).toBe(20);
    expect(saves[0].config.agent!.widgetMaxLinesCompact).toBe(10);
    expect(calls).toContain("setMaxLines:20");
    expect(calls).toContain("setMaxLinesCompact:10");
  });

  it("setMaxLines does not overwrite an explicitly-set compact value", () => {
    const { io } = memIO({
      global: { agent: { widgetMaxLinesCompact: 3 } },
    });
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

  it("setShowCompletionCards persists", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.widget.setShowCompletionCards(false);

    expect(store.agent.showCompletionCards).toBe(false);
    expect(saves[0].config.agent!.showCompletionCards).toBe(false);
  });

  it("setShortcut persists but does not sync widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.widget.setShortcut(true);
    expect(saves[0].config.agent!.widgetShortcut).toBe(true);
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
    const { io } = memIO({
      global: {
        agent: { default: null, forceBackground: false },
        concurrency: { default: 4, providers: { llamacpp: 2 }, models: { "a/b": 1 } },
      },
    });
    const { m } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    store.mutate.concurrency.removeProvider("llamacpp");
    store.mutate.concurrency.removeModel("a/b");
    expect(store.concurrency.providers).toEqual({});
    expect(store.concurrency.models).toEqual({});
  });

  it("setFinishedRetentionMinutes persists the value and syncs the widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });

    store.mutate.agent.setFinishedRetentionMinutes(15);
    expect(store.agent.finishedRetentionMinutes).toBe(15);
    expect(saves).toHaveLength(1);
    expect(saves[0].config.agent!.finishedRetentionMinutes).toBe(15);
    // Pushed to the widget so the window applies on the next render without restart.
    expect(calls).toContain("setFinishedRetentionMinutes:15");
  });

  it("setFinishedRetentionMinutes clamps to minimum 1", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setFinishedRetentionMinutes(0);
    expect(store.agent.finishedRetentionMinutes).toBeCloseTo(1 / 60, 5);
    expect(saves[0].config.agent!.finishedRetentionMinutes).toBeCloseTo(1 / 60, 5);
  });

  it("clamps a hand-edited finishedRetentionMinutes of 0 or negative at load", () => {
    // The setter clamps, but a hand-edited config flows through the load path
    // unclamped: 0 would hide every finished row in the widget (0 is not a valid window).
    for (const edited of [0, -5]) {
      const { io } = memIO({ global: { agent: { finishedRetentionMinutes: edited } } });
      const { w, calls } = widgetStub();
      const store = new ConfigStore(io);
      store.setDeps({ widget: w });

      expect(store.agent.finishedRetentionMinutes).toBeCloseTo(1 / 60, 5);
      // The widget receives the clamped window, not the degenerate value.
      expect(calls).toContain(`setFinishedRetentionMinutes:${1 / 60}`);
    }
  });

  it("setToolTimeoutMinutes and setIdleTimeoutMinutes persist and clamp to 0", () => {
    const { io, saves, global } = memIO();
    const store = new ConfigStore(io);

    store.mutate.agent.setToolTimeoutMinutes(30);
    expect(store.agent.toolTimeoutMinutes).toBe(30);
    expect(saves).toHaveLength(1);
    expect(global().agent!.toolTimeoutMinutes).toBe(30);

    store.mutate.agent.setIdleTimeoutMinutes(60);
    expect(store.agent.idleTimeoutMinutes).toBe(60);
    expect(global().agent!.idleTimeoutMinutes).toBe(60);
    expect(saves).toHaveLength(2);

    // 0 is the documented "disable" value and must survive (not clamp to 1).
    store.mutate.agent.setToolTimeoutMinutes(0);
    expect(store.agent.toolTimeoutMinutes).toBe(0);
    expect(global().agent!.toolTimeoutMinutes).toBe(0);

    // Negative values clamp to 0 (disabled), never negative.
    store.mutate.agent.setIdleTimeoutMinutes(-5);
    expect(store.agent.idleTimeoutMinutes).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Model-override clearing                                            */
/* ------------------------------------------------------------------ */

describe("ConfigStore model-override clearing", () => {
  it("clearModelOverride removes a single per-type override", () => {
    const { io, saves } = memIO({
      global: { agent: { default: null, forceBackground: false, Explore: "m1", general: "m2" } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearModelOverride("Explore");
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
    expect(store.agentConfigSnapshot().general).toBe("m2");
    expect(saves).toHaveLength(1);
  });

  it("clearAllModelOverrides clears the model family and per-type overrides, preserving non-model settings", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: "keep-default",
          forceBackground: true,
          graceTurns: 7,
          showCost: true,
          widgetMaxLines: 14,
          showCompletionCards: true,
          defaultThinking: "high",
          defaultMaxTurns: 30,
          Explore: "m1",
          general: "m2",
        },
        concurrency: { default: 4 },
      },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.Explore).toBeUndefined();
    expect(snap.general).toBeUndefined();
    // The model family clears too: default falls through to the built-in null,
    // thinking/max turns to undefined.
    expect(snap.default).toBeNull();
    expect(snap.defaultThinking).toBeUndefined();
    expect(snap.defaultMaxTurns).toBeUndefined();
    expect(snap.forceBackground).toBe(true);
    expect(snap.graceTurns).toBe(7);
    expect(snap.showCost).toBe(true);
    expect(snap.widgetMaxLines).toBe(14);
    expect(snap.showCompletionCards).toBe(true);
  });

  it("clearAllModelOverrides at session resets only the session layer", () => {
    const { io, saves } = memIO({
      global: { agent: { Explore: "g/explore" } },
    });
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "s/explore");
    store.mutate.agent.clearAllModelOverrides("session");
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.agentConfigSnapshot().Explore).toBe("g/explore");
    expect(saves).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Generic agent properties — defaults, configured, persist, preserve  */
/* ------------------------------------------------------------------ */

describe("ConfigStore agent properties", () => {
  it("boolean properties default correctly", () => {
    const store = new ConfigStore(minimalIO());
    expect(store.agent.includeContextFiles).toBe(true);
    expect(store.agent.loadSkillsImplicitly).toBe(true);
    expect(store.agent.loadExtensionsImplicitly).toBe(true);
    expect(store.agent.disableDefaultAgents).toBe(false);
  });

  it("string property defaults to 'replace'", () => {
    const store = new ConfigStore(minimalIO());
    expect(store.agent.systemPromptMode).toBe("replace");
  });

  it("optional properties default to undefined", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
  });

  it("configured values override defaults", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: null,
          forceBackground: false,
          includeContextFiles: false,
          systemPromptMode: "custom",
          defaultThinking: "high",
          defaultMaxTurns: 50,

          loadSkillsImplicitly: false,
          loadExtensionsImplicitly: false,
          disableDefaultAgents: true,
        },
      },
    });
    const store = new ConfigStore(io);
    expect(store.agent.includeContextFiles).toBe(false);
    expect(store.agent.systemPromptMode).toBe("custom");
    expect(store.agent.defaultThinking).toBe("high");
    expect(store.agent.defaultMaxTurns).toBe(50);

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

  it("setDefaultThinking/MaxTurns(undefined) removes the field", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, defaultThinking: "high", defaultMaxTurns: 50 } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.setDefaultThinking(undefined);
    store.mutate.agent.setDefaultMaxTurns(undefined);
    expect(store.agent.defaultThinking).toBeUndefined();
    expect(store.agent.defaultMaxTurns).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultThinking).toBeUndefined();
    expect(store.agentConfigSnapshot().defaultMaxTurns).toBeUndefined();
  });

  it("clearAllModelOverrides preserves all non-model agent properties", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: "keep",
          forceBackground: true,
          includeContextFiles: false,
          systemPromptMode: "custom",
          defaultThinking: "low",
          defaultMaxTurns: 25,
          loadSkillsImplicitly: false,
          loadExtensionsImplicitly: false,
          disableDefaultAgents: true,
          showTools: false,
          Explore: "m1",
        },
      },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.includeContextFiles).toBe(false);
    expect(snap.systemPromptMode).toBe("custom");
    // The model family is part of the cleared set now.
    expect(snap.defaultThinking).toBeUndefined();
    expect(snap.defaultMaxTurns).toBeUndefined();
    expect(snap.default).toBeNull();

    expect(snap.loadSkillsImplicitly).toBe(false);
    expect(snap.loadExtensionsImplicitly).toBe(false);
    expect(snap.disableDefaultAgents).toBe(true);
    expect(snap.showTools).toBe(false);
    expect(snap.Explore).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

describe("ConfigStore lifecycle", () => {
  it("reload re-reads disk and resets session overrides", () => {
    const { io, global } = memIO();
    const store = new ConfigStore(io);
    store.mutate.session.setOverride("Explore", "session/explore");
    store.mutate.concurrency.setDefault(9, "session");
    store.mutate.agent.setGraceTurns(11);

    global().agent!.graceTurns = 5;
    store.reload();

    expect(store.agent.graceTurns).toBe(5);
    expect(store.sessionModelOverride("Explore")).toBeNull();
    expect(store.concurrency.default).toBe(4);
  });

  it("reload re-syncs deps", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showCost: true, widgetCompact: true } },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.reload();
    expect(calls).toContain("setShowCost:true");
    expect(calls).toContain("setForceCompact:true");
  });

  it("setDeps re-syncs widget settings from current config", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: null,
          forceBackground: false,
          widgetMaxLines: 30,
          showCost: true,
          finishedRetentionMinutes: 3,
        },
      },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    expect(calls).toContain("setMaxLines:30");
    expect(calls).toContain("setShowCost:true");
    expect(calls).toContain("setFinishedRetentionMinutes:3");
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
/*  AgentStatus settled limit (agentStatusLimit)                       */
/* ------------------------------------------------------------------ */

describe("AgentStatus settled limit resolution", () => {
  it("unset, 0, and negative values resolve to the auto default (2 × concurrency.default)", () => {
    for (const edited of [undefined, 0, -5] as Array<number | undefined>) {
      const { io } = memIO(edited === undefined ? {} : { global: { agent: { agentStatusLimit: edited } } });
      const store = new ConfigStore(io);
      // concurrency.default bakes at 4, so the auto limit is 8 — derived, never a literal.
      expect(store.agent.agentStatusLimit).toBe(8);
    }
  });

  it("an explicit value ≥ 1 overrides the auto default", () => {
    for (const explicit of [1, 12]) {
      const { io } = memIO({ global: { agent: { agentStatusLimit: explicit } } });
      const store = new ConfigStore(io);
      expect(store.agent.agentStatusLimit).toBe(explicit);
    }
  });

  it("the auto default tracks the session-effective concurrency default", () => {
    const store = new ConfigStore(minimalIO());
    store.mutate.concurrency.setDefault(6, "session");
    expect(store.agent.agentStatusLimit).toBe(12);
  });

  it("setAgentStatusLimit persists the value and resolves it", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setAgentStatusLimit(15);
    expect(store.agent.agentStatusLimit).toBe(15);
    expect(saves).toHaveLength(1);
    expect(saves[0].config.agent!.agentStatusLimit).toBe(15);
  });

  it("setAgentStatusLimit(0) stores 0, resolving to auto", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    store.mutate.agent.setAgentStatusLimit(0);
    expect(store.agent.agentStatusLimit).toBe(8);
    expect(saves[0].config.agent!.agentStatusLimit).toBe(0);
  });

  it("setAgentStatusLimit clamps values below 1 to 0 (auto)", () => {
    // Fractional limits (menu allows decimals) are not a meaningful stored state:
    // 0 is the canonical auto marker, matching the menu's "0" display.
    for (const belowOne of [-3, 0.5]) {
      const { io, saves } = memIO();
      const store = new ConfigStore(io);
      store.mutate.agent.setAgentStatusLimit(belowOne);
      expect(saves[0].config.agent!.agentStatusLimit).toBe(0);
      expect(store.agent.agentStatusLimit).toBe(8);
    }
  });

  it("clearAllModelOverrides preserves agentStatusLimit (non-model key)", () => {
    const { io } = memIO({
      global: { agent: { default: "g", Explore: "g/explore", agentStatusLimit: 12, forceBackground: true } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    expect(store.agentConfigSnapshot().agentStatusLimit).toBe(12);
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
  });
});
