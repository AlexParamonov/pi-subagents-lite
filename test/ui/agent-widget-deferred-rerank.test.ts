/**
 * agent-widget-deferred-rerank.test.ts — Tests for identity-based highlight and
 * deferred re-rank during navigation.
 *
 * The 2s freeze window is driven with vi.useFakeTimers + vi.setSystemTime
 * (established repo pattern). Only exact-window/state-table assertions are
 * made: roster order, highlight target, and the N/M readout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

vi.mock("../../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
  getAgentConfig: agentConfigMock(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => text,
}));

function makeMockManager(getAgents: () => any[]): AgentManager {
  return {
    // Mirror the real manager: newest first (sorted by startedAt desc).
    listAgents: () => [...getAgents()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt),
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => 0,
    getTotalAgentCount: () => 0,
  } as any as AgentManager;
}

function makeMockTheme(): any {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makeMockTUI(): any {
  return { terminal: { columns: 200 } };
}

function makeRunningAgent(id: string): any {
  return {
    id,
    display: { type: "builder", description: `Running agent ${id}` },
    lifecycle: { status: "running", startedAt: Date.now() - 60000 },
    execution: {},
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
  };
}

function makeFinishedAgent(id: string): any {
  return {
    id,
    display: { type: "builder", description: `Finished agent ${id}` },
    lifecycle: { status: "completed", startedAt: Date.now() - 120000, completedAt: Date.now() - 60000 },
    execution: {},
    stats: {
      toolUses: 10,
      compactionCount: 0,
      lifetimeUsage: { input: 2000, output: 1000, cacheWrite: 0, cost: 0 },
      turnCount: 8,
      maxTurns: 30,
    },
  };
}

function makeQueuedAgent(id: string): any {
  return {
    id,
    display: { type: "builder", description: `Queued agent ${id}` },
    lifecycle: { status: "queued", startedAt: Date.now() - 30000 },
    execution: {},
    stats: {
      toolUses: 0,
      compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      turnCount: 0,
      maxTurns: 30,
    },
  };
}

/** Flip an agent record to the completed state (live truth, in place). */
function completeAgent(agent: any): void {
  agent.lifecycle.status = "completed";
  agent.lifecycle.completedAt = Date.now();
}

type NavState = {
  visible: string[];
  arrow: string | null;
  readout: string | null;
  /** Ids of rows showing the completed ✓ style, in body order. */
  checked: string[];
};

/** Render the widget and extract visible agent ids, arrow target, N/M readout, and which rows show the ✓ style. */
function renderNavState(widget: AgentWidget): NavState {
  const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
  const body = lines.slice(1); // heading takes line 0
  const visible: string[] = [];
  const checked: string[] = [];
  let arrow: string | null = null;
  for (const line of body) {
    const m = line.match(/agent (f\d+|r\d+|q\d+)/);
    if (!m) continue;
    if (line.includes("✓")) checked.push(m[1]);
    if (line.includes("→")) arrow = m[1];
    visible.push(m[1]);
  }
  const readout = lines[0].match(/\[dim:(\d+\/\d+)\]/)?.[1] ?? null;
  return { visible, arrow, readout, checked };
}

/* ------------------------------------------------------------------ */
/*  Deferred re-rank tests                                             */
/* ------------------------------------------------------------------ */

