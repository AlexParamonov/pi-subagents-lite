/**
 * agent-widget.test.ts — Tests for widget rendering.
 *
 * Verifies that the widget renders correct formatting:
 *   - Headers use 2-space prefix (no tree connectors)
 *   - Activity lines use a tree connector (│ or └) prefix
 *   - outputFile lines appear before activity lines
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget, formatMs } from "../../src/ui/agent-widget.js";

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

function makeMockManager(agents: any[], totalAgentCost = 0, totalAgentCount = 0): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => totalAgentCost,
    getTotalAgentCount: () => totalAgentCount,
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
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
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
      lifetimeUsage: { input: 2000, output: 1000, cacheWrite: 0, cost: 0 },
      turnCount: 8,
      maxTurns: 30,
    },
  };
}

function makeActivity(agentId: string): LiveView {
  return {
    activeTools: new Map([["read", "reading"]]),
    responseText: "",
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("widget rendering format", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("last running agent", () => {
    it("uses 2-space prefix for last running agent header", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toMatch(/^  /);
    });

    it("uses │ for last running agent activity line", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Activity line is the second line (index 2, after heading)
      expect(lines[2]).toMatch(/^\[dim:  [│└]/);
    });

    it("places outputFile line before activity line", () => {
      const agent = makeRunningAgent("a1");
      agent.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // line[1] = header, line[2] = outputFile, line[3] = activity
      expect(lines[2]).toContain("tail -f");
      expect(lines[3]).toMatch(/^\[dim:  [│└]/);
      expect(lines[3]).toContain("reading");
    });

    it("activity line uses └ connector", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[2]).toMatch(/^\[dim:  └/);
    });
  });

  describe("multiple running agents", () => {
    it("uses 2-space prefix for all agent headers", () => {
      const a1 = makeRunningAgent("a1");
      const a2 = makeRunningAgent("a2");
      activity.set("a1", makeActivity("a1"));
      activity.set("a2", makeActivity("a2"));
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Both agent headers use 2-space prefix with tree connector
      expect(lines[1]).toMatch(/^  /);
      expect(lines[3]).toMatch(/^  /);
    });

    it("uses spaces for all activity lines", () => {
      const a1 = makeRunningAgent("a1");
      const a2 = makeRunningAgent("a2");
      activity.set("a1", makeActivity("a1"));
      activity.set("a2", makeActivity("a2"));
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Activity lines use │ or └ connector
      expect(lines[2]).toMatch(/^\[dim:  [│└]/);
      expect(lines[4]).toMatch(/^\[dim:  [│└]/);
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
      expect(lines[3]).toContain("reading");
      expect(lines[5]).toContain("out2.log");
      expect(lines[6]).toContain("reading");
    });
  });

  describe("finished agents", () => {
    it("uses 2-space prefix for finished agent headers", () => {
      const a1 = makeFinishedAgent("a1");
      const a2 = makeFinishedAgent("a2");
      (manager as any).listAgents = () => [a1, a2];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toMatch(/^  /); // All agents use 2-space prefix
      expect(lines[2]).toMatch(/^  /); // All agents use 2-space prefix
    });

    it("uses spaces for tail-f line of last finished agent", () => {
      const a1 = makeFinishedAgent("a1");
      a1.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      (manager as any).listAgents = () => [a1];
      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[1]).toMatch(/^  /); // All agents use 2-space prefix
      // tail-f line should have spaces only (no connector)
      expect(lines[2]).toMatch(/^\[dim:\s{4}/);
      expect(lines[2]).toContain("tail -f");
    });

    it("outputFile lines use spaces for all finished agents", () => {
      const a1 = makeFinishedAgent("a1");
      a1.display.outputFile = "/tmp/out1.log";
      const a2 = makeFinishedAgent("a2");
      a2.display.outputFile = "/tmp/out2.log";
      (manager as any).listAgents = () => [a1, a2];
      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // All tail-f lines use spaces only (no connector) for finished agents
      expect(lines[2]).toMatch(/^\[dim:\s{4}/);
      expect(lines[4]).toMatch(/^\[dim:\s{4}/);
      expect(lines[2]).toContain("out1.log");
      expect(lines[4]).toContain("out2.log");
    });
  });

  describe("mixed running and finished", () => {
    it("uses 2-space prefix for all items regardless of type", () => {
      const running = makeRunningAgent("r1");
      const finished = makeFinishedAgent("f1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [finished, running];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // Both use 2-space prefix
      expect(lines[1]).toMatch(/^  /); // finished agent
      expect(lines[2]).toMatch(/^  /); // running agent
    });
  });
});

describe("status bar format", () => {
  it("shows '◈ Agents: N active' when running agents with no cost", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0;
    (manager as any).listAgents = () => [a1];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringContaining("◈ Agents: 1 active"));
  });

  it("shows '◈ Agents: N active · M done · $cost' with running, done, and cost", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.12, 5);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0;
    (manager as any).listAgents = () => [a1];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toContain("◈ Agents: 1 active · 5 done · ");
  });

  it("shows '◇ Agents: M done · $cost' when no running agents but finished exist", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.01, 1);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toContain("◇ Agents: 1 done · ");
  });

  it("omits cost section when cost is zero", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 2);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0;
    (manager as any).listAgents = () => [agent];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).not.toContain("$");
    expect(statusCall[1]).toContain("1 active");
  });

  it("omits active count when active is 0", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.5, 3);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).not.toContain("active");
    expect(statusCall[1]).toContain("done");
  });

  it("omits done count when done is 0", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).not.toContain("done");
    expect(statusCall[1]).toContain("active");
  });

  it("shows '◇ Agents: M done' without cost when done exists but cost is zero", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 1);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toBe("◇ Agents: 1 done");
  });
});

describe("status bar cost from accumulator", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  it("uses getTotalAgentCost for status bar when no running agents", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    // No running agents, but totalAgentCost is $1.23 (from evicted agents)
    manager = makeMockManager([], 1.23, 2);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    // Trigger an update with a running agent so the status bar is emitted
    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Status bar should include $1.28 ($1.23 session + $0.05 running)
    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toContain("$1.28");
  });

  it("shows accumulated cost even when no running agents have cost", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    // Running agent with $0 cost, but session accumulator has $2.50
    manager = makeMockManager([], 2.5, 1);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0; // Running agent has no cost yet
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Should show $2.50 from accumulator
    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toContain("$2.50");
  });

  it("hides cost when showCost is false", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    manager = makeMockManager([], 1.5, 1);
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(false);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0.05;
    (manager as any).listAgents = () => [agent];
    widget.update();

    // Should NOT contain $ when cost is hidden
    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).not.toContain("$");
  });
});

describe("status bar compact format", () => {
  it("compact format: '◈ 2 5Σ $0.12' with active, done, and cost", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
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
    (manager as any).listAgents = () => [a1, a2];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toBe("◈ 2 5Σ $0.12");
  });

  it("compact format omits cost section when cost is zero", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 2);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    (manager as any).listAgents = () => [a1];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toBe("◈ 1 2Σ");
  });

  it("compact format omits active count when 0", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.5, 3);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toBe("◇ 3Σ $0.50");
  });

  it("compact format omits done count when 0", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    (manager as any).listAgents = () => [a1];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toBe("◈ 1");
  });

  it("compact format shows '◇' when no active agents exist", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 0);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setStatusBarFormat("compact");
    widget.setUICtx(uiCtx);

    // finished agent triggers update
    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    const statusCall = (uiCtx.setStatus as any).mock.calls.find((c: any[]) => c[0] === "subagents");
    expect(statusCall[1]).toContain("◇");
  });
});

// ------------------------------------------------------------------ */
/*  Compact mode and max lines tests                                 */
/* ------------------------------------------------------------------ */

