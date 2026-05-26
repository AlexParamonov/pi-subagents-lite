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
import { AgentWidget } from "../src/ui/agent-widget.js";

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

function makeMockManager(agents: any[]): AgentManager {
  return {
    listAgents: () => agents,
    getAgent: () => undefined,
    setConcurrency: () => {},
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
    type,
    status: "running",
    description: `Test agent ${id}`,
    toolUses: 5,
    startedAt: Date.now() - 60000,
    compactionCount: 0,
    lifetimeUsage: { prompt: 1000, completion: 500, cached: 0 },
    turnCount: 3,
    maxTurns: 30,
  };
}

function makeFinishedAgent(id: string, type: string = "builder"): any {
  return {
    id,
    type,
    status: "completed",
    description: `Finished agent ${id}`,
    toolUses: 10,
    startedAt: Date.now() - 120000,
    completedAt: Date.now() - 60000,
    compactionCount: 0,
    lifetimeUsage: { prompt: 2000, completion: 1000, cached: 0 },
    turnCount: 8,
    maxTurns: 30,
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
      agent.outputFile = "/tmp/pi-agent-outputs/test.log";
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
      a1.outputFile = "/tmp/out1.log";
      const a2 = makeRunningAgent("a2");
      a2.outputFile = "/tmp/out2.log";
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
      a1.outputFile = "/tmp/pi-agent-outputs/test.log";
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
      a1.outputFile = "/tmp/out1.log";
      const a2 = makeFinishedAgent("a2");
      a2.outputFile = "/tmp/out2.log";
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