describe("deferred re-rank freeze window", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let agents: any[];

  // Live order: finished (f0) → running (r1) → queued (q2).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00.000Z"));
    agents = [makeFinishedAgent("f0"), makeRunningAgent("r1"), makeQueuedAgent("q2")];
    manager = makeMockManager(() => agents);
    widget = new AgentWidget(manager, () => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a completing agent in place mid-freeze, then re-ranks after 2s with the highlight following", () => {
    widget.navActivate(); // t=0, highlight f0 (1/3)
    widget.navDown(); // t=0, highlight r1 (2/3)
    expect(renderNavState(widget).readout).toBe("2/3");

    // r1 completes while the user is still navigating (last move < 2s ago).
    completeAgent(agents[1]);

    // t=1s: still frozen — r1 keeps its position and its row flips to ✓.
    vi.setSystemTime(new Date(Date.now() + 1000));
    let state = renderNavState(widget);
    expect(state.visible).toEqual(["f0", "r1", "q2"]);
    expect(state.arrow).toBe("r1");
    expect(state.readout).toBe("2/3");
    expect(state.checked).toContain("r1"); // the completed row flips to ✓ in place

    // Exact window boundary: at exactly 2000ms the order is still frozen.
    vi.setSystemTime(new Date(Date.now() + 1000));
    state = renderNavState(widget);
    expect(state.visible).toEqual(["f0", "r1", "q2"]);
    expect(state.arrow).toBe("r1");

    // t=2s+1ms: dormant — re-rank into live order; the highlight follows r1.
    vi.setSystemTime(new Date(Date.now() + 1));
    state = renderNavState(widget);
    expect(state.visible).toEqual(["r1", "f0", "q2"]);
    expect(state.arrow).toBe("r1");
    expect(state.readout).toBe("1/3");
  });

  it("appends new agents at the end mid-freeze without shifting existing positions", () => {
    widget.navActivate();
    widget.navDown(); // highlight r1 (index 1, readout 2/3)
    expect(renderNavState(widget).readout).toBe("2/3");

    // Two new agents spawn while the user is navigating.
    agents.push(makeRunningAgent("r5"), makeRunningAgent("r6"));

    vi.setSystemTime(new Date(Date.now() + 1000));
    const state = renderNavState(widget);
    // Existing entries keep their positions; new agents append at the end.
    expect(state.visible).toEqual(["f0", "r1", "q2", "r5", "r6"]);
    expect(state.arrow).toBe("r1");
    expect(state.readout).toBe("2/5");
  });

  it("operates on the freshly re-ranked roster right after dormancy and resets the window", () => {
    widget.navActivate();
    widget.navDown(); // r1, t=0
    completeAgent(agents[1]); // r1 completes

    vi.setSystemTime(new Date(Date.now() + 2500)); // dormant
    let state = renderNavState(widget);
    expect(state.visible).toEqual(["r1", "f0", "q2"]);
    expect(state.arrow).toBe("r1");

    // A move immediately after dormancy operates on the live order.
    widget.navDown();
    state = renderNavState(widget);
    expect(state.visible).toEqual(["r1", "f0", "q2"]);
    expect(state.arrow).toBe("f0"); // index 1 in the re-ranked roster
    expect(state.readout).toBe("2/3");

    // The move resets the 2s window: q2 completing now stays in place at t=3.5s.
    completeAgent(agents[2]); // q2 completes
    vi.setSystemTime(new Date(Date.now() + 1000));
    state = renderNavState(widget);
    expect(state.visible).toEqual(["r1", "f0", "q2"]); // still frozen
    expect(state.arrow).toBe("f0");
  });

  it("re-ranks on every render tick while the user stays idle", () => {
    widget.navActivate();
    widget.navDown(); // r1
    completeAgent(agents[1]); // r1 completes

    vi.setSystemTime(new Date(Date.now() + 2500));
    expect(renderNavState(widget).visible).toEqual(["r1", "f0", "q2"]);

    // Another agent completes during the pause; no move happens.
    completeAgent(agents[2]); // q2 completes
    vi.setSystemTime(new Date(Date.now() + 500));
    const state = renderNavState(widget);
    // A second idle render re-ranks again — the roster stays current.
    // q2 started after r1, so it now leads the finished group.
    expect(state.visible).toEqual(["q2", "r1", "f0"]);
    expect(state.arrow).toBe("r1");
  });

  it("does not reset the freeze window on Enter, and navSelect returns the highlighted live record", () => {
    widget.navActivate();
    widget.navDown(); // r1 at index 1, t=0

    vi.setSystemTime(new Date(Date.now() + 1000));
    completeAgent(agents[1]); // r1 completes mid-freeze

    // Enter mid-freeze: returns the agent under the highlight (a live record).
    const selected = widget.navSelect();
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("r1");
    expect(selected!.lifecycle.status).toBe("completed"); // live truth, not frozen display

    // t=2.5s since the last move: dormant despite the Enter — re-ranked.
    vi.setSystemTime(new Date(Date.now() + 1500));
    const state = renderNavState(widget);
    expect(state.visible).toEqual(["r1", "f0", "q2"]);
    expect(state.arrow).toBe("r1");
  });

  it("moves the highlight to the nearest remaining agent when the highlighted agent is evicted", () => {
    agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown(); // f4 at index 4, t=0

    // Evict f3 and f4 (including the highlighted agent) mid-freeze.
    agents = agents.slice(0, 3);
    vi.setSystemTime(new Date(Date.now() + 1000));

    const state = renderNavState(widget);
    // Nearest remaining agent: min(previousIndex=4, len-1=2) → f2.
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f2");
    expect(state.readout).toBe("3/3");

    // navSelect returns the adopted agent, never a stale one.
    const selected = widget.navSelect();
    expect(selected!.id).toBe("f2");
  });

  it("shows no N/M readout outside navigation mode", () => {
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[0]).not.toMatch(/\d+\/\d+/);
  });
});
