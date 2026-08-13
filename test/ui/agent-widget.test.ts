/**
 * agent-widget.test.ts — Tests for widget rendering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/types.js";
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

// ANSI-aware mocks for truncateToWidth and visibleWidth
// These mocks properly handle ANSI escape codes like the real implementation
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number, ellipsis: string = "...") => {
    const visible = stripAnsi(text);
    if (visible.length <= width) return text;
    // Simplified truncation: just cut and add ellipsis
    // Real implementation preserves ANSI, but this mock verifies the interface
    const truncated = visible.slice(0, width - ellipsis.length);
    return truncated + ellipsis;
  },
  visibleWidth: (text: string) => stripAnsi(text).length,
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
      completedAt: Date.now() - 30000,
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
    });

    it("uses spaces for tail-f line of last finished agent", () => {
      const a1 = makeFinishedAgent("a1");
      a1.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      (manager as any).listAgents = () => [a1];
      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
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

/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
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

describe("description truncation", () => {
  it("does not truncate descriptions to 50 chars when terminal is wide", () => {
    const agent = makeRunningAgent("test-1");
    agent.display.description = "a".repeat(100);
    const testManager = makeMockManager([agent]);
    const widget = new AgentWidget(testManager, () => undefined);

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    const descLine = lines.find((l: string) => l.includes("aaa"));
    expect(descLine).toBeDefined();
    expect(descLine).toContain(agent.display.description);
  });

  it("descLengthFull and descLengthCompact properties are removed", () => {
    const testManager = makeMockManager([]);
    const widget = new AgentWidget(testManager, () => undefined);
    expect((widget as any).descLengthFull).toBeUndefined();
    expect((widget as any).descLengthCompact).toBeUndefined();
  });

  it("stats remain visible when descriptions are long", () => {
    const agent = makeRunningAgent("test-1");
    agent.display.description = "x".repeat(500);
    const testManager = makeMockManager([agent]);
    const widget = new AgentWidget(testManager, () => ({ activeTools: new Map(), responseText: "" }));

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    const headerLine = lines.find((l: string) => l.includes("**Builder**"));
    expect(headerLine).toBeDefined();
    // Stats (tool uses, turns) should be visible in the output
    expect(headerLine).toContain("5"); // toolUses: 5
    expect(headerLine).toContain("3"); // turnCount: 3
  });

  it("descriptions grow with terminal width", () => {
    const agent = makeRunningAgent("test-1");
    agent.display.description = "Test description that should grow with width";
    const testManager = makeMockManager([agent]);
    const widget = new AgentWidget(testManager, () => undefined);

    // Render at narrow width
    const narrowTUI = { terminal: { columns: 80 } };
    const narrowLines = (widget as any).renderWidget(narrowTUI, makeMockTheme());
    const narrowDescLine = narrowLines.find((l: string) => l.includes("Test description"));

    // Render at wide width
    const wideTUI = { terminal: { columns: 200 } };
    const wideLines = (widget as any).renderWidget(wideTUI, makeMockTheme());
    const wideDescLine = wideLines.find((l: string) => l.includes("Test description"));

    // Both should contain the description (truncation happens but description is present)
    expect(narrowDescLine).toBeDefined();
    expect(wideDescLine).toBeDefined();
    // The wide terminal should show more of the description
    // (less truncated since more space available)
    const narrowDescMatch = narrowDescLine.match(/Test description[^\]]*/);
    const wideDescMatch = wideDescLine.match(/Test description[^\]]*/);
    if (narrowDescMatch && wideDescMatch) {
      // Wide terminal should have longer visible description
      expect(wideDescMatch[0].length).toBeGreaterThanOrEqual(narrowDescMatch[0].length);
    }
  });

  it("ANSI escape codes in descriptions survive truncation", () => {
    const agent = makeRunningAgent("test-1");
    // Description with ANSI codes (simulating colored text)
    agent.display.description = "\x1b[31mRed description\x1b[0m with color";
    const testManager = makeMockManager([agent]);
    const widget = new AgentWidget(testManager, () => undefined);

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const descLine = lines.find((l: string) => l.includes("Red description"));
    expect(descLine).toBeDefined();
    // ANSI codes must not break rendering; verify the visible text survives.
    expect(descLine).toContain("Red description");
  });

  it("compact mode prioritizes description over activity when space is tight", () => {
    const agent = makeRunningAgent("test-1");
    agent.display.description = "A".repeat(100);
    const testManager = makeMockManager([agent]);
    const widget = new AgentWidget(testManager, () => undefined);
    widget.setCompactMode(true);

    // Mock activity with long text
    const liveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const getLiveView = () => liveView;
    const widget2 = new AgentWidget(testManager, getLiveView);
    widget2.setCompactMode(true);

    // Force activity to be long enough to trigger prioritization
    liveView.activeTools = new Map([
      ["read", "read"],
      ["bash", "bash"],
      ["edit", "edit"],
    ]);

    // Render at narrow width to trigger the prioritization logic
    const narrowTUI = { terminal: { columns: 60 } };
    const lines = (widget2 as any).renderWidget(narrowTUI, makeMockTheme());

    // Find the compact line (should have description and possibly activity)
    const compactLine = lines.find((l: string) => l.includes("AAA"));
    expect(compactLine).toBeDefined();
    expect(compactLine).toContain("AAA");
  });
});

