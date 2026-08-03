/**
 * agent-widget-scroll.test.ts — Tests for scroll-viewport navigation.
 *
 * Verifies the new scroll model:
 *   - State (h, s): highlighted roster index, scroll anchor
 *   - Window shows contiguous blocks [s..e] fitting the budget
 *   - Arrow moves freely within window; at edges, scrolls with arrow pinned
 *   - Wrap at list ends
 *   - Overflow line shows "+N more"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

function makeRunningAgent(id: string, type: string = "builder"): any {
  return {
    id,
    display: { type, description: `Running agent ${id}` },
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

function makeFinishedAgent(id: string, type: string = "builder"): any {
  return {
    id,
    display: { type, description: `Finished agent ${id}` },
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

function makeQueuedAgent(id: string, type: string = "builder"): any {
  return {
    id,
    display: { type, description: `Queued agent ${id}` },
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

function makeActivity(agentId: string): LiveView {
  return { activeTools: new Map([["read", "reading"]]), responseText: "" };
}

/* ------------------------------------------------------------------ */
/*  Scroll model tests                                                 */
/* ------------------------------------------------------------------ */

describe("scroll model state", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("scroll anchor resets to 0 on nav activate", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    // Scroll anchor should be 0 (start of roster)
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // First agent should be visible (scroll anchor = 0)
    expect(lines.some((l: string) => l.includes("Finished agent f0"))).toBe(true);
  });

  it("scroll anchor resets to 0 on nav deactivate", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    // Navigate down to change scroll anchor
    widget.navDown();
    widget.navDeactivate();

    // Reactivate - scroll anchor should be reset
    widget.navActivate();
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => l.includes("Finished agent f0"))).toBe(true);
  });
});

describe("scroll viewport navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  // Create 6 agents with 1-line blocks (compact mode)
  // With maxLines=12, body = 11 lines, so 5 agents fit (6th overflows)
  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLines(12); // body = 11 lines, 11 agents fit
  });

  it("arrow moves freely within visible window without scrolling", () => {
    const agents = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0

    // All 3 agents should be visible
    let lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => l.includes("Finished agent f0"))).toBe(true);
    expect(lines.some((l: string) => l.includes("Finished agent f1"))).toBe(true);
    expect(lines.some((l: string) => l.includes("Finished agent f2"))).toBe(true);

    // Navigate down - should not scroll with only 3 agents
    widget.navDown(); // h=1, s=0
    lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // All still visible, arrow on f1
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f1"))).toBe(true);
  });

  it("at bottom edge with collapsed agents below, ↓ scrolls up with arrow pinned to bottom", () => {
    // 6 agents, compact mode = 1 line each, body = 11 lines
    // So 11 agents fit without overflow - need to limit body
    widget.setMaxLines(5); // body = 4 lines, 4 agents fit

    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0, shows f0-f3

    // Navigate to bottom visible agent (index 3)
    widget.navDown(); // h=1
    widget.navDown(); // h=2
    widget.navDown(); // h=3 (bottom edge)

    let lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // f0, f1, f2, f3 visible, f4 and f5 hidden
    expect(lines.some((l: string) => l.includes("f3"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f4"))).toBe(false);

    // Press ↓ - should scroll, arrow stays on bottom row (now f4)
    widget.navDown(); // h=4, s=1 (scrolls)

    lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Now f1, f2, f3, f4 visible, f5 hidden
    expect(lines.some((l: string) => l.includes("f1"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f4"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f5"))).toBe(false);
    // Arrow should be on f4 (bottom row)
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f4"))).toBe(true);
  });

  it("at top edge with collapsed agents above, ↑ scrolls down with arrow pinned to top", () => {
    widget.setMaxLines(5); // body = 4 lines

    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0

    // Navigate down to scroll (h=4, s=1 - showing f1-f4)
    widget.navDown(); // h=1
    widget.navDown(); // h=2
    widget.navDown(); // h=3
    widget.navDown(); // h=4, s=1

    // Navigate up to top edge (h=1, s=1 - showing f1-f4, arrow on f1)
    widget.navUp(); // h=3
    widget.navUp(); // h=2
    widget.navUp(); // h=1 (top edge, s=1)

    // Press ↑ - should scroll down, arrow stays on top row (now f0)
    widget.navUp(); // h=0, s=0 (scrolls back to top)

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Now f0, f1, f2, f3 visible
    expect(lines.some((l: string) => l.includes("f0"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f1"))).toBe(true);
    // Arrow should be on f0 (top row)
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f0"))).toBe(true);
  });

  it("↓ at last agent wraps to first with window reset to top", () => {
    const agents = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0
    widget.navDown(); // h=1
    widget.navDown(); // h=2 (last agent)

    // Press ↓ - should wrap to first
    widget.navDown(); // h=0, s=0

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Window reset to top
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f0"))).toBe(true);
  });

  it("↑ at first agent wraps to last with window anchored at bottom", () => {
    widget.setMaxLines(5); // body = 4 lines

    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0

    // Press ↑ - should wrap to last, window at bottom
    widget.navUp(); // h=5, s=2 (bottomScrollStart)

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // Window should show f2, f3, f4, f5 (last 4 agents)
    expect(lines.some((l: string) => l.includes("f5"))).toBe(true);
    // Arrow should be on f5 (last agent)
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f5"))).toBe(true);
  });
});

describe("overflow line format", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLines(5); // body = 4 lines, 4 agents fit
  });

  it("shows '+N more' without category breakdown", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const overflowLine = lines.find((l: string) => l.includes("more"));
    expect(overflowLine).toBeDefined();
    // Should be "+2 more" not "+2 more (2 finished)"
    expect(overflowLine).toContain("+2 more");
    expect(overflowLine).not.toContain("finished");
    expect(overflowLine).not.toContain("running");
    expect(overflowLine).not.toContain("queued");
  });
});