describe("compact mode", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("defaults to non-compact mode and renders multi-line", () => {
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Full mode: heading + 1 header + 1 activity metadata line = 3 lines
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("compact mode renders running agent as single line (no metadata lines)", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Heading + 1 line for compact agent (no activity metadata line)
    expect(lines).toHaveLength(2);
    // The agent line should contain the activity inline
    expect(lines[1]).toContain("reading");
  });

  it("full mode renders running agent with metadata lines", () => {
    widget.setCompactMode(false);
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Heading + 1 header + 1 activity metadata line
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

describe("max lines configuration", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
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

describe("description length configuration", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("compact mode truncates description using descLengthCompact setting", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setDescLengthCompact(15);
    const agent = makeRunningAgent("a1");
    agent.display.description = "This is a very long description that should be truncated";
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const agentLine = lines[1];
    // Description should be truncated (contains ...) and full text should be absent
    expect(agentLine).toContain("...");
    expect(agentLine).not.toContain("This is a very long description that should be truncated");
  });

  it("full mode truncates description using descLengthFull setting", () => {
    widget.setDescLengthFull(20);
    const agent = makeRunningAgent("a1");
    agent.display.description = "This is a very long description that should be truncated";
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const agentLine = lines[1];
    // Description should be truncated (contains ...) and full text should be absent
    expect(agentLine).toContain("...");
    expect(agentLine).not.toContain("This is a very long description that should be truncated");
  });

  it("finished agent truncates description using descLengthFull setting", () => {
    widget.setDescLengthFull(25);
    const agent = makeFinishedAgent("a1");
    agent.display.description = "This is a very long description that should be truncated";
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const agentLine = lines[1];
    // Description should be truncated (contains ...) and full text should be absent
    expect(agentLine).toContain("...");
    expect(agentLine).not.toContain("This is a very long description that should be truncated");
  });

  it("compact mode shows full description when shorter than limit", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setDescLengthCompact(50);
    const agent = makeRunningAgent("a1");
    agent.display.description = "Short desc";
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[1]).toContain("Short desc");
    expect(lines[1]).not.toContain("...");
  });

  it("full mode shows full description when shorter than limit", () => {
    widget.setDescLengthFull(100);
    const agent = makeRunningAgent("a1");
    agent.display.description = "Short desc";
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[1]).toContain("Short desc");
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

describe("getLiveView callback", () => {
  it("uses getLiveView to show tool activity for running agents", () => {
    const manager = makeMockManager([]);
    // Simulate coordinator's liveView map with real activity data
    const coordinatorViews = new Map<string, LiveView>();
    coordinatorViews.set("a1", {
      activeTools: new Map([
        ["read_123", "read"],
        ["bash_456", "bash"],
      ]),
      responseText: "",
    });

    const widget = new AgentWidget(manager, (id: string) => coordinatorViews.get(id));

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // lines[0] = heading, lines[1] = header (└─), lines[2] = activity metadata line
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const metadataLine = lines[2];
    expect(metadataLine).toContain("reading");
    expect(metadataLine).toContain("running command");
    expect(metadataLine).not.toContain("thinking…");
  });

  it("returns undefined for unknown agent", () => {
    const manager = makeMockManager([]);
    const liveViews = new Map<string, LiveView>();
    // liveViews has no entry for a1
    const widget = new AgentWidget(manager, (id: string) => liveViews.get(id));

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // No activity data → shows thinking
    expect(lines[2]).toContain("thinking…");
  });

  it("shows getLiveView data for running agents", () => {
    const manager = makeMockManager([]);
    const liveViews = new Map<string, LiveView>();
    liveViews.set("a1", {
      activeTools: new Map([["read_1", "read"]]),
      responseText: "",
    });

    const widget = new AgentWidget(manager, (id: string) => liveViews.get(id));

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // Should show the liveView data
    expect(lines[2]).toContain("reading");
  });

  it("shows streaming response text from getLiveView", () => {
    const manager = makeMockManager([]);
    const liveViews = new Map<string, LiveView>();
    liveViews.set("a1", {
      activeTools: new Map(),
      responseText: "Here is my response to the user…",
    });

    const widget = new AgentWidget(manager, (id: string) => liveViews.get(id));

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[2]).toContain("Here is my response");
    expect(lines[2]).not.toContain("thinking…");
  });
});

describe("renderFinishedLine context percent", () => {
  it("uses stats.contextPercent for finished agents without execution.session", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setUICtx(uiCtx);

    const finished = makeFinishedAgent("f1");
    // Set context percent in stats (what agent-manager writes at completion)
    finished.stats.contextPercent = 72;
    // No session on execution — the display code must NOT reach here
    finished.execution = {};
    (manager as any).listAgents = () => [finished];

    // Track what buildStatsParts receives by mocking getSessionContextPercent
    // indirectly: the widget should render without needing execution.session
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => l.includes("Finished agent f1"))).toBe(true);
    // The stats line must show the recorded 72% context usage.
    expect(lines.some((l: string) => l.includes("72%"))).toBe(true);
  });

  it("prefers record execution.session for running agents context percent", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setUICtx(uiCtx);

    const running = makeRunningAgent("a1");
    running.stats.contextPercent = 50;
    running.execution = {
      session: {
        getSessionStats: () => ({ contextUsage: { percent: 85 } }),
      },
    };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [running];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.length).toBeGreaterThan(0);

    // The session's 85% must win over stats.contextPercent's 50% in the stats line
    expect(lines.some((l: string) => l.includes("85%"))).toBe(true);
    expect(lines.some((l: string) => l.includes("50%"))).toBe(false);
  });
});

