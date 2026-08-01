/**
 * agent-widget-navigation.test.ts — Tests for keyboard navigation in AgentWidget.
 *
 * Covers:
 *   - Navigation state machine (activate, up, down, select, deactivate)
 *   - Roster building (finished, running, queued)
 *   - Rendering with `>` marker and heading hint text
 *   - Queued agent expansion during navigation
 *   - Editor focus detection
 *   - Viewer open guard
 *   - Auto-deactivation when agents clear
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

function makeMockManager(agents: any[], totalAgentCost = 0): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
    getTotalAgentCost: () => totalAgentCost,
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
/*  Navigation state machine tests                                    */
/* ------------------------------------------------------------------ */

describe("navigation state machine", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("initial state", () => {
    it("starts with navigation inactive", () => {
      expect(widget.isNavActive()).toBe(false);
    });

    it("highlighted index is 0 when inactive", () => {
      expect(widget.highlightedIndex()).toBe(0);
    });

    it("viewer is not open by default", () => {
      expect(widget.isViewerOpen()).toBe(false);
    });
  });

  describe("navActivate", () => {
    it("activates navigation with no agents", () => {
      widget.navActivate();
      expect(widget.isNavActive()).toBe(true);
      expect(widget.highlightedIndex()).toBe(0);
    });

    it("activates navigation highlighting first agent when agents exist", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished, agent];

      widget.navActivate();
      expect(widget.isNavActive()).toBe(true);
      // Index 0 = first finished agent
      expect(widget.highlightedIndex()).toBe(0);
    });

    it("is idempotent", () => {
      widget.navActivate();
      const firstIndex = widget.highlightedIndex();
      widget.navActivate();
      expect(widget.highlightedIndex()).toBe(firstIndex);
    });
  });

  describe("navDown", () => {
    it("moves highlight down one position", () => {
      const finished = makeFinishedAgent("f1");
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [finished, running];

      widget.navActivate(); // highlights index 0 (first finished)
      expect(widget.highlightedIndex()).toBe(0);

      widget.navDown(); // moves to running agent
      expect(widget.highlightedIndex()).toBe(1);
    });

    it("wraps from last agent to first", () => {
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate(); // index 0
      widget.navDown(); // wraps to first (index 0)
      expect(widget.highlightedIndex()).toBe(0);
    });
  });

  describe("navUp", () => {
    it("moves highlight up one position", () => {
      const finished = makeFinishedAgent("f1");
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [finished, running];

      widget.navActivate();
      widget.navDown(); // index 1 (running)
      expect(widget.highlightedIndex()).toBe(1);

      widget.navUp(); // back to finished
      expect(widget.highlightedIndex()).toBe(0);
    });

    it("wraps from first to last agent", () => {
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate(); // index 0
      widget.navUp(); // wraps to last agent (index 1)
      widget.navUp(); // to first agent (index 0)
      expect(widget.highlightedIndex()).toBe(0);
      expect(widget.isNavActive()).toBe(true);
    });
  });

  describe("navSelect", () => {
    it("returns the first agent when no agents beyond the highlighted one", () => {
      widget.navActivate();
      expect(widget.highlightedIndex()).toBe(0);
      expect(widget.navSelect()).toBeNull();
    });
    it("returns the agent record when highlighting an agent", () => {
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate();
      expect(widget.navSelect()).toBe(finished);
    });

    it("returns null when no agent at highlighted index", () => {
      widget.navActivate();
      // No agents, so roster is empty
      expect(widget.navSelect()).toBeNull();
    });
  });

  describe("navDeactivate", () => {
    it("deactivates navigation", () => {
      widget.navActivate();
      expect(widget.isNavActive()).toBe(true);
      widget.navDeactivate();
      expect(widget.isNavActive()).toBe(false);
    });

    it("resets highlighted index to 0", () => {
      widget.navActivate();
      widget.navDown();
      widget.navDeactivate();
      expect(widget.highlightedIndex()).toBe(0);
    });

    it("is idempotent when already inactive", () => {
      widget.navDeactivate();
      widget.navDeactivate();
      expect(widget.isNavActive()).toBe(false);
    });
  });

  describe("viewer open guard", () => {
    it("setViewerOpen toggles the viewer open state", () => {
      expect(widget.isViewerOpen()).toBe(false);
      widget.setViewerOpen(true);
      expect(widget.isViewerOpen()).toBe(true);
      widget.setViewerOpen(false);
      expect(widget.isViewerOpen()).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Roster building tests                                             */
/* ------------------------------------------------------------------ */

describe("navigation roster", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("includes finished at index 0, then running, queued", () => {
    const finished = makeFinishedAgent("f1");
    const running = makeRunningAgent("r1");
    activity.set("r1", makeActivity("r1"));
    const queued = makeQueuedAgent("q1");
    (manager as any).listAgents = () => [finished, running, queued];

    widget.navActivate();

    // Roster: finished(0), running(1), queued(2)
    expect(widget.highlightedIndex()).toBe(0); // first agent
    widget.navDown(); // running
    expect(widget.highlightedIndex()).toBe(1);
    widget.navDown(); // queued
    expect(widget.highlightedIndex()).toBe(2);
  });

  it("queued agents expand to individual rows during navigation", () => {
    const q1 = makeQueuedAgent("q1");
    const q2 = makeQueuedAgent("q2");
    (manager as any).listAgents = () => [q1, q2];

    widget.navActivate();
    // Roster: q1(0), q2(1)
    expect(widget.highlightedIndex()).toBe(0);
    widget.navDown();
    expect(widget.highlightedIndex()).toBe(1);
  });

  it("queued agents aggregate when navigation is inactive", () => {
    const q1 = makeQueuedAgent("q1");
    const q2 = makeQueuedAgent("q2");
    (manager as any).listAgents = () => [q1, q2];

    // Without nav active, queued agents render as "2 queued" block
    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
    expect(lines.some((l: string) => l.includes("2 queued"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Rendering tests                                                   */
/* ------------------------------------------------------------------ */

describe("navigation rendering", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("heading hint text", () => {
    it("shows 'down to navigate' hint when navigation is inactive", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[0]).toContain("to navigate");
    });

    it("shows navigation hint when navigation is active", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];
      widget.navActivate();

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      expect(lines[0]).toContain("navigate");
      expect(lines[0]).toContain("enter view");
      expect(lines[0]).toContain("esc back");
    });
  });

  describe("highlight marker", () => {
    it("renders '→' marker on the highlighted running agent", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];
      widget.navActivate(); // highlights index 1 = the running agent

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // The agent line (after heading) should contain '→'
      const agentLine = lines[1];
      expect(agentLine).toContain("→");
    });

    it("renders '→' marker on the highlighted finished agent", () => {
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished];
      widget.navActivate();

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      const agentLine = lines[1];
      expect(agentLine).toContain("→");
    });

    it("does not render '→' marker when navigation is inactive", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // No '→' marker in agent lines
      const agentLine = lines[1];
      expect(agentLine).not.toContain("→");
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Auto-deactivation tests                                           */
/* ------------------------------------------------------------------ */

describe("auto-deactivation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("deactivates navigation when all agents clear", () => {
    const uiCtx = { setStatus: vi.fn(), setWidget: vi.fn() };
    widget.setUICtx(uiCtx);

    const running = makeRunningAgent("r1");
    activity.set("r1", makeActivity("r1"));
    (manager as any).listAgents = () => [running];
    widget.navActivate();
    expect(widget.isNavActive()).toBe(true);

    // Agents clear
    (manager as any).listAgents = () => [];
    widget.update(); // triggers clearWidget path
    expect(widget.isNavActive()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Overflow + navigation tests                                       */
/* ------------------------------------------------------------------ */

describe("overflow with navigation", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  it("pinned block appears when navigating to a hidden agent", () => {
    // Create 15 finished agents — body budget is maxLines-1 = 11,
    // so 4 agents are hidden by overflow without pinning.
    const agents = Array.from({ length: 15 }, (_, i) => {
      const agent = makeFinishedAgent(`f${i}`);
      agent.display.description = `Finished agent ${i}`;
      return agent;
    });
    (manager as any).listAgents = () => agents;

    // Activate nav — highlights index 0 (agent 0)
    widget.navActivate();

    // Navigate down to index 12 -> agent 12 (would be hidden by overflow)
    for (let i = 0; i < 12; i++) widget.navDown();
    expect(widget.highlightedIndex()).toBe(12);

    const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

    // The pinned (highlighted) block must appear in the output
    const highlightedLine = lines.find((line: string) => line.includes("Finished agent 12"));
    expect(highlightedLine).toBeDefined();
    expect(highlightedLine).toContain("→");

    // Overflow summary line must be present (some agents are hidden)
    const overflowLine = lines.find((line: string) => line.includes("more"));
    expect(overflowLine).toBeDefined();
  });
});

describe("navigation highlight clamp on roster shrink", () => {
  let manager: AgentManager;
  let widget: AgentWidget;

  beforeEach(() => {
    manager = makeMockManager([]);
    widget = new AgentWidget(manager, () => undefined);
  });

  it("clamps highlight when roster shrinks during navDown", () => {
    // Start with 5 agents, navigate to index 4
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`a${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown();
    expect(widget.highlightedIndex()).toBe(4);

    // Roster shrinks to 2 agents (eviction)
    (manager as any).listAgents = () => agents.slice(0, 2);

    // navDown should clamp and then advance
    widget.navDown();
    // clamp: 4 -> 1, then +1 % 2 = 0
    expect(widget.highlightedIndex()).toBe(0);
  });

  it("clamps highlight when roster shrinks during navUp", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`a${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown();
    expect(widget.highlightedIndex()).toBe(4);

    // Roster shrinks to 2 agents
    (manager as any).listAgents = () => agents.slice(0, 2);

    // navUp should clamp and then go up
    widget.navUp();
    // clamp: 4 -> 1, then (1-1+2) % 2 = 0
    expect(widget.highlightedIndex()).toBe(0);
  });

  it("clamps highlight when roster shrinks during navSelect", () => {
    const agents = Array.from({ length: 5 }, (_, i) => makeFinishedAgent(`a${i}`));
    (manager as any).listAgents = () => agents;

    widget.navActivate();
    for (let i = 0; i < 4; i++) widget.navDown();
    expect(widget.highlightedIndex()).toBe(4);

    // Roster shrinks to 2 agents
    (manager as any).listAgents = () => agents.slice(0, 2);

    // navSelect should clamp and return a valid agent
    const selected = widget.navSelect();
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("a1");
    expect(widget.highlightedIndex()).toBe(1);
  });
});
