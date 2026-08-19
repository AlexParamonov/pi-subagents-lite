import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../src/ui/types.js";

/* ------------------------------------------------------------------ */
/*  Mock setup — capture Text content for assertions                  */
/* ------------------------------------------------------------------ */

/** The mock Text instances the pi-tui mock records for assertions. */
interface MockText {
  text: string;
}
const textInstances: MockText[] = [];

vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {
    children: Component[] = [];
    addChild(c: Component) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
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
    children: Component[] = [];
    addChild(c: Component) {
      this.children.push(c);
    }
  },
  visibleWidth: (text: string) => text.length,
}));

vi.mock("../../src/shell.js", () => ({
  getManager: vi.fn(() => null),
  getStore: vi.fn(() => ({
    agent: {
      showAgentColors: true,
      outputTranscript: false,
      outputThinkingBufferSize: 0,
      showCompletionCards: true,
      agentStatusLimit: 0,
      modelDisplayStyle: "name" as const,
      modelThinkingPlacement: "header" as const,
      statusBarFormat: "full" as const,
    },
  })),
}));

vi.mock("../../src/ui/format.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../../src/ui/format.js");
  return {
    ...actual,
    buildStatsParts: vi.fn(() => ["5 uses", "3 turns"]),
    formatMs: vi.fn(() => "1m0s"),
    getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
    buildModelThinkingTag: vi.fn((m: string | undefined, t: string | undefined) => {
      const p = [m, t].filter(Boolean);
      return p.length ? `(${p.join(" • ")})` : "";
    }),
    resolveModelLabel: vi.fn(
      (style: "id" | "name", name?: string, id?: string) => (style === "name" ? name : id)?.trim() || undefined,
    ),
  };
});

// Import after mocks are set up
import {
  renderSubagentResult,
  renderAgentToolCall,
  renderAgentToolResult,
  registerAgentInvalidation,
  invalidateAgentRow,
  cleanupInvalidations,
} from "../../src/ui/renderer.js";
import { getManager } from "../../src/shell.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const noopTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const SHOW_COST = false;

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("renderSubagentResult — completion visibility", () => {
  beforeEach(() => {
    textInstances.length = 0;
  });

  it("renders by default", () => {
    const result = renderSubagentResult({ content: "Result" }, { expanded: false }, noopTheme, SHOW_COST);

    expect(result.children).not.toHaveLength(0);
  });

  it.each([{ expanded: false }, { expanded: true }, {}])(
    "returns an empty component when hiding is enabled (%j)",
    (options) => {
      const result = renderSubagentResult({ content: "Result" }, options, noopTheme, SHOW_COST, "id", true);

      expect(result.children).toHaveLength(0);
      expect(textInstances).toHaveLength(0);
    },
  );
});