describe("renderFinishedLine watchdog stop", () => {
  it("shows the watchdog reason for a tool-timeout kill", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setUICtx(uiCtx);

    const agent = makeFinishedAgent("f1");
    agent.lifecycle.status = "stopped";
    agent.lifecycle.stoppedBy = "watchdog";
    agent.lifecycle.stopDetail = { kind: "tool", toolName: "bash", elapsedMs: 45 * 60_000 };
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => l.includes("watchdog: bash >45m"))).toBe(true);
  });

  it("shows a plain stopped line for a user stop (no watchdog summary)", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([]);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setUICtx(uiCtx);

    const agent = makeFinishedAgent("f1");
    agent.lifecycle.status = "stopped";
    agent.lifecycle.stoppedBy = "user";
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const stoppedLine = lines.find((l: string) => l.includes("Finished agent f1"));
    expect(stoppedLine).toContain(" stopped");
    expect(stoppedLine).not.toContain("watchdog");
  });
});

// ------------------------------------------------------------------ */
/*  Stats visibility integration tests                               */
/* ------------------------------------------------------------------ */

describe("stats visibility integration", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("hides tools count when showTools is false", () => {
    widget.setStatsVisibility({ showTools: false });
    const agent = makeRunningAgent("a1");
    agent.stats.toolUses = 10;
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).not.toContain("🛠︎");
  });

  it("hides time when showTime is false", () => {
    widget.setStatsVisibility({ showTime: false });
    const agent = makeRunningAgent("a1");
    agent.lifecycle.startedAt = Date.now() - 65_000; // would render "1m 5s"
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    // The running agent started 65s ago so would show "1m 5s" — should be absent
    expect(allText).not.toContain("1m 5s");
  });

  it("shows time when showTime is true (default)", () => {
    const agent = makeRunningAgent("a1");
    agent.lifecycle.startedAt = Date.now() - 65_000; // renders "1m 5s"
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).toContain("1m 5s");
  });

  it("hides context percent and compactions when showContext is false", () => {
    widget.setStatsVisibility({ showContext: false });
    const agent = makeRunningAgent("a1");
    agent.stats.compactionCount = 3;
    agent.execution = {
      session: {
        getSessionStats: () => ({ contextUsage: { percent: 75 } }),
      },
    };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).not.toContain("%");
    expect(allText).not.toContain("↻");
  });

  it("hides cost when showCost is false via statsVisibility", () => {
    widget.setStatsVisibility({ showCost: false });
    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 1.5;
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).not.toContain("$");
  });

  it("hides tools in finished agent stats when showTools is false", () => {
    widget.setStatsVisibility({ showTools: false });
    const agent = makeFinishedAgent("a1");
    agent.stats.toolUses = 15;
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).not.toContain("🛠︎");
  });

  it("shows all stats when visibility flags are all true (default)", () => {
    // Don't set any visibility flags — defaults should show everything
    const agent = makeRunningAgent("a1");
    agent.stats.compactionCount = 1;
    agent.stats.lifetimeUsage.cost = 0.5;
    agent.execution = {
      session: {
        getSessionStats: () => ({ contextUsage: { percent: 60 } }),
      },
    };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).toContain("🛠︎");
    expect(allText).toContain("⟳");
    expect(allText).toContain("↑");
    expect(allText).toContain("$");
  });
});

