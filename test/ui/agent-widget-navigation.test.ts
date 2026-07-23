/**
 * agent-widget-navigation.test.ts — Tests for keyboard navigation in AgentWidget.
 *
 * Covers:
 *   - Navigation state machine (activate, up, down, select, deactivate)
 *   - Roster building (main, finished, running, queued)
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
      widget.markFinished("f1");
      const finished = makeFinishedAgent("f1");
      (manager as any).listAgents = () => [finished, agent];

      widget.navActivate();
      expect(widget.isNavActive()).toBe(true);
      // Index 0 = main, index 1 = first finished agent
      expect(widget.highlightedIndex()).toBe(1);
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
      widget.markFinished("f1");
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [finished, running];

      widget.navActivate(); // highlights index 1 (first finished)
      expect(widget.highlightedIndex()).toBe(1);

      widget.navDown(); // moves to running agent
      expect(widget.highlightedIndex()).toBe(2);
    });

    it("stops at the last agent (no wrap)", () => {
      const finished = makeFinishedAgent("f1");
      widget.markFinished("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate(); // index 1
      widget.navDown(); // should stay at 1 (last item)
      expect(widget.highlightedIndex()).toBe(1);
    });
  });

  describe("navUp", () => {
    it("moves highlight up one position", () => {
      const finished = makeFinishedAgent("f1");
      widget.markFinished("f1");
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [finished, running];

      widget.navActivate();
      widget.navDown(); // index 2 (running)
      expect(widget.highlightedIndex()).toBe(2);

      widget.navUp(); // back to finished
      expect(widget.highlightedIndex()).toBe(1);
    });

    it("deactivates when at index 0 (main)", () => {
      const finished = makeFinishedAgent("f1");
      widget.markFinished("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate(); // index 1
      widget.navUp(); // to index 0 (main)
      widget.navUp(); // past main -> deactivate
      expect(widget.isNavActive()).toBe(false);
    });
  });

  describe("navSelect", () => {
    it("returns null when highlighting main (index 0)", () => {
      widget.navActivate();
      expect(widget.highlightedIndex()).toBe(0);
      expect(widget.navSelect()).toBeNull();
    });

    it("returns the agent record when highlighting an agent", () => {
      const finished = makeFinishedAgent("f1");
      widget.markFinished("f1");
      (manager as any).listAgents = () => [finished];

      widget.navActivate();
      expect(widget.navSelect()).toBe(finished);
    });

    it("returns null when no agent at highlighted index", () => {
      widget.navActivate();
      // No agents, so index 0 = main only
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

  it("includes main at index 0, then finished, running, queued", () => {
    const finished = makeFinishedAgent("f1");
    widget.markFinished("f1");
    const running = makeRunningAgent("r1");
    activity.set("r1", makeActivity("r1"));
    const queued = makeQueuedAgent("q1");
    (manager as any).listAgents = () => [finished, running, queued];

    widget.navActivate();

    // Roster: main(0), finished(1), running(2), queued(3)
    expect(widget.highlightedIndex()).toBe(1); // first agent after main
    widget.navDown(); // running
    expect(widget.highlightedIndex()).toBe(2);
    widget.navDown(); // queued
    expect(widget.highlightedIndex()).toBe(3);
  });

  it("queued agents expand to individual rows during navigation", () => {
    const q1 = makeQueuedAgent("q1");
    const q2 = makeQueuedAgent("q2");
    (manager as any).listAgents = () => [q1, q2];

    widget.navActivate();
    // Roster: main(0), q1(1), q2(2)
    expect(widget.highlightedIndex()).toBe(1);
    widget.navDown();
    expect(widget.highlightedIndex()).toBe(2);
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
    it("renders '>' marker on the highlighted running agent", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];
      widget.navActivate(); // highlights index 1 = the running agent

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // The agent line (after heading) should contain '>'
      const agentLine = lines[1];
      expect(agentLine).toContain(">");
    });

    it("renders '>' marker on the highlighted finished agent", () => {
      const finished = makeFinishedAgent("f1");
      widget.markFinished("f1");
      (manager as any).listAgents = () => [finished];
      widget.navActivate();

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      const agentLine = lines[1];
      expect(agentLine).toContain(">");
    });

    it("does not render '>' marker when navigation is inactive", () => {
      const running = makeRunningAgent("r1");
      activity.set("r1", makeActivity("r1"));
      (manager as any).listAgents = () => [running];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());
      // No '>' marker in agent lines
      const agentLine = lines[1];
      expect(agentLine).not.toContain("> ");
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