describe("non-navigation overflow", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(5); // body = 4 lines, 4 agents fit
  });

  it("shows top of roster and collapses from bottom", () => {
    // Roster order: finished → running → queued
    const finished = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`f${i}`));
    const running = Array.from({ length: 2 }, (_, i) => makeRunningAgent(`r${i}`));
    const queued = Array.from({ length: 3 }, (_, i) => makeQueuedAgent(`q${i}`));

    (manager as any).listAgents = () => [...finished, ...running, ...queued];

    // Not in nav mode
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    // Should show first 3 agents (f0, f1, f2) and collapse the rest
    // With budget=3 (maxBody-1), 3 blocks fit: f0, f1, f2
    expect(lines.some((l: string) => l.includes("f0"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f1"))).toBe(true);
    expect(lines.some((l: string) => l.includes("f2"))).toBe(true);

    // r0, r1, and queued block should be collapsed
    expect(lines.some((l: string) => l.includes("r0"))).toBe(false);
    expect(lines.some((l: string) => l.includes("r1"))).toBe(false);

    // Overflow line should show "+3 more" (r0, r1, queued block = 3 blocks hidden)
    const overflowLine = lines.find((l: string) => l.includes("more"));
    expect(overflowLine).toContain("+3 more");
  });
});

describe("highlighted agent always visible", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLines(5); // body = 4 lines
  });

  it("keeps highlighted agent visible even when it alone exceeds budget", () => {
    // This test case is for when a single block exceeds the window budget
    // In compact mode, all blocks are 1 line, so this won't happen
    // But we should test that the highlighted agent is always in the window
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0

    // Navigate to agent 5 (would be hidden)
    for (let i = 0; i < 5; i++) {
      widget.navDown();
    }
    // h=5, should force scroll to show f5

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    // f5 should be visible (highlighted)
    expect(lines.some((l: string) => l.includes("f5"))).toBe(true);
    expect(lines.filter((l: string) => l.includes("→")).some((l: string) => l.includes("f5"))).toBe(true);
  });
});

describe("roster changes during navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;
  let agents: any[];

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLines(12); // body = 11, plenty of room

    agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
  });

  it("clamps highlight and scroll anchor on shrink", () => {
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0
    widget.navDown(); // h=1
    widget.navDown(); // h=2
    widget.navDown(); // h=3

    // Shrink roster to 2 agents
    (manager as any).listAgents = () => agents.slice(0, 2);

    // Next nav move should clamp and work
    widget.navDown(); // Should clamp h to 1, then wrap or move

    expect(widget.highlightedIndex()).toBeLessThan(2);
    expect(widget.highlightedIndex()).toBeGreaterThanOrEqual(0);
  });

  it("keeps index positions on growth (no auto-follow)", () => {
    (manager as any).listAgents = () => agents.slice(0, 3);

    widget.navActivate(); // h=0, s=0
    widget.navDown(); // h=1

    // Grow roster
    (manager as any).listAgents = () => agents;

    // Arrow should stay at index 1 (no auto-follow)
    expect(widget.highlightedIndex()).toBe(1);
  });

  it("clamps to last remaining agent when highlighted agent is evicted", () => {
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0, s=0
    widget.navDown(); // h=1
    widget.navDown(); // h=2
    widget.navDown(); // h=3
    widget.navDown(); // h=4

    // Evict agents f2, f3, f4 - highlighted agent (f4) is evicted
    (manager as any).listAgents = () => agents.slice(0, 2);

    // Clamp happens on next nav move - highlight clamps to last remaining (f1 = index 1)
    // Then navDown wraps from end to start
    widget.navDown(); // clamps h to 1, then wraps to 0

    expect(widget.highlightedIndex()).toBe(0);
  });
});
