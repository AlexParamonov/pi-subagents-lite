/**
 * config-store-widget-sync.test.ts — ConfigStore widget-facing settings.
 *
 * Each setting: read default, configured value, setter persistence, and
 * widget sync (stats visibility payload, or direct setters). clearAll
 * preserves these non-model settings.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore } from "../../src/config/config-store.ts";
import { memIO, minimalIO, widgetStub, statsVisibilityPayloads } from "./config-store-helpers.ts";

/* ------------------------------------------------------------------ */
/*  notifyToolsExpanded                                                */
/* ------------------------------------------------------------------ */

describe("ConfigStore notifyToolsExpanded", () => {
  it("toggles widget compact mode only when shortcut is enabled and compact is off", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, widgetShortcut: true, widgetCompact: false } },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });

    store.notifyToolsExpanded(false); // initial transition from undefined -> ignored
    calls.length = 0;
    store.notifyToolsExpanded(true); // expanded -> full
    store.notifyToolsExpanded(false); // collapsed -> compact
    expect(calls).toEqual(["setCompactMode:false", "setCompactMode:true"]);
  });

  it("is a no-op when widgetShortcut is disabled", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, widgetShortcut: false } },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.notifyToolsExpanded(true);
    store.notifyToolsExpanded(false);
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when widgetCompact is forced on", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, widgetShortcut: true, widgetCompact: true } },
    });
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
/*  show* stats visibility                                             */
/* ------------------------------------------------------------------ */

describe("ConfigStore show* stats visibility", () => {
  it("showTools defaults to false, rest default to true", () => {
    const store = new ConfigStore(minimalIO());
    expect(store.agent.showTools).toBe(false);
    expect(store.agent.showTurns).toBe(true);
    expect(store.agent.showInput).toBe(true);
    expect(store.agent.showOutput).toBe(true);
    expect(store.agent.showContext).toBe(true);
    expect(store.agent.showTime).toBe(true);
  });

  it("configured false values are respected", () => {
    const { io } = memIO({
      global: {
        agent: {
          default: null,
          forceBackground: false,
          showTools: false,
          showTurns: false,
          showInput: false,
          showOutput: false,
          showContext: false,
          showTime: false,
        },
      },
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
    const payloads = statsVisibilityPayloads(calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].showTools).toBe(false);
    expect(payloads[0].showCost).toBe(false);
  });

  it("reload syncs stats visibility to widget", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showTools: false } },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.reload();
    const payloads = statsVisibilityPayloads(calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].showTools).toBe(false);
    expect(payloads[0].showCost).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  outputThinkingBufferSize                                           */
/* ------------------------------------------------------------------ */

describe("ConfigStore outputThinkingBufferSize", () => {
  it("defaults to 0 when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.outputThinkingBufferSize).toBe(0);
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, outputThinkingBufferSize: 80 } },
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
    expect(saves[0].config.agent!.outputThinkingBufferSize).toBe(200);
  });

  it("setOutputThinkingBufferSize(0) persists and clears the setting", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, outputThinkingBufferSize: 80 } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputThinkingBufferSize).toBe(80);

    store.mutate.agent.setOutputThinkingBufferSize(0);
    expect(store.agent.outputThinkingBufferSize).toBe(0);
    expect(store.agentConfigSnapshot().outputThinkingBufferSize).toBe(0);
  });

  it("clearAllModelOverrides preserves outputThinkingBufferSize", () => {
    const { io } = memIO({
      global: { agent: { default: "keep", forceBackground: true, outputThinkingBufferSize: 500, Explore: "m1" } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.outputThinkingBufferSize).toBe(500);
    expect(snap.Explore).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  modelThinkingPlacement                                             */
/* ------------------------------------------------------------------ */

describe("ConfigStore modelThinkingPlacement", () => {
  it("defaults to 'header' when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.modelThinkingPlacement).toBe("header");
  });

  it("returns configured 'metadata' when present", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, modelThinkingPlacement: "metadata" } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.modelThinkingPlacement).toBe("metadata");
  });

  it("clearAllModelOverrides preserves modelThinkingPlacement", () => {
    const { io } = memIO({
      global: { agent: { default: "keep", forceBackground: true, modelThinkingPlacement: "metadata", Explore: "m1" } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.modelThinkingPlacement).toBe("metadata");
    expect(snap.Explore).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  statusBarFormat                                                    */
/* ------------------------------------------------------------------ */

describe("ConfigStore statusBarFormat", () => {
  it("defaults to 'full' when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.statusBarFormat).toBe("full");
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, statusBarFormat: "compact" } },
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
    expect(saves[0].config.agent!.statusBarFormat).toBe("compact");
    expect(calls).toContain("setStatusBarFormat:compact");
  });

  it("reload syncs statusBarFormat to widget", () => {
    const { io, global } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    global().agent = { statusBarFormat: "compact" };
    store.reload();
    expect(calls).toContain("setStatusBarFormat:compact");
  });
});

/* ------------------------------------------------------------------ */
/*  outputTranscript                                                   */
/* ------------------------------------------------------------------ */

describe("ConfigStore outputTranscript", () => {
  it("defaults to false when absent", () => {
    const store = new ConfigStore(memIO().io);
    expect(store.agent.outputTranscript).toBe(false);
  });

  it("returns false when configured false", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, outputTranscript: false } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputTranscript).toBe(false);
  });

  it("returns true when configured true", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, outputTranscript: true } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputTranscript).toBe(true);
  });

  it("setOutputTranscript persists value", () => {
    const { io, saves } = memIO();
    const store = new ConfigStore(io);
    saves.length = 0;

    store.mutate.agent.setOutputTranscript(false);
    expect(store.agent.outputTranscript).toBe(false);
    expect(saves).toHaveLength(1);
    expect(saves[0].config.agent!.outputTranscript).toBe(false);
  });

  it("setOutputTranscript(true) restores transcript", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, outputTranscript: false } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.outputTranscript).toBe(false);

    store.mutate.agent.setOutputTranscript(true);
    expect(store.agent.outputTranscript).toBe(true);
  });

  it("clearAllModelOverrides preserves outputTranscript", () => {
    const { io } = memIO({
      global: { agent: { default: "keep", forceBackground: true, outputTranscript: false, Explore: "m1" } },
    });
    const store = new ConfigStore(io);
    store.mutate.agent.clearAllModelOverrides();
    const snap = store.agentConfigSnapshot();
    expect(snap.outputTranscript).toBe(false);
    expect(snap.Explore).toBeUndefined();
  });
});
