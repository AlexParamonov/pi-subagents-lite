/**
 * config-store-concurrency.test.ts — ConfigStore persisted concurrency
 * layers: writes target one layer (session / global / project), clears and
 * removes fall through to the next layer, and an absent project file is
 * never created by a clear.
 */

import { describe, it, expect } from "vitest";
import { ConfigStore } from "../../src/config/config-store.js";
import { memIO } from "./config-store-helpers.js";

describe("ConfigStore concurrency layers", () => {
  it("setProvider at project writes only the project layer", () => {
    const { io, saves, global } = memIO({
      global: { concurrency: { default: 2 } },
      project: {},
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setProvider("llamacpp", 3, "project");
    expect(saves[0].layer).toBe("project");
    expect(saves[0].config).toEqual({ concurrency: { providers: { llamacpp: 3 } } });
    expect(global()).toEqual({ concurrency: { default: 2 } });
    expect(store.concurrency.providers).toEqual({ llamacpp: 3 });
  });

  it("clearAll at project removes the section and falls through to global", () => {
    const { io, saves } = memIO({
      global: { concurrency: { default: 2, providers: { a: 1 } } },
      project: { concurrency: { default: 8, providers: { b: 2 } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.clearAll("project");
    expect(saves[0].layer).toBe("project");
    expect(saves[0].config).toEqual({});
    expect(store.concurrency.default).toBe(2);
    expect(store.concurrency.providers).toEqual({ a: 1 });
  });

  it("clearAll at global falls through to built-in defaults", () => {
    const { io } = memIO({ global: { concurrency: { default: 2, providers: { x: 1 } } } });
    const store = new ConfigStore(io);
    store.mutate.concurrency.clearAll();
    expect(store.concurrency.default).toBe(4);
    expect(store.concurrency.providers).toEqual({});
  });

  it("clearAll at all levels clears session, global and project", () => {
    const { io, saves } = memIO({
      global: { concurrency: { default: 2 } },
      project: { concurrency: { default: 8 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setDefault(16, "session");
    store.mutate.concurrency.clearAll("all");
    expect(store.concurrency.default).toBe(4);
    expect(saves).toHaveLength(2);
    expect(saves[0].config).toEqual({});
    expect(saves[1].config).toEqual({});
  });

  it("removeProvider at all levels removes the provider everywhere", () => {
    const { io, saves } = memIO({
      global: { concurrency: { providers: { a: 1 } } },
      project: { concurrency: { providers: { a: 2 } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setProvider("a", 3, "session");
    store.mutate.concurrency.removeProvider("a", "all");
    expect(store.concurrency.providers).toEqual({});
    expect(saves).toHaveLength(2);
  });

  it("removeDefault at all levels removes the default everywhere", () => {
    const { io, saves } = memIO({
      global: { concurrency: { default: 2 } },
      project: { concurrency: { default: 8 } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);
    store.mutate.concurrency.setDefault(16, "session");
    store.mutate.concurrency.removeDefault("all");
    expect(store.concurrency.default).toBe(4);
    expect(saves).toHaveLength(2);
  });

  it("all-levels clears with no project file touch only the global layer", () => {
    // A clear must never create a project file: both clearAll and
    // removeProvider skip the absent project layer.
    const a = memIO({ global: { concurrency: { default: 2 } }, projectStatus: "absent" });
    const storeA = new ConfigStore(a.io);
    storeA.mutate.concurrency.clearAll("all");
    expect(a.saves).toHaveLength(1);
    expect(a.saves[0].layer).toBe("global");
    expect(a.project()).toBeNull();

    const b = memIO({ global: { concurrency: { providers: { x: 1 } } }, projectStatus: "absent" });
    const storeB = new ConfigStore(b.io);
    storeB.mutate.concurrency.removeProvider("x", "all");
    expect(b.saves).toHaveLength(1);
    expect(b.saves[0].layer).toBe("global");
    expect(b.project()).toBeNull();
  });
});
