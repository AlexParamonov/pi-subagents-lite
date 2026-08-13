/**
 * model-display-style.test.ts — Tests for model display style config.
 */
import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.ts";
import type { RawConfig } from "../../src/config/config-io.ts";
import type { AgentWidget } from "../../src/ui/agent-widget.ts";

/** In-memory ConfigIO over raw global layers, recording saves. */
function memIO(initial: { global?: RawConfig } = {}): {
  io: ConfigIO;
  saves: Array<{ layer: "global" | "project"; config: RawConfig }>;
} {
  let cur: RawConfig = structuredClone(initial.global ?? {});
  const saves: Array<{ layer: "global" | "project"; config: RawConfig }> = [];
  return {
    io: {
      load: () => ({ global: structuredClone(cur), project: null, projectStatus: "untrusted" }),
      saveGlobal: (config) => {
        cur = structuredClone(config);
        saves.push({ layer: "global", config: structuredClone(config) });
      },
      saveProject: () => {},
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
    setNavHint: (e: boolean) => calls.push(`setNavHint:${e}`),
    setFinishedRetentionMinutes: (n: number) => calls.push(`setFinishedRetentionMinutes:${n}`),
    setCompactMode: (c: boolean) => calls.push(`setCompactMode:${c}`),
    setStatsVisibility: (v: any) => calls.push(`setStatsVisibility:${JSON.stringify(v)}`),
    setModelDisplayStyle: (s: string) => calls.push(`setModelDisplayStyle:${s}`),
    setModelThinkingPlacement: (p: string) => calls.push(`setModelThinkingPlacement:${p}`),
    setStatusBarFormat: (f: string) => calls.push(`setStatusBarFormat:${f}`),
  };
  return { w: w as unknown as AgentWidget, calls };
}

/* ------------------------------------------------------------------ */
/*  ConfigStore: modelDisplayStyle                                    */
/* ------------------------------------------------------------------ */

describe("ConfigStore modelDisplayStyle", () => {
  it("defaults to 'name'", () => {
    const { io } = memIO();
    const store = new ConfigStore(io);
    expect(store.agent.modelDisplayStyle).toBe("name");
  });

  it("returns configured value when present", () => {
    const { io } = memIO({
      global: { agent: { modelDisplayStyle: "id" } },
    });
    const store = new ConfigStore(io);
    expect(store.agent.modelDisplayStyle).toBe("id");
  });

  it("setModelDisplayStyle persists and syncs widget", () => {
    const { io, saves } = memIO();
    const { w, calls } = widgetStub();
    const store = new ConfigStore(io);
    store.setDeps({ widget: w });
    calls.length = 0;
    saves.length = 0;

    store.mutate.widget.setModelDisplayStyle("id");
    expect(store.agent.modelDisplayStyle).toBe("id");
    expect(saves).toHaveLength(1);
    expect(saves[0].config.agent!.modelDisplayStyle).toBe("id");
    expect(calls).toContain("setModelDisplayStyle:id");
  });

  it("setModelDisplayStyle cycles back to 'name'", () => {
    const { io, saves } = memIO({
      global: { agent: { modelDisplayStyle: "id" } },
    });
    const store = new ConfigStore(io);
    saves.length = 0;

    store.mutate.widget.setModelDisplayStyle("name");
    expect(store.agent.modelDisplayStyle).toBe("name");
    expect(saves).toHaveLength(1);
  });
});
