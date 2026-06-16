/**
 * worktree-renderer.test.ts — Tests for worktree path display in the details pane.
 *
 * Verifies:
 *   - renderSubagentResult includes worktree: path in the result card
 *   - buildFallbackResultLine (via renderSubagentResult without turnCount) includes worktree: path
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

vi.mock("../src/state.js", () => ({
  __config: { agent: { showCost: false } },
  store: {
    get agent() {
      return { showCost: false };
    },
  },
}));

vi.mock("../src/format.js", () => ({
  buildStatsParts: vi.fn(() => ["5 uses", "3 turns"]),
  formatMs: vi.fn(() => "1m0s"),
  getDisplayName: vi.fn((type: string) => type.charAt(0).toUpperCase() + type.slice(1)),
}));

// Import after mocks are set up
import { renderSubagentResult } from "../src/renderer.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

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

    renderSubagentResult(message, { expanded: false }, noopTheme);

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

    renderSubagentResult(message, { expanded: false }, noopTheme);

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

    renderSubagentResult(message, { expanded: false }, noopTheme);

    const allText = textInstances.map((t) => t.text).join("\n");
    expect(allText).not.toContain("worktree:");
  });
});
