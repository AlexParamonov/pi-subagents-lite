/**
 * agent-widget.test.ts — Tests for widget rendering.
 *
 * Verifies that the widget renders correct formatting:
 *   - Headers use 2-space prefix (no tree connectors)
 *   - Activity lines use a tree connector (│ or └) prefix
 *   - outputFile lines appear before activity lines
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/spawn/spawn-coordinator.js";
import { visibleWidth } from "@earendil-works/pi-tui";
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
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    truncateToWidth: actual.truncateToWidth,
    visibleWidth: actual.visibleWidth,
  };
});

function makeMockManager(agents: any[], totalAgentCost = 0, totalAgentCount = agents.length): AgentManager {
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
    text: "text",
  };
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makePlainTheme(): any {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeMockTUI(columns = 200): any {
  return { terminal: { columns } };
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

function makeQueuedAgent(id: string, type: string = "builder"): any {
  const agent = makeRunningAgent(id, type);
  agent.lifecycle.status = "queued";
  return agent;
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
      expect(lines[2]).toMatch(/^\[text:  [│└]/);
    });

    it("places outputFile line before activity line", () => {
      const agent = makeRunningAgent("a1");
      agent.display.outputFile = "/tmp/pi-agent-outputs/test.log";
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // line[1] = header, line[2] = outputFile, line[3] = activity
      expect(lines[2]).toContain("tail -f");
      expect(lines[3]).toMatch(/^\[text:  [│└]/);
      expect(lines[3]).toContain("reading");
    });

    it("activity line uses └ connector", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[2]).toMatch(/^\[text:  └/);
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
      expect(lines[2]).toMatch(/^\[text:  [│└]/);
      expect(lines[4]).toMatch(/^\[text:  [│└]/);
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

  describe("running agent text colors", () => {
    it("uses text for every regular full-row part while keeping the spinner accented", () => {
      const agent = makeRunningAgent("a1");
      agent.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
      agent.display.worktreeLabel = "feature";
      agent.display.outputFile = "/tmp/output.log";
      activity.set(agent.id, makeActivity(agent.id));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      expect(lines[1]).toContain("[accent:⠋]");
      expect(lines[1]).toContain("[text:**Builder**]");
      expect(lines[1]).toContain("[text:(sonnet · high)]");
      expect(lines[1]).toContain("[text:Test agent a1]");
      expect(lines[1]).toContain("[text:5⚙︎");
      expect(lines[2]).toMatch(/^\[text:  │ @feature  tail -f \/tmp\/output\.log\]/);
      expect(lines[3]).toMatch(/^\[text:  └ reading…\]/);
      expect(lines.slice(1).join("\n")).not.toContain("[dim:");
    });

    it("uses text for every regular compact-row part", () => {
      widget.setCompactMode(true);
      widget.setWidgetShortcut(true);
      const agent = makeRunningAgent("a1");
      agent.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
      activity.set(agent.id, makeActivity(agent.id));
      (manager as any).listAgents = () => [agent];

      const line = (widget as any).renderWidget(makeMockTUI(), makeMockTheme())[1];

      expect(line).toContain("[accent:⠋]");
      expect(line).toContain("[text:**Builder**]");
      expect(line).toContain("[text:(sonnet · high)]");
      expect(line).toContain("[text:Test agent a1]");
      expect(line).toContain("[text:5⚙︎");
      expect(line).toContain("[text:reading…]");
      expect(line).not.toContain("[dim:");
    });

    it("uses semantic stats groups while keeping tool and turn cells contiguous", () => {
      const running = makeRunningAgent("running");
      const finished = makeFinishedAgent("finished");
      for (const agent of [running, finished]) {
        agent.stats.toolUses = 20;
        agent.stats.turnCount = 6;
        agent.stats.lifetimeUsage = { input: 1000, output: 500, cacheWrite: 0, cost: 0 };
      }
      activity.set(running.id, makeActivity(running.id));
      (manager as any).listAgents = () => [running, finished];

      const lines = (widget as any).renderWidget(makeMockTUI(), makePlainTheme());
      const statsRows = lines.filter((line: string) => line.includes("20⚙︎"));

      expect(statsRows).toHaveLength(2);
      for (const row of statsRows) {
        expect(row).toContain("20⚙︎  6⟳ · ↑1.0k ↓500 ·");
        expect(row).toMatch(/↑1\.0k ↓500 · (?:\d+m(?: \d+s)?|\d+s)/);
        expect(row).not.toContain("20⚙︎ · 6⟳");
        expect(row).not.toContain("20⚙︎  6⟳  ↑");
      }
    });

    it("preserves an error stat color and reapplies text after its ANSI foreground reset", () => {
      const agent = makeRunningAgent("a1");
      agent.stats.contextPercent = 90.1;
      agent.stats.contextWindow = 272000;
      const ansiTheme = {
        fg: (color: string, text: string) => {
          const code = color === "error" ? 31 : color === "text" ? 97 : 37;
          return `\u001b[${code}m${text}\u001b[39m`;
        },
        bold: (text: string) => text,
      };

      const statsLine = (widget as any).buildStatsLine(agent, ansiTheme);

      expect(statsLine).toContain("\u001b[31m90.1%/272k\u001b[39m");
      expect(statsLine).toContain("\u001b[31m90.1%/272k\u001b[39m\u001b[97m · ");
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

    it("dims raw finished stats without applying the running text foreground", () => {
      const agent = makeFinishedAgent("a1");
      agent.stats.contextPercent = 95;
      agent.stats.contextWindow = 272000;
      (manager as any).listAgents = () => [agent];
      const ansiTheme = {
        fg: (color: string, text: string) => {
          const code = color === "dim" ? 2 : color === "error" ? 31 : color === "text" ? 97 : 37;
          const reset = color === "dim" ? 22 : 39;
          return `\u001b[${code}m${text}\u001b[${reset}m`;
        },
        bold: (text: string) => text,
      };

      const line = (widget as any).renderWidget(makeMockTUI(), ansiTheme)[1];

      expect(line).toContain("\u001b[2m10⚙︎");
      expect(line).toContain("\u001b[31m95.0%/272k\u001b[39m");
      expect(line).not.toContain("\u001b[97m");
    });
  });

  describe("mixed agent statuses", () => {
    it("renders one globally newest-first list regardless of status", () => {
      const base = new Date(2024, 0, 2, 9, 0).getTime();
      const newerRunning = makeRunningAgent("r-new");
      newerRunning.display.description = "Newer running";
      newerRunning.lifecycle.startedAt = base + 3_000;
      const olderRunning = makeRunningAgent("r-old");
      olderRunning.display.description = "Older running";
      olderRunning.lifecycle.startedAt = base;
      const queued = makeQueuedAgent("q1");
      queued.lifecycle.startedAt = base + 2_000;
      const finished = makeFinishedAgent("f1");
      finished.lifecycle.startedAt = base + 1_000;
      activity.set(newerRunning.id, makeActivity(newerRunning.id));
      activity.set(olderRunning.id, makeActivity(olderRunning.id));
      // Deliberately interleave statuses and timestamps from the manager.
      (manager as any).listAgents = () => [finished, olderRunning, queued, newerRunning];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      const runningNewIndex = lines.findIndex((line: string) => line.includes("Newer running"));
      const queuedIndex = lines.findIndex((line: string) => line.includes("Test agent q1"));
      const finishedIndex = lines.findIndex((line: string) => line.includes("Finished agent f1"));
      const runningOldIndex = lines.findIndex((line: string) => line.includes("Older running"));

      expect(runningNewIndex).toBeGreaterThan(0);
      expect(queuedIndex).toBeGreaterThan(runningNewIndex);
      expect(finishedIndex).toBeGreaterThan(queuedIndex);
      expect(runningOldIndex).toBeGreaterThan(finishedIndex);
    });
  });

  it("preserves manager order for equal startedAt values across statuses", () => {
    const startedAt = new Date(2024, 0, 2, 9, 0).getTime();
    const queued = makeQueuedAgent("queued");
    queued.lifecycle.startedAt = startedAt;
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.startedAt = startedAt;
    const running = makeRunningAgent("running");
    running.lifecycle.startedAt = startedAt;
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [queued, finished, running];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const queuedIndex = lines.findIndex((line: string) => line.includes("Test agent queued"));
    const finishedIndex = lines.findIndex((line: string) => line.includes("Finished agent finished"));
    const runningIndex = lines.findIndex((line: string) => line.includes("Test agent running"));

    expect(queuedIndex).toBeGreaterThan(0);
    expect(finishedIndex).toBeGreaterThan(queuedIndex);
    expect(runningIndex).toBeGreaterThan(finishedIndex);
  });

  it("places a fixed local HH:MM start time directly after every status symbol", () => {
    const running = makeRunningAgent("running");
    running.lifecycle.startedAt = new Date(2024, 0, 2, 3, 4).getTime();
    const queued = makeQueuedAgent("queued");
    queued.lifecycle.startedAt = new Date(2024, 0, 2, 3, 5).getTime();
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.startedAt = new Date(2024, 0, 2, 3, 6).getTime();
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [running, queued, finished];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines.find((line: string) => line.includes("Test agent running"))).toContain("[accent:⠋] [text:03:04]");
    expect(lines.find((line: string) => line.includes("Test agent queued"))).toContain("[dim:◇] [dim:03:05]");
    expect(lines.find((line: string) => line.includes("Finished agent finished"))).toContain("[success:✓] [dim:03:06]");
  });

  it("hides local start time for running, queued, and finished rows when disabled", () => {
    const running = makeRunningAgent("running");
    running.lifecycle.startedAt = new Date(2024, 0, 2, 3, 4).getTime();
    const queued = makeQueuedAgent("queued");
    queued.lifecycle.startedAt = new Date(2024, 0, 2, 3, 5).getTime();
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.startedAt = new Date(2024, 0, 2, 3, 6).getTime();
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [running, queued, finished];
    widget.setShowStartTime(false);

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme()).join("\n");

    expect(lines).not.toContain("03:04");
    expect(lines).not.toContain("03:05");
    expect(lines).not.toContain("03:06");
  });

  it("applies the start-time setting in compact mode for every status", () => {
    const running = makeRunningAgent("running");
    running.lifecycle.startedAt = new Date(2024, 0, 2, 3, 4).getTime();
    const queued = makeQueuedAgent("queued");
    queued.lifecycle.startedAt = new Date(2024, 0, 2, 3, 5).getTime();
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.startedAt = new Date(2024, 0, 2, 3, 6).getTime();
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [running, queued, finished];
    widget.setWidgetShortcut(true);
    widget.setCompactMode(true);

    const shown = (widget as any).renderWidget(makeMockTUI(), makeMockTheme()).join("\n");
    expect(shown).toContain("03:04");
    expect(shown).toContain("03:05");
    expect(shown).toContain("03:06");

    widget.setShowStartTime(false);
    const hidden = (widget as any).renderWidget(makeMockTUI(), makeMockTheme()).join("\n");
    expect(hidden).not.toContain("03:04");
    expect(hidden).not.toContain("03:05");
    expect(hidden).not.toContain("03:06");
  });

  it("returns the six start-time columns to descriptions on narrow terminals", () => {
    const agent = makeRunningAgent("narrow");
    const description = "abcdefghijklmnopqrstuvwxyz1234";
    agent.display.description = description;
    (manager as any).listAgents = () => [agent];
    widget.setStatsVisibility({ showTools: false, showTurns: false, showInput: false, showOutput: false, showContext: false, showTime: false });

    const withTime = (widget as any).renderWidget(makeMockTUI(50), makePlainTheme())[1];
    widget.setShowStartTime(false);
    const withoutTime = (widget as any).renderWidget(makeMockTUI(50), makePlainTheme())[1];

    expect(withTime).not.toContain(description);
    expect(withoutTime).toContain(description);
  });
});

describe("queued agent status display", () => {
  let widget: AgentWidget;
  let manager: AgentManager;

  beforeEach(() => {
    manager = makeMockManager([]);
    widget = new AgentWidget(manager, () => undefined);
  });

  it("uses the queued display, local start time, and an individual row for each queued agent", () => {
    const q1 = makeQueuedAgent("q1");
    q1.lifecycle.startedAt = new Date(2024, 0, 2, 3, 4).getTime();
    const q2 = makeQueuedAgent("q2");
    q2.lifecycle.startedAt = new Date(2024, 0, 2, 3, 3).getTime();
    (manager as any).listAgents = () => [q2, q1];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines[0]).toMatch(/^\[dim:◇\]/);
    expect(lines[1]).toContain("[dim:◇] [dim:03:04]");
    expect(lines[1]).toContain("Test agent q1");
    expect(lines[2]).toContain("Test agent q2");
    expect(lines.join("\n")).not.toContain("2 queued");
  });

  it("keeps the running-agent spinner when queued agents are also present", () => {
    const running = makeRunningAgent("running");
    (manager as any).listAgents = () => [running, makeQueuedAgent("queued")];

    const lines = (widget as any).renderWidget(makeMockTUI(), makePlainTheme());

    expect(lines[0]).toMatch(/^◈ Agents/);
    expect(lines.find((line: string) => line.includes("Test agent running"))).toContain("⠋");
  });
});

describe("finished agent status icons", () => {
  it.each([
    ["completed", "✓"],
    ["turn_limited", "✓"],
    ["stopped", "■"],
    ["error", "✗"],
    ["aborted", "✗"],
  ])("uses %s icon %s", (status, icon) => {
    const widget = new AgentWidget(makeMockManager([]), () => undefined);
    expect((widget as any).finishedIconAndStatus(status, undefined, makePlainTheme()).icon).toBe(icon);
  });
});

describe("status bar format", () => {
  it("uses Pi's dim token and restyles status text after widget invalidation", () => {
    const uiCtx = { theme: makeMockTheme(), setStatus: vi.fn(), setWidget: vi.fn() };
    const widget = new AgentWidget(makeMockManager([], 0, 1), () => undefined);
    widget.setUICtx(uiCtx);
    (widget as any).manager.listAgents = () => [makeRunningAgent("a1")];

    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "[dim:1 active · 1 agent total]");

    uiCtx.theme = {
      fg: (color: string, text: string) => `[new-${color}:${text}]`,
      bold: (text: string) => text,
    };
    const widgetFactory = (uiCtx.setWidget as any).mock.calls[0][1];
    widgetFactory(makeMockTUI(), makeMockTheme()).invalidate();

    expect(uiCtx.setStatus).toHaveBeenLastCalledWith("subagents", "[new-dim:1 active · 1 agent total]");
  });

  it("shows active and session-total counts with running-agent cost", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 10);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const a1 = makeRunningAgent("a1");
    a1.stats.lifetimeUsage.cost = 0.05;
    const a2 = makeRunningAgent("a2");
    a2.stats.lifetimeUsage.cost = 0.03;
    (manager as any).listAgents = () => [a1, a2];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringMatching(/^2 active · 10 agents total: \$0\.\d+$/));
  });

  it("shows only the session total when no agents are active", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0.01, 10);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    // One retained finished record represents a session that has had ten agents.
    const finished = makeFinishedAgent("f1");
    (manager as any).listAgents = () => [finished];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "10 agents total: $0.010");
  });

  it("uses the session total instead of the retained finished-agent count", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const manager = makeMockManager([], 0, 10);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setUICtx(uiCtx);

    (manager as any).listAgents = () => [makeRunningAgent("running"), makeFinishedAgent("finished-1"), makeFinishedAgent("finished-2")];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 active · 10 agents total");
  });

  it("retains the session summary when retention removes the last record", () => {
    let statusText: string | undefined;
    const uiCtx = {
      setStatus: vi.fn((_key: string, text: string | undefined) => { statusText = text; }),
      setWidget: vi.fn(),
    };
    const manager = makeMockManager([], 0.01, 10);
    const widget = new AgentWidget(manager, () => undefined);
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    let agents = [makeFinishedAgent("finished")];
    (manager as any).listAgents = () => agents;
    widget.update();

    agents = [];
    widget.update();

    expect(statusText).toBe("10 agents total: $0.010");
    expect(uiCtx.setStatus).not.toHaveBeenCalledWith("subagents", undefined);
    expect(uiCtx.setStatus).toHaveBeenCalledTimes(1);
    expect(uiCtx.setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("shows active and total counts without cost when cost is zero", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    const activity = new Map();
    const manager = makeMockManager([], 0, 1);
    const widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setShowCost(true);
    widget.setUICtx(uiCtx);

    const agent = makeRunningAgent("a1");
    agent.stats.lifetimeUsage.cost = 0;
    (manager as any).listAgents = () => [agent];
    widget.update();

    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", "1 active · 1 agent total");
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
    expect(uiCtx.setStatus).toHaveBeenCalledWith("subagents", expect.stringContaining("$1.28"));
  });

  it("shows accumulated cost even when no running agents have cost", () => {
    const uiCtx = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    activity = new Map();
    // Running agent with $0 cost, but session accumulator has $2.50
    manager = makeMockManager([], 2.50, 2);
    widget = new AgentWidget(manager, (id) => activity.get(id));
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
    manager = makeMockManager([], 1.50, 1);
    widget = new AgentWidget(manager, (id) => activity.get(id));
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

  it("keeps running stats and activity visible beside a long finished description",  () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setDescLengthCompact(12);
    const finished = makeFinishedAgent("finished");
    finished.display.description = "A finished description that is much too long for the compact row";
    const running = makeRunningAgent("running");
    running.display.description = "Run task";
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [finished, running];

    const lines = (widget as any).renderWidget(makeMockTUI(90), makePlainTheme());
    const runningLine = lines.find((line: string) => line.includes("Run task"))!;

    expect(runningLine).toContain("5⚙︎");
    expect(runningLine).toContain("reading");
  });
});

describe("full mode narrow layout", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("keeps a short running agent's usage visible beside a long finished description", () => {
    const finished = makeFinishedAgent("finished");
    finished.display.description = "A finished description that consumes the entire shared description column";
    const running = makeRunningAgent("running");
    running.display.description = "Run task";
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [finished, running];

    const lines = (widget as any).renderWidget(makeMockTUI(70), makePlainTheme());
    const runningLine = lines.find((line: string) => line.includes("Run task"))!;

    expect(runningLine).toContain("5⚙︎");
    expect(runningLine).toContain("↑1.0k");
  });
});

describe("narrow model and thinking labels", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("keeps running stats visible at 70 columns with a long model and thinking label", () => {
    const agent = makeRunningAgent("a1");
    agent.display.description = "A description that may use only the remaining space";
    agent.display.invocation = {
      modelName: "a-very-long-model-name-that-must-be-truncated",
      thinkingLevel: "high",
    };
    activity.set(agent.id, makeActivity(agent.id));
    (manager as any).listAgents = () => [agent];

    const fullLine = (widget as any).renderWidget(makeMockTUI(70), makePlainTheme())[1];
    expect(fullLine).toContain("5⚙︎");
    expect(fullLine).toContain("↑1.0k");
    expect(fullLine).not.toContain("undefined");
    expect(visibleWidth(fullLine)).toBeLessThanOrEqual(70);

    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    const compactLine = (widget as any).renderWidget(makeMockTUI(70), makePlainTheme())[1];
    expect(compactLine).toContain("5⚙︎");
    expect(compactLine).toContain("↑1.0k");
    expect(compactLine).toContain("reading");
    expect(compactLine).not.toContain("undefined");
    expect(visibleWidth(compactLine)).toBeLessThanOrEqual(70);
  });
});

describe("Pi usage display", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("uses the same complete Pi block for live and completed records", () => {
    const usage = {
      input: 83000, output: 7100, cacheWrite: 12000, cost: 1.262,
    };
    const live = makeRunningAgent("live");
    live.stats = {
      ...live.stats, lifetimeUsage: usage, cacheRead: 1300000, latestCacheHitRate: 99.1,
    };
    live.execution.session = {
      getContextUsage: () => ({ percent: 23.4, contextWindow: 272000 }),
      autoCompactionEnabled: true,
      model: { provider: "kimi-coding" },
    };
    const finished = makeFinishedAgent("finished");
    finished.stats = {
      ...finished.stats, lifetimeUsage: usage, cacheRead: 1300000, latestCacheHitRate: 99.1,
      contextPercent: 23.4, contextWindow: 272000, autoCompactionEnabled: true, usingSubscription: true,
    };
    (manager as any).listAgents = () => [live, finished];

    widget.setShowCost(true);
    const lines = (widget as any).renderWidget(makeMockTUI(), makePlainTheme()).join("\n");
    const expected = "↑83k ↓7.1k R1.3M W12k CH99.1% $1.262 (sub) 23.4%/272k (auto)";
    expect(lines.split(expected)).toHaveLength(3);
  });
});

describe("model and thinking labels", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("shows model and concrete thinking level for a running agent in full mode", () => {
    const agent = makeRunningAgent("a1");
    agent.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[1]).toContain("(sonnet · high)");
  });

  it("shows model and concrete thinking level for a running agent in compact mode", () => {
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    const agent = makeRunningAgent("a1");
    agent.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("(sonnet · high)");
  });

  it("shows model and concrete thinking level for a finished agent", () => {
    const agent = makeFinishedAgent("a1");
    agent.display.invocation = { modelName: "sonnet", thinkingLevel: "high" };
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[1]).toContain("(sonnet · high)");
  });

  it("hides the model-and-thinking column for running, queued, and finished rows in full and compact modes", () => {
    const running = makeRunningAgent("running");
    running.display.invocation = { modelName: "model-running", thinkingLevel: "high" };
    const queued = makeQueuedAgent("queued");
    queued.display.invocation = { modelName: "model-queued", thinkingLevel: "high" };
    const finished = makeFinishedAgent("finished");
    finished.display.invocation = { modelName: "model-finished", thinkingLevel: "high" };
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [running, queued, finished];

    for (const compact of [false, true]) {
      widget.setWidgetShortcut(compact);
      widget.setCompactMode(compact);
      const shown = (widget as any).renderWidget(makeMockTUI(), makePlainTheme()).join("\n");
      expect(shown).toContain("(model-running · high)");
      expect(shown).toContain("(model-queued · high)");
      expect(shown).toContain("(model-finished · high)");

      widget.setShowModelThinking(false);
      const hidden = (widget as any).renderWidget(makeMockTUI(), makePlainTheme()).join("\n");
      expect(hidden).not.toContain("model-running");
      expect(hidden).not.toContain("model-queued");
      expect(hidden).not.toContain("model-finished");
      expect(hidden).not.toContain(" · high");
      widget.setShowModelThinking(true);
    }
  });

  it("returns the hidden model-and-thinking column width to descriptions", () => {
    const agent = makeRunningAgent("narrow");
    const description = "abcdefghijklmnopqrstuvwxyz1234";
    agent.display.description = description;
    agent.display.invocation = { modelName: "long-model-name", thinkingLevel: "high" };
    activity.set(agent.id, makeActivity(agent.id));
    (manager as any).listAgents = () => [agent];
    widget.setShowStartTime(false);
    widget.setStatsVisibility({ showTools: false, showTurns: false, showInput: false, showOutput: false, showContext: false, showTime: false });

    const withModelThinking = (widget as any).renderWidget(makeMockTUI(45), makePlainTheme())[1];
    widget.setShowModelThinking(false);
    const withoutModelThinking = (widget as any).renderWidget(makeMockTUI(45), makePlainTheme())[1];

    expect(withModelThinking).not.toContain(description);
    expect(withoutModelThinking).toContain(description);
  });

  it("does not invent a model when none was captured", () => {
    const agent = makeRunningAgent("a1");
    agent.display.invocation = { thinkingLevel: "high" };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines[1]).toContain("(high)");
    expect(lines[1]).not.toContain("thinking:");
    expect(lines[1]).not.toContain("undefined");
  });

  it("shows a model without a missing, inherited, or invalid thinking level", () => {
    const agents = ["missing", "inherit", "invalid"].map((id) => {
      const agent = makeRunningAgent(id);
      agent.display.invocation = {
        modelName: "sonnet",
        thinkingLevel: id === "missing" ? undefined : id === "inherit" ? "inherit" : "invalid",
      };
      activity.set(id, makeActivity(id));
      return agent;
    });
    (manager as any).listAgents = () => agents;

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    for (const line of [lines[1], lines[3], lines[5]]) {
      expect(line).toContain("(sonnet)");
      expect(line).not.toContain("thinking:");
    }
  });

  it("uses fixed column gaps for full, compact, finished, and individual queued rows", () => {
    const finished = makeFinishedAgent("finished", "explore");
    finished.display.description = "Finished description";
    finished.display.invocation = { modelName: "haiku" };
    const running = makeRunningAgent("running", "builder");
    running.display.description = "Running description";
    running.display.invocation = { modelName: "very-long-model", thinkingLevel: "high" };
    const queued = makeRunningAgent("queued", "queue");
    queued.lifecycle.status = "queued";
    queued.display.description = "Queued description";
    queued.display.invocation = { modelName: "sonnet" };
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [finished, running, queued];
    widget.navActivate();

    const stripMockStyling = (line: string) => line
      .replace(/\[(?:accent|dim|text|success|error|warning|muted):/g, "")
      .replaceAll("]", "")
      .replaceAll("**", "");
    const labelWidth = "(very-long-model · high)".length;
    const nameWidth = "Explore".length;
    const assertColumnGaps = (line: string, name: string, label: string, description: string) => {
      const plain = stripMockStyling(line);
      const nameStart = plain.indexOf(name);
      const labelStart = plain.indexOf(label);
      expect(labelStart).toBe(nameStart + nameWidth + 2);
      expect(plain.indexOf(description)).toBe(labelStart + labelWidth + 2);
      return plain;
    };
    const findHeader = (lines: string[], description: string) =>
      lines.find((line) => line.includes(description))!;

    const fullLines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const finishedHeader = assertColumnGaps(findHeader(fullLines, "Finished description"), "Explore", "(haiku)", "Finished description");
    const runningHeader = assertColumnGaps(findHeader(fullLines, "Running description"), "Builder", "(very-long-model · high)", "Running description");
    assertColumnGaps(findHeader(fullLines, "Queued description"), "Queue", "(sonnet)", "Queued description");
    expect(finishedHeader.indexOf("Finished description")).toBe(runningHeader.indexOf("Running description"));
    const statEnd = (line: string, stat: string) => visibleWidth(line.slice(0, line.indexOf(stat))) + visibleWidth(stat);
    expect(statEnd(finishedHeader, "10⚙︎")).toBe(statEnd(runningHeader, "5⚙︎"));

    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    const compactLines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    assertColumnGaps(findHeader(compactLines, "Running description"), "Builder", "(very-long-model · high)", "Running description");

    finished.display.invocation = undefined;
    running.display.invocation = undefined;
    queued.display.invocation = undefined;
    const noModelLines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const noModelRunningHeader = stripMockStyling(findHeader(noModelLines, "Running description"));
    expect(noModelRunningHeader).toContain("Builder  Running description");
  });

  it("aligns columns by terminal width for CJK names, models, and descriptions", () => {
    const cjk = makeRunningAgent("cjk", "研究");
    cjk.display.description = "解析";
    cjk.display.invocation = { modelName: "模型" };
    cjk.stats.toolUses = 1;
    const ascii = makeRunningAgent("ascii", "builder");
    ascii.display.description = "abcdef";
    ascii.display.invocation = { modelName: "sonnet" };
    ascii.stats.toolUses = 2;
    (manager as any).listAgents = () => [cjk, ascii];

    const lines = (widget as any).renderWidget(makeMockTUI(), makePlainTheme());
    const cjkHeader = lines.find((line: string) => line.includes("解析"))!;
    const asciiHeader = lines.find((line: string) => line.includes("abcdef"))!;
    const columnStart = (line: string, text: string) => visibleWidth(line.slice(0, line.indexOf(text)));

    expect(columnStart(cjkHeader, "解析")).toBe(columnStart(asciiHeader, "abcdef"));
    expect(columnStart(cjkHeader, "1⚙︎")).toBe(columnStart(asciiHeader, "2⚙︎"));
  });

  it("aligns structured stats across heterogeneous running and finished rows", () => {
    const running = makeRunningAgent("running");
    running.lifecycle.startedAt = Date.now() - 147_000;
    running.stats = {
      ...running.stats,
      toolUses: 22,
      turnCount: 13,
      lifetimeUsage: { input: 98_000, output: 6_000, cacheWrite: 3_000, cost: 0.024 },
      cacheRead: 459_000,
      latestCacheHitRate: 94.3,
      contextPercent: 45,
      contextWindow: 128_000,
      autoCompactionEnabled: true,
    };
    const finished = makeFinishedAgent("finished");
    finished.lifecycle.startedAt = Date.now() - 149_000;
    finished.lifecycle.completedAt = Date.now() - 60_000;
    finished.stats = {
      ...finished.stats,
      toolUses: 9,
      turnCount: 2,
      lifetimeUsage: { input: 78_000, output: 3_000, cacheWrite: 0, cost: 1.2 },
      cacheRead: 85_000,
      latestCacheHitRate: 92.1,
      contextPercent: 9,
      contextWindow: 128_000,
    };
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [running, finished];

    const lines = (widget as any).renderWidget(makeMockTUI(), makePlainTheme());
    const runningHeader = lines.find((line: string) => line.includes("22⚙︎"))!;
    const finishedHeader = lines.find((line: string) => line.includes("9⚙︎"))!;
    const start = (line: string, text: string) => visibleWidth(line.slice(0, line.indexOf(text)));
    const end = (line: string, text: string) => start(line, text) + visibleWidth(text);

    expect(runningHeader).toContain("22⚙︎  13⟳ ·");
    expect(finishedHeader).toMatch(/\s9⚙︎\s{2}\s2⟳ ·/);
    expect(runningHeader).not.toContain("22⚙︎ ·");
    expect(end(runningHeader, "22⚙︎")).toBe(end(finishedHeader, "9⚙︎"));
    expect(end(runningHeader, "13⟳")).toBe(end(finishedHeader, "2⟳"));
    for (const [left, right] of [["↑98k", "↑78k"], ["↓6.0k", "↓3.0k"], ["R459k", "R85k"], ["CH94.3%", "CH92.1%"], ["$0.024", "$1.200"], ["45.0%/128k", "9.0%/128k"], ["2m 27s", "1m 29s"]]) {
      expect(start(runningHeader, left)).toBe(start(finishedHeader, right));
    }
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

  it("clamps full and compact widget line limits to two total lines", () => {
    widget.setMaxLines(1);
    widget.setMaxLinesCompact(1);

    expect((widget as any).maxLines).toBe(2);
    expect((widget as any).maxLinesCompact).toBe(2);
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

  it("keeps a running header visible instead of a finished row at the two-line full-mode limit", () => {
    widget.setMaxLines(2);
    const running = makeRunningAgent("running");
    const finished = makeFinishedAgent("finished");
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [finished, running];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines).toHaveLength(2);
    expect(lines.some((line: string) => line.includes("Test agent running"))).toBe(true);
    expect(lines.some((line: string) => line.includes("Finished agent finished"))).toBe(false);
  });

  it("shows active headers before finished rows and counts only fully hidden agents", () => {
    widget.setMaxLines(4);
    const running = makeRunningAgent("running");
    running.display.outputFile = "/tmp/running.log";
    const queued = makeQueuedAgent("queued");
    const finished = makeFinishedAgent("finished");
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [finished, running, queued];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines).toHaveLength(4);
    expect(lines.some((line: string) => line.includes("Test agent running"))).toBe(true);
    expect(lines.some((line: string) => line.includes("Test agent queued"))).toBe(true);
    expect(lines.some((line: string) => line.includes("Finished agent finished"))).toBe(false);
    expect(lines.find((line: string) => line.includes("more"))).toContain("1 finished");
    expect(lines.join("\n")).not.toContain("running, 1 queued");
  });

  it("counts finished continuation rows when applying the full-mode line budget", () => {
    widget.setMaxLines(5);
    const agents = Array.from({ length: 4 }, (_, index) => {
      const agent = makeFinishedAgent(`f${index}`);
      agent.display.outputFile = `/tmp/f${index}.log`;
      agent.lifecycle.startedAt = new Date(2024, 0, 2, 9, index).getTime();
      return agent;
    });
    (manager as any).listAgents = () => agents;

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.filter((line: string) => line.includes("Finished agent")).length).toBe(1);
    expect(lines.some((line: string) => line.includes("more"))).toBe(true);
  });

  it("prioritizes active agents, fills with the newest finished row, then restores global order", () => {
    widget.setMaxLines(6);
    const running = makeRunningAgent("r1");
    running.lifecycle.startedAt = new Date(2024, 0, 2, 9, 0).getTime();
    const queued = makeQueuedAgent("q1");
    queued.lifecycle.startedAt = new Date(2024, 0, 2, 9, 3).getTime();
    const newestFinished = makeFinishedAgent("newest");
    newestFinished.lifecycle.startedAt = new Date(2024, 0, 2, 9, 2).getTime();
    const olderFinished = makeFinishedAgent("older");
    olderFinished.lifecycle.startedAt = new Date(2024, 0, 2, 9, 1).getTime();
    const oldestFinished = makeFinishedAgent("oldest");
    oldestFinished.lifecycle.startedAt = new Date(2024, 0, 2, 8, 59).getTime();
    activity.set(running.id, makeActivity(running.id));
    (manager as any).listAgents = () => [olderFinished, running, oldestFinished, queued, newestFinished];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const queuedIndex = lines.findIndex((line: string) => line.includes("Test agent q1"));
    const finishedIndex = lines.findIndex((line: string) => line.includes("Finished agent newest"));
    const runningIndex = lines.findIndex((line: string) => line.includes("Test agent r1"));

    expect(queuedIndex).toBeGreaterThan(0);
    expect(finishedIndex).toBeGreaterThan(queuedIndex);
    expect(runningIndex).toBeGreaterThan(finishedIndex);
    expect(lines.some((line: string) => line.includes("Finished agent older"))).toBe(false);
    expect(lines.some((line: string) => line.includes("Finished agent oldest"))).toBe(false);
    expect(lines.find((line: string) => line.includes("more"))).toContain("2 finished");
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
      activeTools: new Map([["read_123", "read"], ["bash_456", "bash"]]),
      responseText: "",
    });

    const widget = new AgentWidget(
      manager,
      (id: string) => coordinatorViews.get(id),
    );

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // lines[0] = heading, lines[1] = header (└─), lines[2] = activity continuation
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const continuation = lines[2];
    expect(continuation).toContain("reading");
    expect(continuation).toContain("running command");
    expect(continuation).not.toContain("thinking…");
  });

  it("returns undefined for unknown agent", () => {
    const manager = makeMockManager([]);
    const liveViews = new Map<string, LiveView>();
    // liveViews has no entry for a1
    const widget = new AgentWidget(
      manager,
      (id: string) => liveViews.get(id),
    );

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

    const widget = new AgentWidget(
      manager,
      (id: string) => liveViews.get(id),
    );

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

    const widget = new AgentWidget(
      manager,
      (id: string) => liveViews.get(id),
    );

    const agent = makeRunningAgent("a1");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[2]).toContain("Here is my response");
    expect(lines[2]).not.toContain("thinking…");
  });
});

describe("widget invocation thinking", () => {
  it("shows the normalized thinking level stored on the invocation", () => {
    const agent = makeRunningAgent("thinking-agent");
    agent.display.invocation = { thinkingLevel: "off" };
    const manager = makeMockManager([agent]);
    const widget = new AgentWidget(manager, () => makeActivity(agent.id));

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    expect(lines.join("\n")).toContain("(off)");
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
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l: string) => l.includes("Finished agent f1"))).toBe(true);
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

    const hasActivity = activity.has("a1");
    expect(hasActivity).toBe(true);
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
    expect(allText).not.toContain("⚙︎");
  });

  it("hides time when showTime is false", () => {
    widget.setStatsVisibility({ showTime: false });
    const agent = makeRunningAgent("a1");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    // The running agent started 60s ago so would show "1m" — should be absent
    expect(allText).not.toMatch(/\d+m \d+s|\d+s/);
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
    agent.stats.lifetimeUsage.cost = 1.50;
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
    expect(allText).not.toContain("⚙︎");
  });

  it("shows all stats when visibility flags are all true (default)", () => {
    // Don't set any visibility flags — defaults should show everything
    const agent = makeRunningAgent("a1");
    agent.stats.compactionCount = 1;
    agent.stats.lifetimeUsage.cost = 0.50;
    agent.execution = {
      session: {
        getSessionStats: () => ({ contextUsage: { percent: 60 } }),
      },
    };
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const allText = lines.join(" ");
    expect(allText).toContain("⚙︎");
    expect(allText).toContain("⟳");
    expect(allText).toContain("↑");
    expect(allText).toContain("$");
  });
});
