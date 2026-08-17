/**
 * model-display-style.test.ts — Tests for model display style config.
 */
import { describe, it, expect } from "vitest";
import { ConfigStore, type ConfigIO } from "../../src/config/config-store.js";
import type { RawConfig } from "../../src/config/config-io.js";
import type { AgentWidget } from "../../src/ui/agent-widget.js";
import type { StatsVisibility } from "../../src/ui/format.js";
import type { ModelThinkingPlacement } from "../../src/config/types.js";

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
  // Stub shape stays comparable to the real AgentWidget (real param types,
  // void returns) so a single `as` cast is legal.
  const w: {
    setShowCost: (e: boolean) => void;
    setForceCompact: (e: boolean) => void;
    setWidgetShortcut: (e: boolean) => void;
    setMaxLines: (n: number) => void;
    setMaxLinesCompact: (n: number) => void;
    setNavHint: (e: boolean) => void;
    setFinishedRetentionMinutes: (n: number) => void;
    setCompactMode: (c: boolean) => void;
    setStatsVisibility: (v: StatsVisibility) => void;
    setModelDisplayStyle: (s: "id" | "name") => void;
    setModelThinkingPlacement: (p: ModelThinkingPlacement) => void;
    setStatusBarFormat: (f: "full" | "compact") => void;
  } = {
    setShowCost: (e) => {
      calls.push(`setShowCost:${e}`);
    },
    setForceCompact: (e) => {
      calls.push(`setForceCompact:${e}`);
    },
    setWidgetShortcut: (e) => {
      calls.push(`setWidgetShortcut:${e}`);
    },
    setMaxLines: (n) => {
      calls.push(`setMaxLines:${n}`);
    },
    setMaxLinesCompact: (n) => {
      calls.push(`setMaxLinesCompact:${n}`);
    },
    setNavHint: (e) => {
      calls.push(`setNavHint:${e}`);
    },
    setFinishedRetentionMinutes: (n) => {
      calls.push(`setFinishedRetentionMinutes:${n}`);
    },
    setCompactMode: (c) => {
      calls.push(`setCompactMode:${c}`);
    },
    setStatsVisibility: (v) => {
      calls.push(`setStatsVisibility:${JSON.stringify(v)}`);
    },
    setModelDisplayStyle: (s) => {
      calls.push(`setModelDisplayStyle:${s}`);
    },
    setModelThinkingPlacement: (p) => {
      calls.push(`setModelThinkingPlacement:${p}`);
    },
    setStatusBarFormat: (f) => {
      calls.push(`setStatusBarFormat:${f}`);
    },
  };
  return { w: w as AgentWidget, calls };
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
