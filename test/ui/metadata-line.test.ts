/**
 * metadata-line.test.ts — Tests for metadata line assembly.
 *
 * Verifies that model + thinking metadata appears on the metadata line
 * in full mode when placement is 'metadata', and stays in the header
 * in compact mode or when placement is 'header'.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView, AgentRecord } from "../../src/types.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { makeMockManager, renderWidgetLines } from "./widget-helpers.js";
import { asAgentSession } from "../pi-boundaries.js";

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

function makeRunningAgent(id: string, type: string = "builder"): AgentRecord {
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
      started: true,
    },
    execution: {
      settled: false,
      settlementCount: 0,
      session: asAgentSession({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" }),
    },
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
  };
}

function makeFinishedAgent(id: string, type: string = "builder"): AgentRecord {
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
      completedAt: Date.now() - 30000,
      started: true,
    },
    execution: {
      settled: false,
      settlementCount: 0,
      session: asAgentSession({ model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" }),
    },
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

describe("metadata line assembly", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("full mode", () => {
    beforeEach(() => {
      widget.setCompactMode(false);
      widget.setModelThinkingPlacement("metadata");
    });

    it("moves model + thinking from header to metadata line for running agents", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Header should NOT contain model/thinking tag
      expect(lines[1]).not.toContain("(haiku • medium)");
      // Metadata line should contain model/thinking in bare format (no parentheses)
      expect(lines[2]).toContain("haiku • medium");
    });

    it("moves model + thinking from header to metadata line for finished agents", () => {
      const agent = makeFinishedAgent("a1");
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Header should NOT contain model/thinking tag
      expect(lines[1]).not.toContain("(haiku • medium)");
      // Metadata line should contain model/thinking in bare format
      expect(lines[2]).toContain("haiku • medium");
    });

    it("metadata line uses bare format (no parentheses) for model + thinking", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Should NOT have parentheses around model/thinking
      expect(lines[2]).not.toContain("(haiku");
      expect(lines[2]).toContain("haiku • medium");
    });

    it("metadata line combines worktree, model/thinking, and outputFile", () => {
      const agent = makeRunningAgent("a1");
      agent.display.worktreeLabel = "my-feature";
      agent.display.outputFile = "/tmp/test.log";
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Metadata line should have worktree, model/thinking, and outputFile
      expect(lines[2]).toContain("@my-feature");
      expect(lines[2]).toContain("haiku • medium");
      expect(lines[2]).toContain("tail -f /tmp/test.log");
    });
  });

  describe("compact mode", () => {
    beforeEach(() => {
      widget.setForceCompact(true);
    });

    it("keeps model + thinking in header for running agents", () => {
      const agent = makeRunningAgent("a1");
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Header SHOULD contain model/thinking tag (compact mode unchanged)
      expect(lines[1]).toContain("(haiku • medium)");
    });

    it("keeps model + thinking in header for finished agents", () => {
      const agent = makeFinishedAgent("a1");
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Header SHOULD contain model/thinking tag (compact mode unchanged)
      expect(lines[1]).toContain("(haiku • medium)");
    });
  });

  describe("nav-height consistency", () => {
    beforeEach(() => {
      widget.setCompactMode(false);
      widget.setModelThinkingPlacement("metadata");
    });

    it("renders a running agent with model but no worktree/outputFile as a 3-line block", () => {
      const agent = makeRunningAgent("a1");
      // Ensure no worktree/outputFile - model/thinking should still produce metadata line
      agent.display.worktreeLabel = undefined;
      agent.display.outputFile = undefined;
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);
      // heading (1) + header (1) + metadata line (1) + activity (1)
      expect(lines.length - 1).toBe(3);
      // Verify the metadata line contains model info
      expect(lines[2]).toContain("haiku");
    });

    it("renders a finished agent with model but no worktree/outputFile as a 2-line block", () => {
      const agent = makeFinishedAgent("a1");
      // Ensure no worktree/outputFile
      agent.display.worktreeLabel = undefined;
      agent.display.outputFile = undefined;
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);
      // heading (1) + header (1) + metadata line (1)
      expect(lines.length - 1).toBe(2);
      // Verify the metadata line contains model info
      expect(lines[2]).toContain("haiku");
    });

    it("renders a compact-mode agent as a 1-line block regardless of model", () => {
      widget.setForceCompact(true);
      const agent = makeRunningAgent("a1");
      agent.display.worktreeLabel = undefined;
      agent.display.outputFile = undefined;
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);
      expect(lines.length - 1).toBe(1);
    });

    it("renders a running agent with worktree but no model as a 3-line block", () => {
      const agent = makeRunningAgent("a1");
      // Remove model/thinking
      agent.execution.session = undefined;
      agent.display.invocation = undefined;
      // Add worktree
      agent.display.worktreeLabel = "my-feature";
      agent.display.outputFile = undefined;
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);
      // heading + header + metadata (worktree) + activity
      expect(lines.length - 1).toBe(3);
    });
  });
});
