/**
 * agent-widget-status.test.ts — Tests for the status bar (setStatus seam).
 *
 * Tests the status bar text format, cost accumulation, compact format,
 * and lifecycle (show/hide/rewrite) behavior.
 */

import { describe, it, expect, vi } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView, AgentRecord } from "../../src/types.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { makeMockManager, makeRunningAgent, makeFinishedAgent } from "./widget-helpers.js";

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
  visibleWidth: (text: string) => text.length,
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeUICtx() {
  return {
    setStatus: vi.fn<(key: string, text?: string) => void>(),
    setWidget: vi.fn(),
  };
}

/** Extract the status bar text from a widget's setStatus mock calls. */
function getStatusText(uiCtx: ReturnType<typeof makeUICtx>): string | undefined {
  const call = uiCtx.setStatus.mock.calls.find((c: unknown[]) => c[0] === "subagents");
  return call?.[1] as string | undefined;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("status bar format", () => {
  it("shows '◈ Agents: N active' when running agents with no cost", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0;
    manager.listAgents = () => [a1];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringContaining("◈ Agents: 1 active"));
  });

  it("shows '◈ Agents: N active · M done · $cost' with running, done, and cost", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0.12, 5);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0;
    manager.listAgents = () => [a1];
    widget.update();

    expect(getStatusText(uiCtx)).toContain("◈ Agents: 1 active · 5 done · ");
  });

  it("shows '◇ Agents: M done · $cost' when no running agents but finished exist", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0.01, 1);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update();

    expect(getStatusText(uiCtx)).toContain("◇ Agents: 1 done · ");
  });

  it("omits cost section when cost is zero", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 2);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0;
    manager.listAgents = () => [agent];
    widget.update();

    const text = getStatusText(uiCtx);
    expect(text).not.toContain("$");
    expect(text).toContain("1 active");
  });

  it("omits active count when active is 0", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0.5, 3);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update();

    const text = getStatusText(uiCtx);
    expect(text).not.toContain("active");
    expect(text).toContain("done");
  });

  it("omits done count when done is 0", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    manager.listAgents = () => [agent];
    widget.update();

    const text = getStatusText(uiCtx);
    expect(text).not.toContain("done");
    expect(text).toContain("active");
  });

  it("shows '◇ Agents: M done' without cost when done exists but cost is zero", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 1);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update();

    expect(getStatusText(uiCtx)).toBe("◇ Agents: 1 done");
  });
});

describe("status bar cost from accumulator", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  it("uses getTotalAgentCost for status bar when no running agents", () => {
    const uiCtx = makeUICtx();
    activity = new Map();
    // No running agents, but totalAgentCost is $1.23 (from evicted agents)
    manager = makeMockManager([], 1.23, 2);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    // Trigger an update with a running agent so the status bar is emitted
    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    manager.listAgents = () => [agent];
    widget.update();

    // Status bar should include $1.28 ($1.23 session + $0.05 running)
    expect(getStatusText(uiCtx)).toContain("$1.28");
  });

  it("shows accumulated cost even when no running agents have cost", () => {
    const uiCtx = makeUICtx();
    activity = new Map();
    // Running agent with $0 cost, but session accumulator has $2.50
    manager = makeMockManager([], 2.5, 1);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0; // Running agent has no cost yet
    manager.listAgents = () => [agent];
    widget.update();

    expect(getStatusText(uiCtx)).toContain("$2.50");
  });

  it("hides cost when showCost is false", () => {
    const uiCtx = makeUICtx();
    activity = new Map();
    manager = makeMockManager([], 1.5, 1);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(false);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    manager.listAgents = () => [agent];
    widget.update();

    expect(getStatusText(uiCtx)).not.toContain("$");
  });
});

describe("status bar compact format", () => {
  it("compact format: '◈ 2 5Σ $0.12' with active, done, and cost", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0.12, 5);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0;
    const a2 = makeRunningAgent("a2");
    a2.stats.lifetimeUsage.cost = 0;
    manager.listAgents = () => [a1, a2];
    widget.update();

    expect(getStatusText(uiCtx)).toBe("◈ 2 5Σ $0.12");
  });

  it("compact format omits cost section when cost is zero", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 2);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    manager.listAgents = () => [a1];
    widget.update();

    expect(getStatusText(uiCtx)).toBe("◈ 1 2Σ");
  });

  it("compact format omits active count when 0", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0.5, 3);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update();

    expect(getStatusText(uiCtx)).toBe("◇ 3Σ $0.50");
  });

  it("compact format omits done count when 0", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    manager.listAgents = () => [a1];
    widget.update();

    expect(getStatusText(uiCtx)).toBe("◈ 1");
  });

  it("compact format shows '◇' when no active agents exist", () => {
    const uiCtx = makeUICtx();
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    // finished agent triggers update
    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update();

    expect(getStatusText(uiCtx)).toContain("◇");
  });
});

describe("status line lifecycle (record-existence-driven)", () => {
  it("stays visible, dimmed, after rows age out of the retention window", () => {
    const uiCtx = makeUICtx();
    const manager = makeMockManager([], 0.01, 2);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1"); // 30s old, inside the default 1-min window
    manager.listAgents = () => [finished];
    widget.update(); // block and status up

    // The row ages past the window; the record persists (ADR-0006).
    finished.lifecycle.completedAt = Date.now() - 5 * 60_000;
    widget.update();

    expect(uiCtx.setWidget).toHaveBeenCalledWith("agents", undefined); // block dropped
    expect(uiCtx.setStatus).not.toHaveBeenCalledWith("subagents", undefined); // status kept
    expect(getStatusText(uiCtx)).toContain("◇ Agents: 2 done · $0.01");
  });

  it("hides the status line when zero records exist (Clear)", () => {
    const uiCtx = makeUICtx();
    const manager = makeMockManager([], 0.01, 2);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    manager.listAgents = () => [finished];
    widget.update(); // status and block up

    manager.listAgents = () => []; // every record removed (Clear)
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", undefined);
    expect(uiCtx.setWidget).toHaveBeenCalledWith("agents", undefined);
  });

  it("re-shows with the active count when a new record spawns after a full clear", () => {
    const uiCtx = makeUICtx();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setUICtx(uiCtx);

    manager.listAgents = () => [];
    widget.update();

    const queued = makeRunningAgent("q1");
    queued.lifecycle = { status: "queued", startedAt: Date.now(), started: false };
    manager.listAgents = () => [queued];
    widget.update();

    expect(getStatusText(uiCtx)).toContain("◈ Agents: 1 active");
    expect(uiCtx.setWidget).toHaveBeenCalledWith(
      "agents",
      expect.any(Function),
      expect.objectContaining({ placement: "aboveEditor" }),
    );
  });

  it("does not rewrite the status text on ticks when unchanged", () => {
    const uiCtx = makeUICtx();
    const manager = makeMockManager([], 0.01, 2);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setShowCost(true);
    widget.setFinishedRetentionMinutes(5);
    widget.setUICtx(uiCtx);

    const agedOut = makeFinishedAgent("f1");
    agedOut.lifecycle.completedAt = Date.now() - 10 * 60_000; // outside the 5-min window
    manager.listAgents = () => [agedOut];
    widget.update();
    widget.update();
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledTimes(1);
    expect(getStatusText(uiCtx)).toContain("◇ Agents: 2 done");
  });
});