describe("renderSubagentResult — worktree path display", () => {
  beforeEach(() => {
    textInstances.length = 0;
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

describe("renderSubagentResult — status icon", () => {
  beforeEach(() => {
    textInstances.length = 0;
  });

  it.each([
    ["queued", "◆"],
    ["running", "◈"],
    ["completed", "✓"],
    ["turn_limited", "✓"],
    ["error", "✗"],
    ["aborted", "✗"],
    ["stopped", "■"],
    ["unknown-status", "▸"],
  ])("shows %s icon for status %s", (status, icon) => {
    renderSubagentResult(
      {
        content: "Agent output",
        details: { type: "builder", description: "Build something", turnCount: 5, status },
      },
      { expanded: false },
      noopTheme,
      SHOW_COST,
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain(icon);
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolResult — icon tests                                */
/* ------------------------------------------------------------------ */

describe("renderAgentToolResult — error icon", () => {
  beforeEach(() => {
    textInstances.length = 0;
  });

  const baseResult = {
    content: [{ type: "text", text: "Agent output" }],
    details: {
      type: "builder",
      description: "Test agent",
      turnCount: 3,
      toolUses: 5,
      input: 100,
      output: 50,
      contextPercent: 10,
      durationMs: 60000,
    },
  };

  it("shows stats + description for foreground agent with error", () => {
    renderAgentToolResult({ ...baseResult, isError: true }, { expanded: false }, noopTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows stats + description for foreground agent without error", () => {
    renderAgentToolResult({ ...baseResult, isError: false }, { expanded: false }, noopTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows stats + description for foreground agent when isError is undefined", () => {
    renderAgentToolResult(baseResult, { expanded: false }, noopTheme, SHOW_COST, "id", {
      executionStarted: true,
    });

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result line shows stats + description (icon + name in call line)
    expect(allText).toContain("5 uses");
    expect(allText).toContain("3 turns");
    expect(allText).toContain("Test agent");
    expect(allText).not.toContain("Builder");
  });

  it("shows model tag before stats in the foreground result line", () => {
    renderAgentToolResult(
      { ...baseResult, details: { ...baseResult.details, modelName: "Sonnet", modelId: "claude-sonnet-4-5" } },
      { expanded: false },
      noopTheme,
      SHOW_COST,
      "id",
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("(claude-sonnet-4-5)·");
  });

  it("does not lead with a separator when the model tag is empty", () => {
    renderAgentToolResult(baseResult, { expanded: false }, noopTheme, SHOW_COST, "id");

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("3 turns");
    expect(allText).not.toContain("  ·");
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolResult — background agent status indicators        */
/* ------------------------------------------------------------------ */

describe("renderAgentToolResult — background agent status indicators", () => {
  beforeEach(() => {
    textInstances.length = 0;
    cleanupInvalidations();
  });

  const backgroundResult = {
    content: [{ type: "text", text: "[Agent queued] Success! You delegated to an agent." }],
    details: {
      type: "builder",
      description: "Fix vendor approach",
      agentId: "agent-abc-123",
      status: "queued",
    },
  };

  it("shows only description when status is queued", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    // Icon and status are in the call line
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("✗");
  });

  it("shows only description when status is running", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "running" } },
      { expanded: false },
      noopTheme,
      SHOW_COST,
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◈");
    expect(allText).not.toContain("(running)");
    expect(allText).not.toContain("Builder");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("✗");
  });

  it("shows only description when status is completed", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "completed" } },
      { expanded: false },
      noopTheme,
      SHOW_COST,
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("✓");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("(running)");
  });

  it.each(["error", "aborted", "stopped"])("shows only description when status is %s", (status) => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status } },
      { expanded: false },
      noopTheme,
      SHOW_COST,
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("✗");
    expect(allText).not.toContain("◇");
  });

  it("result renderer shows only description for background agents", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
  });

  it("result renderer shows description when manager returns null", () => {
    vi.mocked(getManager).mockReturnValue(null);

    renderAgentToolResult(backgroundResult, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description
    expect(allText).toContain("Fix vendor approach");
  });

  it("result renderer shows only description when agent is queued", () => {
    renderAgentToolResult(backgroundResult, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◇");
    expect(allText).not.toContain("(queued)");
    expect(allText).not.toContain("Builder");
  });

  it("result renderer shows only description when agent is running", () => {
    renderAgentToolResult(
      { ...backgroundResult, details: { ...backgroundResult.details, status: "running" } },
      { expanded: false },
      noopTheme,
      SHOW_COST,
    );

    const allText = textInstances.map((t) => t.text).join("\n");
    // Result renderer only shows description for background agents
    expect(allText).toContain("Fix vendor approach");
    expect(allText).not.toContain("◈");
    expect(allText).not.toContain("(running)");
    expect(allText).not.toContain("Builder");
  });
});

/* ------------------------------------------------------------------ */
/*  registerAgentInvalidation / invalidateAgentRow                    */
/* ------------------------------------------------------------------ */

describe("agent invalidation map", () => {
  beforeEach(() => {
    cleanupInvalidations();
  });

  it("registerAgentInvalidation stores and invalidateAgentRow calls the function", () => {
    const fn = vi.fn();
    registerAgentInvalidation("agent-1", fn);
    invalidateAgentRow("agent-1");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("invalidateAgentRow is a no-op for unknown agent ids", () => {
    const fn = vi.fn();
    registerAgentInvalidation("agent-1", fn);
    invalidateAgentRow("agent-unknown");
    expect(fn).not.toHaveBeenCalled();
  });

  it("cleanupInvalidations clears all entries", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerAgentInvalidation("agent-1", fn1);
    registerAgentInvalidation("agent-2", fn2);
    cleanupInvalidations();
    invalidateAgentRow("agent-1");
    invalidateAgentRow("agent-2");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it("registerAgentInvalidation overwrites previous entry for same agent", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerAgentInvalidation("agent-1", fn1);
    registerAgentInvalidation("agent-1", fn2);
    invalidateAgentRow("agent-1");
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ */
/*  renderAgentToolCall — background agent icon                        */
/* ------------------------------------------------------------------ */

describe("renderAgentToolCall — background agent icon", () => {
  beforeEach(() => {
    textInstances.length = 0;
  });

  it("shows ▸ icon for foreground agents", () => {
    renderAgentToolCall({ agent: "builder" }, noopTheme);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("▸");
    expect(allText).toContain("Builder");
  });

  it("shows ◆ icon for background agents (queued state)", () => {
    renderAgentToolCall({ agent: "builder", run_in_background: true }, noopTheme);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("◆");
    expect(allText).toContain("Builder");
    expect(allText).not.toContain("◇");
  });

  it("shows ▸ icon when run_in_background is false", () => {
    renderAgentToolCall({ agent: "builder", run_in_background: false }, noopTheme);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("▸");
  });

  it("shows model override when present", () => {
    renderAgentToolCall({ agent: "builder", _modelOverride: "claude-3" }, noopTheme);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("(claude-3)");
  });
});
