/**
 * model-thinking-placement.test.ts — Tests for model/thinking placement setting.
 *
 * Verifies the modelThinkingPlacement setting controls where model/thinking
 * appears in full mode: "header" or "metadata" (the metadata line).
 * Compact mode always shows model/thinking in header.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { agentConfigMock } from "../agent-types-mock.js";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import type { LiveView, AgentRecord } from "../../src/types.js";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import {
  makeMockManager,
  renderWidgetLines,
  makeRunningAgent,
  makeFinishedAgent,
  makeActivity,
} from "./widget-helpers.js";

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

const MODEL_THINKING_OPTS = {
  invocation: { modelName: "haiku", thinkingLevel: "medium" as const },
  withSession: true,
};

describe("modelThinkingPlacement setting", () => {
  let widget: AgentWidget;
  let manager: AgentManager;
  let activity: Map<string, LiveView>;

  beforeEach(() => {
    manager = makeMockManager([]);
    activity = new Map();
    widget = new AgentWidget(manager, (id) => activity.get(id));
  });

  describe("full mode with placement = 'header'", () => {
    beforeEach(() => {
      widget.setCompactMode(false);
      widget.setModelThinkingPlacement("header");
    });

    it("places model/thinking in header for running agents", () => {
      const agent = makeRunningAgent("a1", MODEL_THINKING_OPTS);
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      expect(lines[1]).toContain("(haiku • medium)");
      expect(lines[2]).not.toContain("haiku • medium");
    });

    it("places model/thinking in header for finished agents", () => {
      const agent = makeFinishedAgent("a1", MODEL_THINKING_OPTS);
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      expect(lines[1]).toContain("(haiku • medium)");
      expect(lines[2] ?? "").not.toContain("haiku • medium");
    });
  });

  describe("compact mode", () => {
    beforeEach(() => {
      widget.setForceCompact(true);
    });

    it("always shows model/thinking in header regardless of placement setting", () => {
      // Set placement to "metadata" but compact mode should ignore it
      widget.setModelThinkingPlacement("metadata");

      const agent = makeRunningAgent("a1", MODEL_THINKING_OPTS);
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Header SHOULD contain model/thinking tag (compact mode always does)
      expect(lines[1]).toContain("(haiku • medium)");
    });
  });

  describe("widget setter", () => {
    it("defaults to header placement", () => {
      // Check via rendering behavior - model/thinking should be in header
      const agent = makeRunningAgent("a1", MODEL_THINKING_OPTS);
      activity.set("a1", makeActivity("a1"));
      manager.listAgents = () => [agent];

      const lines = renderWidgetLines(widget);

      // Should be in header (default)
      expect(lines[1]).toContain("(haiku • medium)");
      expect(lines[2]).not.toContain("haiku • medium");
    });
  });
});