describe("turn-based eviction for finished agents", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  type RenderedState = {
    visible: string[];
    arrow: string | null;
    readout: string | null;
  };

  /** Render the widget and extract visible agent ids, arrow target, and nav readout. */
  function renderState(widget: AgentWidget): RenderedState {
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const visible: string[] = [];
    let arrow: string | null = null;
    for (const line of lines) {
      const m = line.match(/agent ([\w-]+)/);
      if (!m) continue;
      if (line.includes("→")) arrow = m[1];
      visible.push(m[1]);
    }
    const heading = lines[0] ?? "";
    const readout = heading.match(/\d+\/\d+/)?.[0] ?? null;
    return { visible, arrow, readout };
  }

  it("markFinished is a no-op when eviction is disabled", () => {
    widget.setFinishedEvictTurns(0);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];
    widget.markFinished("a1");

    // Enable eviction after the fact: an untracked agent is treated as age 0
    // forever, so it must survive 3 turns. If markFinished had registered it,
    // age 3 >= threshold 2 would evict it.
    widget.setFinishedEvictTurns(2);
    for (let i = 0; i < 3; i++) widget.onTurnStart();
    expect(renderState(widget).visible).toEqual(["a1"]);
  });

  it("finished agents age correctly across multiple turns", () => {
    widget.setFinishedEvictTurns(3);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];
    widget.markFinished("a1");

    // Age 1: still visible (1 < 3); nav readout and arrow show the roster.
    widget.onTurnStart();
    widget.navActivate();
    expect(renderState(widget)).toEqual({ visible: ["a1"], arrow: "a1", readout: "1/1" });

    // Age 2: still visible (2 < 3)
    widget.onTurnStart();
    expect(renderState(widget).visible).toEqual(["a1"]);

    // Age 3: evicted (3 >= 3) — nothing left to render, readout disappears
    widget.onTurnStart();
    expect(renderState(widget)).toEqual({ visible: [], arrow: null, readout: null });
  });

  it("finished agents are hidden after finishedEvictTurns turns", () => {
    widget.setFinishedEvictTurns(2);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];

    widget.markFinished("a1");
    widget.onTurnStart(); // age → 1
    widget.onTurnStart(); // age → 2
    expect(renderState(widget).visible).toEqual([]);
  });

  it("finished agents are shown before finishedEvictTurns threshold", () => {
    widget.setFinishedEvictTurns(3);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];

    widget.markFinished("a1");
    widget.onTurnStart(); // age → 1
    expect(renderState(widget).visible).toEqual(["a1"]);
  });

  for (const status of ["error", "aborted", "turn_limited", "stopped"] as const) {
    it(`${status} agents get +2 bonus linger turns`, () => {
      widget.setFinishedEvictTurns(1);
      const agent = makeFinishedAgent("a1");
      agent.lifecycle.status = status;
      (manager as any).listAgents = () => [agent];

      widget.markFinished("a1");

      // Ages 1-3 visible (maxAge = 1 + 2 = 3, age <= 3)
      widget.onTurnStart(); // age -> 1
      expect(renderState(widget).visible).toEqual(["a1"]);
      widget.onTurnStart(); // age -> 2
      expect(renderState(widget).visible).toEqual(["a1"]);
      widget.onTurnStart(); // age -> 3
      expect(renderState(widget).visible).toEqual(["a1"]);
      // Age 4: hidden (4 <= 3 is false)
      widget.onTurnStart(); // age -> 4
      expect(renderState(widget).visible).toEqual([]);
    });
  }

  it("setting 0 shows all finished agents (disabled)", () => {
    // Enable eviction first so markFinished actually registers
    widget.setFinishedEvictTurns(2);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];
    widget.markFinished("a1");
    // Then disable eviction
    widget.setFinishedEvictTurns(0);

    // Even after many turns, agent is visible when evictTurns = 0
    for (let i = 0; i < 20; i++) widget.onTurnStart();
    expect(renderState(widget).visible).toEqual(["a1"]);
  });

  it("manager listAgents is not affected by turn eviction", () => {
    widget.setFinishedEvictTurns(1);
    const agent = makeFinishedAgent("a1");
    (manager as any).listAgents = () => [agent];

    widget.markFinished("a1");
    widget.onTurnStart();

    // Evicted from the rendered roster...
    expect(renderState(widget).visible).toEqual([]);
    // ...but manager.listAgents still returns it
    expect(manager.listAgents()).toHaveLength(1);
  });

  it("prunes tracking entries for agents removed from the manager", () => {
    widget.setFinishedEvictTurns(2);
    (manager as any).listAgents = () => [makeFinishedAgent("gone")];
    widget.markFinished("gone");

    // "gone" leaves the manager while its entry keeps aging...
    (manager as any).listAgents = () => [];
    widget.onTurnStart(); // age 1
    widget.onTurnStart(); // age 2
    widget.onTurnStart(); // age 3 (>= threshold 2 → would be evicted on return)

    // ...and the prune runs inside the render (entries for absent agents drop).
    expect(renderState(widget).visible).toEqual([]);

    // Reappearing starts fresh: the stale entry was pruned, so age is 0 again.
    (manager as any).listAgents = () => [makeFinishedAgent("gone")];
    expect(renderState(widget).visible).toEqual(["gone"]);
  });
});
