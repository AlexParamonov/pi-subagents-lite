/**
 * worktree-widget-display.test.ts — Acceptance tests for worktree label in widget.
 *
 * Verifies:
 *   - Full mode shows worktreeLabel on the agent's continuation line
 *   - Compact mode does NOT show worktreeLabel
 *   - Worktree label renders for running and finished agents
 *   - Parallel agents with different worktree labels are distinguishable
 *
 * Follows agent-widget.test.ts patterns: uses makeMockManager, makeMockTheme,
 * direct renderWidget calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";

/* ------------------------------------------------------------------ */
/*  Mock setup (same as agent-widget.test.ts)                         */
/* ------------------------------------------------------------------ */

vi.mock("../../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => text,
}));

/* ------------------------------------------------------------------ */
/*  Factories                                                         */
/* ------------------------------------------------------------------ */

function makeMockManager(agents: any[], totalAgentCost = 0): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => totalAgentCost,
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

function makeRunningAgent(id: string, type: string = "builder", worktreeLabel?: string): any {
  return {
    id,
    display: {
      type,
      description: `Test agent ${id}`,
      worktreeLabel,
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

function makeFinishedAgent(id: string, type: string = "builder", worktreeLabel?: string): any {
  return {
    id,
    display: {
      type,
      description: `Finished agent ${id}`,
      worktreeLabel,
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

function makeActivity(_agentId: string): LiveView {
  return {
    activeTools: new Map([["read", "reading"]]),
    responseText: "",
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("widget worktree label — full mode", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(false);
  });

  it("shows worktreeLabel on the continuation line for a running agent", () => {
    const agent = makeRunningAgent("a1", "builder", "feature/packages/web");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // The continuation line (after header) should contain the worktree label
    const continuationLine = lines.find((l: string) => l.includes("feature/packages/web"));
    expect(continuationLine).toBeDefined();
    expect(continuationLine).toContain("@");
  });

  it("shows worktreeLabel for a finished agent", () => {
    const agent = makeFinishedAgent("a1", "builder", "feature");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const hasLabel = lines.some((l: string) => l.includes("feature"));
    expect(hasLabel).toBe(true);
  });

  it("does not show worktreeLabel when agent has no worktree", () => {
    const agent = makeRunningAgent("a1", "builder"); // no worktreeLabel
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Should not crash — just no worktree-specific content
    expect(lines.length).toBeGreaterThan(0);
  });

  it("shows worktreeLabel and tail -f on the same continuation line", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    agent.display.outputFile = "/tmp/pi-agent-outputs/test.log";
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Both @ feature and tail -f should be on the same continuation line
    const combinedLine = lines.find((l: string) => l.includes("@feature") && l.includes("tail -f"));
    expect(combinedLine).toBeDefined();
  });

  it("shows worktreeLabel on its own line when no outputFile", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const labelLine = lines.find((l: string) => l.includes("@feature"));
    expect(labelLine).toBeDefined();
    expect(labelLine).not.toContain("tail -f");
  });

  it("shows distinct worktree labels for parallel agents with different worktrees", () => {
    const a1 = makeRunningAgent("a1", "builder", "feature");
    const a2 = makeRunningAgent("a2", "builder", "bugfix");
    activity.set("a1", makeActivity("a1"));
    activity.set("a2", makeActivity("a2"));
    (manager as any).listAgents = () => [a1, a2];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const hasFeature = lines.some((l: string) => l.includes("feature"));
    const hasBugfix = lines.some((l: string) => l.includes("bugfix"));
    expect(hasFeature).toBe(true);
    expect(hasBugfix).toBe(true);
  });
});

describe("widget worktree label — compact mode", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
  });

  it("does NOT show worktreeLabel in compact mode for a running agent", () => {
    const agent = makeRunningAgent("a1", "builder", "feature/packages/web");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const hasLabel = lines.some((l: string) => l.includes("feature/packages/web"));
    expect(hasLabel).toBe(false);
  });

  it("does NOT show worktreeLabel in compact mode for a finished agent", () => {
    const agent = makeFinishedAgent("a1", "builder", "feature");
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const hasLabel = lines.some((l: string) => l.includes("feature"));
    expect(hasLabel).toBe(false);
  });

  it("compact mode still shows agent activity without worktree label", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    activity.set("a1", makeActivity("a1"));
    (manager as any).listAgents = () => [agent];

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Should still have agent type and activity visible
    expect(lines.some((l: string) => l.includes("reading"))).toBe(true);
  });
});
