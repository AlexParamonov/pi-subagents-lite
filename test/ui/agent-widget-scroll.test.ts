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
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/types.js";
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
  visibleWidth: (text: string) => text.length,
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
    lifecycle: { status: "completed", startedAt: Date.now() - 120000, completedAt: Date.now() - 30000 },
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

type RenderedState = {
  visible: string[];
  arrow: string | null;
  overflow: number | null;
  bodyLines: number;
};

/** Render the widget and extract visible agent ids, arrow target, overflow count. */
function renderState(widget: AgentWidget): RenderedState {
  const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
  const body = lines.slice(1); // heading takes line 0
  const visible: string[] = [];
  let arrow: string | null = null;
  for (const line of body) {
    const m = line.match(/agent (f\d+|r\d+|q\d+)/);
    if (!m) continue;
    if (line.includes("→")) arrow = m[1];
    visible.push(m[1]);
  }
  const more = body.find((l: string) => l.includes("more"));
  const overflow = more ? Number(more.match(/\+(\d+) more/)?.[1]) : null;
  return { visible, arrow, overflow, bodyLines: body.length };
}

/* ------------------------------------------------------------------ */
/*  Scroll model tests                                                 */
/* ------------------------------------------------------------------ */

describe("scroll model state", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  // Overflow config (same as the walkthrough tests): 1-line blocks, body = 4
  // lines → 3 visible + overflow line. Without overflow, navDown never scrolls
  // and the anchor-reset assertions would pass even if the reset code were deleted.
  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(5);
  });

  it("scroll anchor resets to 0 on nav activate", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown(); // (4,2): scrolled to bottom window
    widget.navDeactivate();
    widget.navActivate();

    // Re-entry must start at the top window, not the previously scrolled one.
    const state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
  });

  it("scroll anchor resets to 0 on nav deactivate", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown(); // (4,2): scrolled to bottom window

    // Highlight is observable after deactivation via the public query.
    widget.navDeactivate();
    expect(widget.highlightedIndex()).toBe(0);

    // Re-entry must start at the top window, not the previously scrolled one.
    widget.navActivate();
    const state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
  });
});

