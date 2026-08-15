/**
 * config-store-helpers.ts — Shared fakes for ConfigStore tests.
 *
 * In-memory ConfigIO over two raw layers (recording per-layer saves),
 * widget/manager stubs recording their calls, and the default store
 * minimalIO(). Shared by the config-store suite files so each focuses on
 * one behavior area.
 */

import type { ConfigIO, RawConfig, ProjectLayerStatus } from "../../src/config/config-io.js";
import type { AgentWidget } from "../../src/ui/agent-widget.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";

/** In-memory ConfigIO over two raw layers, recording per-layer saves. */
export function memIO(
  opts: {
    global?: RawConfig;
    project?: RawConfig | null;
    projectStatus?: ProjectLayerStatus;
  } = {},
): {
  io: ConfigIO;
  saves: Array<{ layer: "global" | "project"; config: RawConfig }>;
  global: () => RawConfig;
  project: () => RawConfig | null;
} {
  const state: { global: RawConfig; project: RawConfig | null; projectStatus: ProjectLayerStatus } = {
    global: opts.global ?? {},
    project: opts.project === undefined ? null : opts.project,
    projectStatus: opts.projectStatus ?? "untrusted",
  };
  const saves: Array<{ layer: "global" | "project"; config: RawConfig }> = [];
  return {
    io: {
      load: () => ({
        global: structuredClone(state.global),
        project: state.project ? structuredClone(state.project) : null,
        projectStatus: state.projectStatus,
      }),
      saveGlobal: (config) => {
        state.global = structuredClone(config);
        saves.push({ layer: "global", config: structuredClone(config) });
      },
      saveProject: (config) => {
        state.project = structuredClone(config);
        saves.push({ layer: "project", config: structuredClone(config) });
      },
    },
    saves,
    global: () => state.global,
    project: () => state.project,
  };
}

/** ConfigIO whose load() returns empty raw layers: the store's defaults merge
 * and its own `??` fallbacks are what get exercised (not a fixture). */
export function minimalIO(): ConfigIO {
  return {
    load: () => ({ global: {}, project: null, projectStatus: "untrusted" }),
    saveGlobal: () => {},
    saveProject: () => {},
  };
}

export function widgetStub(): { w: AgentWidget; calls: string[] } {
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

export function managerStub(): { m: AgentManager; concurrencies: unknown[] } {
  const concurrencies: unknown[] = [];
  const m = {
    setConcurrency: (c: unknown) => concurrencies.push(c),
  };
  return { m: m as unknown as AgentManager, concurrencies };
}

export function statsVisibilityPayloads(calls: string[]): any[] {
  return calls
    .filter((c) => c.startsWith("setStatsVisibility:"))
    .map((c) => JSON.parse(c.slice("setStatsVisibility:".length)));
}
