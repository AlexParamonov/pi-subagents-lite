/**
 * agent-widget.test.ts — Tests for widget connector rendering.
 *
 * Verifies that the widget renders correct tree connectors:
 *   - ├─ for non-last agents
 *   - └─ for the last agent
 *   - │ for activity lines of non-last agents
 *   - spaces for activity lines of the last agent
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { AgentWidget, formatMs } from "../src/ui/agent-widget.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

vi.mock("../src/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinking: undefined,
  }),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => text,
}));

function makeMockManager(agents: any[], totalAgentCost = 0): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => totalAgentCost,
    // other methods not used by widget
  } as any as AgentManager;
}

function makeMockTheme(): any {
  const colors: Record<string, string> = {
    dim: "dim",
    accent: "accent",
    success: "success",
    error: "error",
    warning: "warning",
    muted: "muted",
  };
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makeMockTUI(): any {
  return { terminal: { columns: 200 } };
}

function makeRunningAgent(id: string, type: string = "builder"): any {
  return {
    id,
    display: {
      type,
      description: `Test agent ${id}`,
    },
    lifecycle: {
      status: "running",
      startedAt: Date.now() - 60000,
    },
    execution: {},
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { prompt: 1000, completion: 500, cached: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
  };
}

function makeFinishedAgent(id: string, type: string = "builder"): any {
  return {
    id,
    display: {
      type,
      description: `Finished agent ${id}`,
    },
    lifecycle: {
      status: "completed",
      startedAt: Date.now() - 120000,
      completedAt: Date.now() - 60000,
    },
    execution: {},
    stats: {
      toolUses: 10,
      compactionCount: 0,
      lifetimeUsage: { prompt: 2000, completion: 1000, cached: 0 },
      turnCount: 8,
      maxTurns: 30,
    },
  };
}

function makeActivity(agentId: string): AgentActivity {
  return {
    activeTools: new Map([["read", "reading"]]),
    toolUses: 5,
    responseText: "",
    turnCount: 3,
    maxTurns: 30,
    lifetimeUsage: { prompt: 1000, completion: 500, cached: 0 },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("widget connectors", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, AgentActivity>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, activity);
  });

  describe("last running agent", () => {
    it("uses └─ for last running agent header", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toContain("└─");
      expect(lines[1]).not.toContain("├─");
    });

    it("uses spaces for last running agent activity line", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Activity line is the second line (index 2, after heading)
      expect(lines[2]).not.toContain("│");
      expect(lines[2]).toContain("└");
    });

    it("places outputFile line before activity line", () => {
      const agent = makeRunningAgent("a1");
      agent.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // line[1] = header, line[2] = outputFile, line[3] = activity
      expect(lines[2]).toContain("tail -f");
      expect(lines[3]).toContain("└");
      expect(lines[3]).toContain("reading");
    });

    it("uses └ not ⎿ for activity indicator", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[2]).toContain("└");
      expect(lines[2]).not.toContain("⎿");
    });
  });

  describe("multiple running agents", () => {
    it("uses ├─ for first and └─ for last", () => {
      const a1 = makeRunningAgent("a1");
      const a2 = makeRunningAgent("a2");
      activity.set("a1", makeActivity("a1"));
      activity.set("a2", makeActivity("a2"));
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // First agent header
      expect(lines[1]).toContain("├─");
      // Last agent header (after a1's activity line)
      expect(lines[3]).toContain("└─");
      expect(lines[3]).not.toContain("├─");
    });

    it("uses │ for non-last activity and spaces for last", () => {
      const a1 = makeRunningAgent("a1");
      const a2 = makeRunningAgent("a2");
      activity.set("a1", makeActivity("a1"));
      activity.set("a2", makeActivity("a2"));
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // First agent activity line has └ (not ⎿)
      expect(lines[2]).toContain("└");
      expect(lines[2]).not.toContain("⎿");
      // Last agent activity line has no │
      expect(lines[4]).not.toContain("│");
      expect(lines[4]).toContain("└");
    });

    it("places outputFile before activity for each running agent", () => {
      const a1 = makeRunningAgent("a1");
      a1.display.outputFile = "/tmp/out1.log";
      const a2 = makeRunningAgent("a2");
      a2.display.outputFile = "/tmp/out2.log";
      activity.set("a1", makeActivity("a1"));
      activity.set("a2", makeActivity("a2"));
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // a1: header[1], outputFile[2], activity[3]; a2: header[4], outputFile[5], activity[6]
      expect(lines[2]).toContain("out1.log");
      expect(lines[3]).toContain("└");
      expect(lines[5]).toContain("out2.log");
      expect(lines[6]).toContain("└");
    });
  });

  describe("finished agents", () => {
    it("uses └─ for last finished agent", () => {
      const a1 = makeFinishedAgent("a1");
      const a2 = makeFinishedAgent("a2");
      widget.markFinished("a1");
      widget.markFinished("a2");
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toContain("├─");
      expect(lines[2]).toContain("└─");
    });

    it("uses spaces for tail-f line of last finished agent", () => {
      const a1 = makeFinishedAgent("a1");
      a1.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      widget.markFinished("a1");
      (manager as any).listAgents = () => [a1];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toContain("└─");
      expect(lines[1]).not.toContain("├─");
      // tail-f line should have no │
      expect(lines[2]).not.toContain("│");
      expect(lines[2]).toContain("tail -f");
    });

    it("outputFile lines use │ for non-last and spaces for last finished agent", () => {
      const a1 = makeFinishedAgent("a1");
      a1.display.outputFile = "/tmp/out1.log";
      const a2 = makeFinishedAgent("a2");
      a2.display.outputFile = "/tmp/out2.log";
      widget.markFinished("a1");
      widget.markFinished("a2");
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // a1 tail-f line (index 2) has │ connector, a2 tail-f line (index 4) has spaces
      expect(lines[2]).toContain("│");
      expect(lines[2]).toContain("out1.log");
      expect(lines[4]).not.toContain("│");
      expect(lines[4]).toContain("out2.log");
    });
  });

  describe("mixed running and finished", () => {
    it("uses └─ for last item regardless of type", () => {
      const running = makeRunningAgent("r1");
      const finished = makeFinishedAgent("f1");
      activity.set("r1", makeActivity("r1"));
      widget.markFinished("f1");
      (manager as any).listAgents = () => [finished, running];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Finished agent first (├─), running agent last (└─)
      expect(lines[1]).toContain("├─");
      expect(lines[2]).toContain("└─");
    });
  });
});

describe("status bar format", () => {
  it("shows 'N agents: $cost' format with running agents", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0);
    const widget = new AgentWidget(manager, activity);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0.05;
    const a2 = makeRunningAgent("a2");
    a2.stats.lifetimeUsage.cost = 0.03;
    (manager as any).listAgents = () => [a1, a2];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "2 agents: $0.08");
  });

  it("shows 'agents: $cost' format when no running/queued agents but finished exist", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.01);
    const widget = new AgentWidget(manager, activity);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    // Only finished agents, no running/queued
    const finished = makeFinishedAgent("f1");
    widget.markFinished("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "agents: $0.01");
  });

  it("shows 'N agents' without cost when cost is zero", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0);
    const widget = new AgentWidget(manager, activity);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0;
    (manager as any).listAgents = () => [agent];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 agent");
  });
});

describe("status bar cost from accumulator", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, AgentActivity>;

  it("uses getTotalAgentCost for status bar when no running agents", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    // No running agents, but totalAgentCost is $1.23 (from evicted agents)
    manager = makeMockManager([], 1.23);
    widget = new AgentWidget(manager, activity);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    // Trigger an update with a running agent so the status bar is emitted
    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Status bar should include $1.28 ($1.23 session + $0.05 running)
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringContaining("$1.28"));
  });

  it("shows accumulated cost even when no running agents have cost", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    // Running agent with $0 cost, but session accumulator has $2.50
    manager = makeMockManager([], 2.50);
    widget = new AgentWidget(manager, activity);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0; // Running agent has no cost yet
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Should show $2.50 from accumulator
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringContaining("$2.50"));
  });

  it("hides cost when showCost is false", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    manager = makeMockManager([], 1.50);
    widget = new AgentWidget(manager, activity);
    widget.setShowCost(false);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Should NOT contain $ when cost is hidden
    const statusCall = (uiCtx.setStatus as any).mock.calls.find(
      (c: any[]) => c[0] === "subagents",
    );
    expect(statusCall[1]).not.toContain("$");
  });
});

// ------------------------------------------------------------------ */
/*  Compact mode and max lines tests                                 */
/* ------------------------------------------------------------------ */

