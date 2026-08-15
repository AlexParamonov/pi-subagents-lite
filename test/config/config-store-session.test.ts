/**
 * config-store-session.test.ts — ConfigStore session-only state.
 *
 * Session overrides and session concurrency are in-memory only: never
 * persisted, cleared on reload. The session showCost override sits above
 * the persisted value and syncs the widget.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore } from "../../src/config/config-store.ts";
import { memIO, widgetStub, managerStub, statsVisibilityPayloads } from "./config-store-helpers.ts";

/* ------------------------------------------------------------------ */
/*  Session concurrency                                                */
/* ------------------------------------------------------------------ */

describe("ConfigStore session concurrency", () => {
  it("session overrides project and global; resets on reload", () => {
    const { io, saves } = memIO({
      global: { concurrency: { default: 2, providers: { a: 1 } } },
      project: { concurrency: { default: 8, providers: { b: 2 } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    expect(store.concurrency.default).toBe(8);

    store.mutate.concurrency.setDefault(16, "session");
    store.mutate.concurrency.setProvider("a", 5, "session");
    expect(store.concurrency.default).toBe(16);
    expect(store.concurrency.providers).toEqual({ a: 5, b: 2 });
    expect(saves).toHaveLength(0);

    store.reload();
    expect(store.concurrency.default).toBe(8);
    expect(store.concurrency.providers).toEqual({ a: 1, b: 2 });
  });

  it("session concurrency edits call manager.setConcurrency with the session-included value", () => {
    const { io } = memIO({ global: { concurrency: { default: 2 } }, projectStatus: "loaded" });
    const { m, concurrencies } = managerStub();
    const store = new ConfigStore(io);
    store.setDeps({ manager: m });
    concurrencies.length = 0;

    store.mutate.concurrency.setDefault(16, "session");

    expect(concurrencies).toHaveLength(1);
    expect(concurrencies[0]).toEqual({ default: 16, providers: {}, models: {} });
  });

  it("clearAll at session clears only the session layer", () => {
    const { io, saves } = memIO({ global: { concurrency: { default: 2 } }, projectStatus: "loaded" });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setDefault(16, "session");
    store.mutate.concurrency.clearAll("session");
    expect(store.concurrency.default).toBe(2);
    expect(saves).toHaveLength(0);
  });

  it("removeProvider at session removes only the session entry", () => {
    const { io, saves } = memIO({
      global: { concurrency: { providers: { a: 1 } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setProvider("a", 5, "session");
    expect(store.concurrency.providers).toEqual({ a: 5 });
    store.mutate.concurrency.removeProvider("a", "session");
    expect(store.concurrency.providers).toEqual({ a: 1 });
    expect(saves).toHaveLength(0);
  });

  it("removeDefault at session removes only the session entry", () => {
    const { io, saves } = memIO({
      global: { concurrency: { default: 2 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setDefault(16, "session");
    expect(store.concurrency.default).toBe(16);
    store.mutate.concurrency.removeDefault("session");
    expect(store.concurrency.default).toBe(2);
    expect(saves).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Session showCost override                                          */
/* ------------------------------------------------------------------ */

describe("ConfigStore session showCost override", () => {
  it("session setShowCost overrides config value", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showCost: false } },
    });
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
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showCost: false } },
    });
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
    const payloads = statsVisibilityPayloads(calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].showCost).toBe(true);
    expect(payloads[0].showTools).toBe(false);
  });

  it("session clearShowCost syncs config value to widget", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showCost: true } },
    });
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    store.mutate.session.setShowCost(false);
    expect(calls).toContain("setShowCost:false");
    const payloads = statsVisibilityPayloads(calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].showCost).toBe(false);
    expect(payloads[0].showTools).toBe(false);
    calls.length = 0;
    store.mutate.session.clearShowCost();
    expect(calls).toContain("setShowCost:true");
    const payloadsAfterClear = statsVisibilityPayloads(calls);
    expect(payloadsAfterClear).toHaveLength(1);
    expect(payloadsAfterClear[0].showCost).toBe(true);
    expect(payloadsAfterClear[0].showTools).toBe(false);
  });

  it("reload clears session showCost override", () => {
    const { io } = memIO({
      global: { agent: { default: null, forceBackground: false, showCost: false } },
    });
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
/*  Session overrides                                                  */
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