describe("scroll viewport navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  // Walkthrough config from issue.md: 1-line blocks (compact mode),
  // maxLinesCompact=5 → maxBody=4 → 3 visible blocks + overflow line.
  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(5);
  });

  it("follows the issue walkthrough state by state", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    // States (h, s) with exact windows from issue.md's scroll model contract, read
    // as a continuous press sequence (the diagram's ↑ columns start from (4,2),
    // a second walkthrough; the continuous reading wraps on the first ↑).
    // Overflow counts follow the issue's "3 visible + 2 hidden" roster (5 agents);
    // the diagram's "+1 more" entries at bottom-anchored states are typos
    // (window [2..4] hides 2 agents, not 1).
    // Every scrolled state must stay within the budget: body ≤ 4.
    const steps: Array<{ press: "↓" | "↑"; visible: string[]; arrow: string; overflow: number }> = [
      { press: "↓", visible: ["f0", "f1", "f2"], arrow: "f1", overflow: 2 }, // (1,0)
      { press: "↓", visible: ["f0", "f1", "f2"], arrow: "f2", overflow: 2 }, // (2,0)
      { press: "↓", visible: ["f1", "f2", "f3"], arrow: "f3", overflow: 2 }, // (3,1) scroll
      { press: "↓", visible: ["f2", "f3", "f4"], arrow: "f4", overflow: 2 }, // (4,2) scroll
      { press: "↓", visible: ["f0", "f1", "f2"], arrow: "f0", overflow: 2 }, // (0,0) wrap
      { press: "↑", visible: ["f2", "f3", "f4"], arrow: "f4", overflow: 2 }, // (4,2) wrap from top
      { press: "↑", visible: ["f2", "f3", "f4"], arrow: "f3", overflow: 2 }, // (3,2)
      { press: "↑", visible: ["f2", "f3", "f4"], arrow: "f2", overflow: 2 }, // (2,2)
      { press: "↑", visible: ["f1", "f2", "f3"], arrow: "f1", overflow: 2 }, // (1,1) scroll
      { press: "↑", visible: ["f0", "f1", "f2"], arrow: "f0", overflow: 2 }, // (0,0) scroll
    ];

    widget.navActivate();
    expect(renderState(widget)).toEqual({
      visible: ["f0", "f1", "f2"],
      arrow: "f0",
      overflow: 2,
      bodyLines: 4,
    });

    for (const step of steps) {
      if (step.press === "↓") widget.navDown();
      else widget.navUp();
      const state = renderState(widget);
      expect(state.visible).toEqual(step.visible);
      expect(state.arrow).toBe(step.arrow);
      expect(state.overflow).toBe(step.overflow);
      // Budget invariant: widget never renders more than maxBody body lines.
      expect(state.bodyLines).toBeLessThanOrEqual(4);
    }
  });

  it("arrow moves freely within the visible window without scrolling", () => {
    const agents = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // (0,0): f0 f1 f2, everything fits
    let state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
    expect(state.overflow).toBeNull();

    widget.navDown(); // (1,0): arrow moves, visible set unchanged
    state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f1");

    widget.navDown(); // (2,0)
    state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f2");
  });

  it("at bottom edge with collapsed agents below, ↓ scrolls up with arrow pinned to bottom", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // (0,0): f0 f1 f2 +3 more
    widget.navDown(); // (1,0)
    widget.navDown(); // (2,0)
    widget.navDown(); // (3,1): f1 f2 f3 +3 more

    let state = renderState(widget);
    expect(state.visible).toEqual(["f1", "f2", "f3"]);
    expect(state.arrow).toBe("f3");
    expect(state.overflow).toBe(3);

    // ↓ at the bottom edge scrolls: f0 leaves the window, arrow pins to bottom row.
    widget.navDown(); // (4,2): f2 f3 f4 +3 more
    state = renderState(widget);
    expect(state.visible).toEqual(["f2", "f3", "f4"]);
    expect(state.arrow).toBe("f4");
    expect(state.overflow).toBe(3);
    expect(state.bodyLines).toBeLessThanOrEqual(4);
  });

  it("at top edge with collapsed agents above, ↑ scrolls down with arrow pinned to top", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // (0,0)
    widget.navDown(); // (1,0)
    widget.navDown(); // (2,0)
    widget.navDown(); // (3,1)
    widget.navDown(); // (4,2): f2 f3 f4 +3 more
    widget.navUp(); // (3,2)
    widget.navUp(); // (2,2)
    widget.navUp(); // (1,1): f1 f2 f3 +3 more, arrow on f1 (top row)

    let state = renderState(widget);
    expect(state.visible).toEqual(["f1", "f2", "f3"]);
    expect(state.arrow).toBe("f1");

    // ↑ at the top edge scrolls: window returns to the top, arrow pins to top row.
    widget.navUp(); // (0,0): f0 f1 f2 +3 more
    state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
    expect(state.overflow).toBe(3);
    expect(state.bodyLines).toBeLessThanOrEqual(4);
  });

  it("↓ at last agent wraps to first with window reset to top", () => {
    const agents = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // (0,0)
    widget.navDown(); // (1,0)
    widget.navDown(); // (2,0): arrow on last agent
    let state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f2");

    widget.navDown(); // wrap → (0,0)
    state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
  });

  it("↑ at first agent wraps to last with window anchored at bottom", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // (0,0)
    widget.navUp(); // wrap → (5,3): f3 f4 f5 +3 more, arrow pinned to bottom row
    const state = renderState(widget);
    expect(state.visible).toEqual(["f3", "f4", "f5"]);
    expect(state.arrow).toBe("f5");
    expect(state.overflow).toBe(3);
    expect(state.bodyLines).toBeLessThanOrEqual(4);
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
    widget.setMaxLinesCompact(5); // body = 4 lines, 4 agents fit
  });

  it("shows '+N more' without category breakdown", () => {
    const agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    const overflowLine = lines.find((l: string) => l.includes("more"));
    expect(overflowLine).toBeDefined();
    // Should be "+3 more" (6 agents, 3 visible) — not "+3 more (3 finished)"
    expect(overflowLine).toContain("+3 more");

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

    // r0, r1, and the 3 queued agents are hidden: 5 agents total.
    const overflowLine = lines.find((l: string) => l.includes("more"));
    expect(overflowLine).toContain("+5 more");
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
    // Full mode: a running block is 2 lines (header + activity).
    widget.setMaxLines(2); // maxBody = 1 — a single running block exceeds it
  });

  it("keeps the highlighted agent visible even when its block exceeds the budget", () => {
    const agents = [makeRunningAgent("r0"), makeRunningAgent("r1")];
    (manager as any).listAgents = () => agents;

    widget.navActivate(); // h=0: r0 (2 lines) does not fit the 1-line budget
    let state = renderState(widget);
    expect(state.visible).toEqual(["r0"]);
    expect(state.arrow).toBe("r0");

    widget.navDown(); // h=1, s=1: window moves so r1 is visible
    state = renderState(widget);
    expect(state.visible).toEqual(["r1"]);
    expect(state.arrow).toBe("r1");
  });
});