describe("compact mode", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, AgentActivity>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, activity);
  });

  it("defaults to non-compact mode and renders multi-line", () => {
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Full mode: heading + 1 header + 1 activity continuation = 3 lines
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("compact mode renders running agent as single line (no continuations)", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Heading + 1 line for compact agent (no activity continuation line)
    expect(lines).toHaveLength(2);
    // The agent line should contain the activity inline
    expect(lines[1]).toContain("reading");
  });

  it("full mode renders running agent with continuation lines", () => {
    widget.setCompactMode(false);
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Heading + 1 header + 1 activity continuation
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

describe("max lines configuration", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, AgentActivity>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, activity);
  });

  it("setMaxLines updates the full mode max lines", () => {
    widget.setMaxLines(8);
    // Create 8 running agents to test overflow
    const agents = Array.from({ length: 8 }, (_, i) => makeRunningAgent(`a${i}`));
    for (const a of agents) activity.set(a.id, makeActivity(a.id));
    (manager as any).listAgents = () => agents;

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Should be capped at 8 lines (1 heading + 7 body max)
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("setMaxLinesCompact updates compact mode max lines", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(3);
    // Create 5 running agents
    const agents = Array.from({ length: 5 }, (_, i) => makeRunningAgent(`a${i}`));
    for (const a of agents) activity.set(a.id, makeActivity(a.id));
    (manager as any).listAgents = () => agents;

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Should be capped at 3 lines (1 heading + 2 body max)
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("shows overflow indicator when agents exceed max lines", () => {
    widget.setMaxLines(5);
    const agents = Array.from({ length: 10 }, (_, i) => makeRunningAgent(`a${i}`));
    for (const a of agents) activity.set(a.id, makeActivity(a.id));
    (manager as any).listAgents = () => agents;

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Should have overflow indicator
    const hasOverflow = lines.some((l: string) => l.includes("more"));
    expect(hasOverflow).toBe(true);
  });
});

describe("formatMs", () => {
  it("formats hours, minutes, and seconds", () => {
    expect(formatMs(3661000)).toBe("1h 1m 1s");
  });

  it("formats minutes and seconds only", () => {
    expect(formatMs(337500)).toBe("5m 37s");
  });

  it("formats seconds only", () => {
    expect(formatMs(10000)).toBe("10s");
  });

  it("formats exactly zero seconds as <1s", () => {
    expect(formatMs(0)).toBe("<1s");
  });

  it("formats values under 1 second as <1s", () => {
    expect(formatMs(999)).toBe("<1s");
  });

  it("rounds down seconds (no decimals)", () => {
    expect(formatMs(1999)).toBe("1s");
  });

  it("handles exactly 1 hour", () => {
    expect(formatMs(3600000)).toBe("1h");
  });

  it("handles hours and seconds, zero minutes", () => {
    expect(formatMs(3601000)).toBe("1h 1s");
  });

  it("handles non-finite values as <1s", () => {
    expect(formatMs(Infinity)).toBe("<1s");
    expect(formatMs(NaN)).toBe("<1s");
  });

  it("handles negative values as <1s", () => {
    expect(formatMs(-1000)).toBe("<1s");
  });

  it("formats large durations", () => {
    expect(formatMs(90061000)).toBe("25h 1m 1s");
  });

  it("formatMs(1000) is exactly 1s, not <1s", () => {
    expect(formatMs(1000)).toBe("1s");
  });
});
