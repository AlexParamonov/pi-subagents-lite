/**
 * worktree-widget-display.test.ts — Acceptance tests for worktree label in widget.
 *
 * Follows agent-widget.test.ts patterns: shared widget-helpers factories,
 * rendering through the public update() seam.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView, AgentRecord } from "../../src/types.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { makeMockManager, renderWidgetLines } from "./widget-helpers.js";

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
  getAgentConfig: agentConfigMock(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => text,
  visibleWidth: (text: string) => text.length,
}));

/* ------------------------------------------------------------------ */
/*  Factories                                                         */
/* ------------------------------------------------------------------ */

function makeRunningAgent(id: string, type: string = "builder", worktreeLabel?: string): AgentRecord {
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
      started: true,
    },
    execution: { settled: false, settlementCount: 0 },
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
  };
}

function makeFinishedAgent(id: string, type: string = "builder", worktreeLabel?: string): AgentRecord {
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
      completedAt: Date.now() - 30000,
      started: true,
    },
    execution: { settled: false, settlementCount: 0 },
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

  it("shows worktreeLabel on the metadata line for a running agent", () => {
    const agent = makeRunningAgent("a1", "builder", "feature/packages/web");
    activity.set("a1", makeActivity("a1"));
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    const metadataLine = lines.find((l: string) => l.includes("feature/packages/web"));
    expect(metadataLine).toBeDefined();
    expect(metadataLine).toContain("@");
  });

  it("shows worktreeLabel for a finished agent", () => {
    const agent = makeFinishedAgent("a1", "builder", "feature");
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    const hasLabel = lines.some((l: string) => l.includes("feature"));
    expect(hasLabel).toBe(true);
  });

  it("does not show worktreeLabel when agent has no worktree", () => {
    const agent = makeRunningAgent("a1", "builder"); // no worktreeLabel
    activity.set("a1", makeActivity("a1"));
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    // No worktree label anywhere: a stray "@undefined" (or any @-prefixed
    // garbage) must not render.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(" ")).not.toContain("@");
  });

  it("shows worktreeLabel and tail -f on the same metadata line", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    agent.display.outputFile = "/tmp/pi-agent-outputs/test.log";
    activity.set("a1", makeActivity("a1"));
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    // Both @ feature and tail -f should be on the same metadata line
    const combinedLine = lines.find((l: string) => l.includes("@feature") && l.includes("tail -f"));
    expect(combinedLine).toBeDefined();
  });

  it("shows worktreeLabel on its own line when no outputFile", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    activity.set("a1", makeActivity("a1"));
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    const labelLine = lines.find((l: string) => l.includes("@feature"));
    expect(labelLine).toBeDefined();
    expect(labelLine).not.toContain("tail -f");
  });

  it("shows distinct worktree labels for parallel agents with different worktrees", () => {
    const a1 = makeRunningAgent("a1", "builder", "feature");
    const a2 = makeRunningAgent("a2", "builder", "bugfix");
    activity.set("a1", makeActivity("a1"));
    activity.set("a2", makeActivity("a2"));
    manager.listAgents = () => [a1, a2];

    const lines = renderWidgetLines(widget);
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
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    const hasLabel = lines.some((l: string) => l.includes("feature/packages/web"));
    expect(hasLabel).toBe(false);
  });

  it("does NOT show worktreeLabel in compact mode for a finished agent", () => {
    const agent = makeFinishedAgent("a1", "builder", "feature");
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    const hasLabel = lines.some((l: string) => l.includes("feature"));
    expect(hasLabel).toBe(false);
  });

  it("compact mode still shows agent activity without worktree label", () => {
    const agent = makeRunningAgent("a1", "builder", "feature");
    activity.set("a1", makeActivity("a1"));
    manager.listAgents = () => [agent];

    const lines = renderWidgetLines(widget);
    expect(lines.some((l: string) => l.includes("reading"))).toBe(true);
  });
});