describe("roster changes during navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;
  let agents: any[];

  // Overflow config so the window actually scrolls before the roster shrinks/grows.
  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(5); // body = 4 lines → 3 visible + overflow

    agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`f${i}`));
  });

  it("renders a valid window right after shrink while navigating (no keypress needed)", () => {
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown(); // (4,2): [f2,f3,f4]
    expect(renderState(widget).visible).toEqual(["f2", "f3", "f4"]);

    // Turn-based eviction: the 80 ms refresh renders without any nav move.
    (manager as any).listAgents = () => agents.slice(0, 3);

    // Clamp on shrink: h=4 → 2, s stays 2 (≤ h). Window [f2], arrow visible.
    const state = renderState(widget);
    expect(state.visible).toEqual(["f2"]);
    expect(state.arrow).toBe("f2");
    expect(state.overflow).toBe(2);

    // Next move works from the clamped state: (2,2) ↓ wraps to the top.
    widget.navDown();
    const after = renderState(widget);
    expect(after.visible).toEqual(["f0", "f1", "f2"]);
    expect(after.arrow).toBe("f0");
  });

  it("keeps index positions on growth (no auto-follow)", () => {
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown(); // (4,2): scrolled to the bottom

    // Grow the roster (new spawn) — arrow and window keep their index positions.
    const grown = Array.from({ length: 3 }, (_, i) => makeFinishedAgent(`g${i}`));
    (manager as any).listAgents = () => [...agents, ...grown];

    expect(widget.highlightedIndex()).toBe(4);
    const state = renderState(widget);
    expect(state.visible).toEqual(["f2", "f3", "f4"]);
    expect(state.arrow).toBe("f4");
  });

  it("clamps to last remaining agent when the highlighted agent is evicted", () => {
    agents = Array.from({ length: 6 }, (_, i) => makeFinishedAgent(`f${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 5; i++) widget.navDown(); // (5,3): [f3,f4,f5], arrow on f5

    // Evict f3..f5 including the highlighted agent.
    (manager as any).listAgents = () => agents.slice(0, 3);

    // Clamp happens on the next nav move — highlight clamps to last remaining (f2),
    // then ↓ wraps from the end to the start.
    widget.navDown();
    expect(widget.highlightedIndex()).toBe(0);
    const state = renderState(widget);
    expect(state.visible).toEqual(["f0", "f1", "f2"]);
    expect(state.arrow).toBe("f0");
  });
});

describe("queued agents during navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
    widget.setCompactMode(true);
    widget.setWidgetShortcut(true);
    widget.setMaxLinesCompact(5); // body = 4 lines → 3 visible + overflow
  });

  it("expands queued agents to individual rows that participate in the window", () => {
    const finished = Array.from({ length: 4 }, (_, i) => makeFinishedAgent(`f${i}`));
    const running = [makeRunningAgent("r0")];
    const queued = Array.from({ length: 3 }, (_, i) => makeQueuedAgent(`q${i}`));
    (manager as any).listAgents = () => [...finished, ...running, ...queued];

    widget.navActivate(); // (0,0): [f0,f1,f2], +5 more
    widget.navDown(); // (1,0)
    widget.navDown(); // (2,0)
    widget.navDown(); // (3,1): [f1,f2,f3]
    widget.navDown(); // (4,2): [f2,f3,r0]
    let state = renderState(widget);
    expect(state.visible).toEqual(["f2", "f3", "r0"]);
    expect(state.arrow).toBe("r0");
    expect(state.overflow).toBe(5);

    // Queued agents are individual 1-line rows in the window, not one aggregated block.
    widget.navDown(); // (5,3): [f3,r0,q0]
    state = renderState(widget);
    expect(state.visible).toEqual(["f3", "r0", "q0"]);
    expect(state.arrow).toBe("q0");

    widget.navDown(); // (6,4): [r0,q0,q1]
    widget.navDown(); // (7,5): [q0,q1,q2]
    state = renderState(widget);
    expect(state.visible).toEqual(["q0", "q1", "q2"]);
    expect(state.arrow).toBe("q2");
    expect(state.overflow).toBe(5); // 8 agents, 3 visible

    // No aggregated "N queued" block anywhere.
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => /\d+ queued/.test(l))).toBe(false);
  });
});
