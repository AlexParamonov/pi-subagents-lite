/**
 * worktree-renderer.test.ts — Tests for worktree path display in the details pane.
 *
 * Verifies:
 *   - renderSubagentResult includes worktree: path in the result card
 *   - buildFallbackResultLine (via renderSubagentResult without turnCount) includes worktree: path
 *
 * Note: renderer.ts no longer imports shell.ts — showCost is passed as a parameter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock setup — capture Text content for assertions                  */
/* ------------------------------------------------------------------ */

const textInstances: any[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: any[] = [];
    addChild(c: any) { this.children.push(c); }
    clear() { this.children = []; }
  },
  Spacer: class {},
  Text: class {
    text: string;
    constructor(text: string, _x?: number, _y?: number) {
      this.text = text;
      textInstances.push(this);
    }
  },
  Box: class {
    children: any[] = [];
    addChild(c: any) { this.children.push(c); }
  },
}));

vi.mock("../../src/ui/format.js", () => ({
  buildStatsParts: vi.fn(() => ["5 uses", "3 turns"]),
  formatMs: vi.fn(() => "1m0s"),
  formatThinkingTag: vi.fn((value: unknown) => value === "high" ? "thinking: high" : undefined),
  getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
}));

// Import after mocks are set up
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "../../src/ui/renderer.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/** Default showCost value for tests. */
const SHOW_COST = false;

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("renderer", () => {
  beforeEach(() => {
    textInstances.length = 0;
  });

  it("shows thinking level directly after the model in a normal tool call", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "sonnet", thinking: "high" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Builder (sonnet · thinking: high)");
  });

  it("shows concrete thinking without a model override in a tool call", () => {
    renderAgentToolCall({ agent: "agent", thinking: "high" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Agent (thinking: high)");
  });

  it("keeps the normal tool call unchanged without a concrete thinking level", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "sonnet", thinking: "inherit" }, noopTheme);

    expect(textInstances.at(-1)?.text).toBe("▸ Builder (sonnet)");
  });

  it("shows thinking level directly after the model in an agent result card", () => {
    renderAgentToolResult({
      content: [{ type: "text", text: "Agent output" }],
      details: { type: "builder", description: "Build something", modelName: "sonnet", thinkingLevel: "high", turnCount: 5 },
    }, { expanded: false }, noopTheme, SHOW_COST);

    expect(textInstances.map((t) => t.text).join("\n")).toContain("Builder (sonnet · thinking: high)");
  });

  it("shows concrete thinking without inventing a model in a foreground result card", () => {
    renderAgentToolResult({
      content: [{ type: "text", text: "Agent output" }],
      details: { type: "builder", description: "Build something", thinkingLevel: "high", turnCount: 5 },
    }, { expanded: false }, noopTheme, SHOW_COST);

    const text = textInstances.map((t) => t.text).join("\n");
    expect(text).toContain("Builder (thinking: high)");
    expect(text).not.toContain("undefined");
  });

  it("shows worktree path in details pane for a completed agent with stats", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        worktreePath: "/wt/feature",
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("worktree: /wt/feature");
  });

  it("shows thinking level directly after the model in a subagent result card", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        modelName: "sonnet",
        thinkingLevel: "high",
        turnCount: 5,
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    expect(textInstances.map((t) => t.text).join("\n")).toContain("Builder (sonnet · thinking: high)");
  });

  it("shows concrete thinking without inventing a model in a background result card", () => {
    renderSubagentResult({
      content: "Agent output",
      details: { type: "builder", description: "Build something", thinkingLevel: "high", turnCount: 5, status: "completed" },
    }, { expanded: false }, noopTheme, SHOW_COST);

    const text = textInstances.map((t) => t.text).join("\n");
    expect(text).toContain("Builder (thinking: high)");
    expect(text).not.toContain("undefined");
  });

  it("shows worktree path in fallback result line (no turnCount)", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        worktreePath: "/wt/feature/packages/web",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("worktree: /wt/feature/packages/web");
  });

  it("does not render worktree line when worktreePath is absent", () => {
    const message = {
      content: "Agent output",
      details: {
        type: "builder",
        description: "Build something",
        turnCount: 5,
        status: "completed",
      },
    };

    renderSubagentResult(message, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).not.toContain("worktree:");
  });
});