describe("finished-agent time window", () => {
  let widget: AgentWidget;
  let manager: AgentManager;

  type RenderedState = {
    visible: string[];
    arrow: string | null;
    readout: string | null;
  };

  /** Render the widget and extract visible agent ids, arrow target, and nav readout. */
  function renderState(w: AgentWidget): RenderedState {
    const lines = (w as any).renderWidget(makeMockTUI(), makeMockTheme());
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

  function finishedAgent(id: string, completedMinutesAgo: number): any {
    const agent = makeFinishedAgent(id);
    agent.lifecycle.completedAt = Date.now() - completedMinutesAgo * 60_000;
    return agent;
  }

  beforeEach(() => {
    manager = makeMockManager([]);
    widget = new AgentWidget(manager, () => undefined);
  });

  it("shows a finished agent while it is inside the retention window", () => {
    widget.setFinishedRetentionMinutes(5);
    (manager as any).listAgents = () => [finishedAgent("a1", 2)];
    expect(renderState(widget).visible).toEqual(["a1"]);
  });

  it("hides a finished agent once the retention window has elapsed", () => {
    widget.setFinishedRetentionMinutes(5);
    (manager as any).listAgents = () => [finishedAgent("a1", 10)];
    expect(renderState(widget).visible).toEqual([]);
  });

  it("keeps running and queued agents visible regardless of age", () => {
    widget.setFinishedRetentionMinutes(1);
    const running = makeRunningAgent("r1");
    running.lifecycle.startedAt = Date.now() - 30 * 60_000;
    const queued: any = {
      id: "q1",
      display: { type: "builder", description: "Queued agent q1" },
      lifecycle: { status: "queued", startedAt: Date.now() - 30 * 60_000 },
      execution: {},
      stats: {
        toolUses: 0,
        compactionCount: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        turnCount: 1,
        maxTurns: 30,
      },
    };
    (manager as any).listAgents = () => [running, queued];
    widget.navActivate(); // queued rows render individually during navigation
    expect(renderState(widget).visible).toEqual(["r1", "q1"]);
  });

  it("applies the window uniformly across finished statuses (no linger bonuses)", () => {
    widget.setFinishedRetentionMinutes(5);
    const stopped = finishedAgent("s1", 10);
    stopped.lifecycle.status = "stopped";
    (manager as any).listAgents = () => [stopped];
    expect(renderState(widget).visible).toEqual([]);
  });

  it("hides a finished row from the widget while the menu still lists the record", () => {
    widget.setFinishedRetentionMinutes(5);
    const agent = finishedAgent("a1", 10);
    (manager as any).listAgents = () => [agent];
    expect(renderState(widget).visible).toEqual([]);
    expect(manager.listAgents()).toHaveLength(1);
  });

  it("hides a finished row as time passes the window, on the next render", () => {
    vi.useFakeTimers();
    try {
      const agent = finishedAgent("a1", 2);
      (manager as any).listAgents = () => [agent];
      widget.setFinishedRetentionMinutes(5);
      expect(renderState(widget).visible).toEqual(["a1"]);
      vi.advanceTimersByTime(4 * 60_000); // now 6 minutes past completion
      expect(renderState(widget).visible).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a window change on the next render", () => {
    const agent = finishedAgent("a1", 2);
    (manager as any).listAgents = () => [agent];
    widget.setFinishedRetentionMinutes(5);
    expect(renderState(widget).visible).toEqual(["a1"]);
    widget.setFinishedRetentionMinutes(1);
    expect(renderState(widget).visible).toEqual([]);
  });

  it("defaults to a 1-minute window when no setter has been called", () => {
    // 15s old — inside the default window
    (manager as any).listAgents = () => [finishedAgent("a1", 0.25)];
    expect(renderState(widget).visible).toEqual(["a1"]);
    // 3 min old — outside the default window
    (manager as any).listAgents = () => [finishedAgent("a1", 3)];
    expect(renderState(widget).visible).toEqual([]);
  });
});
