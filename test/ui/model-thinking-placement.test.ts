/**
 * model-thinking-placement.test.ts — Tests for model/thinking placement setting.
 *
 * Verifies the modelThinkingPlacement setting controls where model/thinking
 * appears in full mode: "1st" (header) or "2nd" (metadata line).
 * Compact mode always shows model/thinking in header.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView } from "../../src/spawn/spawn-coordinator.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";

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
      worktreeLabel: undefined,
      outputFile: undefined,
      invocation: { modelName: "haiku", thinkingLevel: "medium" },
    },
    lifecycle: {
      status: "running",
      startedAt: Date.now() - 60000,
    },
    execution: { session: { model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" } },
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
      worktreeLabel: undefined,
      outputFile: undefined,
      invocation: { modelName: "haiku", thinkingLevel: "medium" },
    },
    lifecycle: {
      status: "completed",
      startedAt: Date.now() - 120000,
      completedAt: Date.now() - 60000,
    },
    execution: { session: { model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" } },
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

describe("modelThinkingPlacement setting", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("full mode with placement = '2nd'", () => {
    beforeEach(() => {
      widget.setCompactMode(false);
      // Placement is set explicitly; the built-in default is now '1st' (header)
      widget.setModelThinkingPlacement("metadata");
    });

    it("places model/thinking on continuation line for running agents", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header should NOT contain model/thinking tag
      expect(lines[1]).not.toContain("(haiku • medium)");
      // Continuation line should contain model/thinking
      expect(lines[2]).toContain("haiku • medium");
    });

    it("places model/thinking on continuation line for finished agents", () => {
      const agent = makeFinishedAgent("a1");
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header should NOT contain model/thinking tag
      expect(lines[1]).not.toContain("(haiku • medium)");
      // Continuation line should contain model/thinking
      expect(lines[2]).toContain("haiku • medium");
    });
  });

  describe("full mode with placement = '1st'", () => {
    beforeEach(() => {
      widget.setCompactMode(false);
      widget.setModelThinkingPlacement("header");
    });

    it("places model/thinking in header for running agents", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header SHOULD contain model/thinking tag
      expect(lines[1]).toContain("(haiku • medium)");
      // Continuation line should NOT contain model/thinking
      expect(lines[2]).not.toContain("haiku • medium");
    });

    it("places model/thinking in header for finished agents", () => {
      const agent = makeFinishedAgent("a1");
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header SHOULD contain model/thinking tag
      expect(lines[1]).toContain("(haiku • medium)");
      // Continuation line should NOT contain model/thinking
      expect(lines[2] ?? "").not.toContain("haiku • medium");
    });
  });

  describe("compact mode", () => {
    beforeEach(() => {
      widget.setForceCompact(true);
    });

    it("always shows model/thinking in header regardless of placement setting", () => {
      // Set placement to "2nd" but compact mode should ignore it
      widget.setModelThinkingPlacement("metadata");

      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header SHOULD contain model/thinking tag (compact mode always does)
      expect(lines[1]).toContain("(haiku • medium)");
    });

    it("shows model/thinking in header with placement = '1st' too", () => {
      widget.setModelThinkingPlacement("header");

      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Header SHOULD contain model/thinking tag
      expect(lines[1]).toContain("(haiku • medium)");
    });
  });

  describe("widget setter", () => {
    it("has setModelThinkingPlacement method", () => {
      expect(typeof widget.setModelThinkingPlacement).toBe("function");
    });

    it("defaults to '1st'", () => {
      // Check via rendering behavior - model/thinking should be in header
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      (manager as any).listAgents = () => [agent];

      const lines = (widget as any).renderWidget(makeMockTUI(), makeMockTheme());

      // Should be in header (default)
      expect(lines[1]).toContain("(haiku • medium)");
      expect(lines[2]).not.toContain("haiku • medium");
    });
  });
});
