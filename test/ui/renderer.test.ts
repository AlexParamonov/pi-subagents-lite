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

vi.mock("../../src/ui/format.js", () => ({
  buildStatsParts: vi.fn(() => ["5 uses", "3 turns"]),
  formatMs: vi.fn(() => "1m0s"),
  getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
  buildModelThinkingTag: vi.fn((m, t) => {
    const p = [m, t].filter(Boolean);
    return p.length ? `(${p.join(" • ")})` : "";
  }),
  resolveModelLabel: vi.fn((style, name, id) => (style === "name" ? name : id)?.trim() || undefined),
}));

// Import after mocks are set up
import { renderSubagentResult, renderAgentToolResult } from "../../src/ui/renderer.js";

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

  it("uses error icon (✗) when isError is true", () => {
    renderAgentToolResult({ ...baseResult, isError: true }, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("✗");
    expect(allText).not.toContain("✓");
  });

  it("uses success icon (✓) when isError is false", () => {
    renderAgentToolResult({ ...baseResult, isError: false }, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("✓");
    expect(allText).not.toContain("✗");
  });

  it("uses success icon (✓) when isError is undefined", () => {
    renderAgentToolResult({ ...baseResult }, { expanded: false }, noopTheme, SHOW_COST);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).toContain("✓");
    expect(allText).not.toContain("✗");
  });
});
