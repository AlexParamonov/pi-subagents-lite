/**
 * format.test.ts — Tests for display formatting helpers.
 *
 * buildStatsParts accepts a `visible` parameter controlling which stat
 * parts appear in the output. All flags default to true for backward
 * compatibility.
 *
 * getDisplayName resolves the display name for any agent type (visible or
 * hidden) from the type registry, falling back to name / "Agent".
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildStatsParts, getDisplayName, buildContinuationLineParts } from "../../src/ui/format.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const allStats = {
  toolUses: 5,
  turnCount: 3,
  maxTurns: 30,
  input: 1000,
  output: 500,
  contextPercent: 50,
  compactions: 2,
  cost: 1.23,
  durationMs: 65000,
};

describe("buildStatsParts — visible flag: showTools", () => {
  it("excludes toolUses when showTools is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTools: false });
    expect(parts.some((p) => p.includes("🛠︎"))).toBe(false);
  });

  it("includes toolUses when showTools is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => p.includes("🛠︎"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showTurns", () => {
  it("excludes turns when showTurns is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTurns: false });
    expect(parts.some((p) => p.includes("⟳"))).toBe(false);
  });

  it("includes turns when showTurns is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => p.includes("⟳"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showInput/showOutput", () => {
  it("excludes token display when showInput and showOutput are both false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false, showOutput: false });
    expect(parts.some((p) => p.includes("↑") || p.includes("↓"))).toBe(false);
  });

  it("excludes only input when showInput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showInput: false });
    expect(parts.some((p) => p.includes("↑"))).toBe(false);
    expect(parts.some((p) => p.includes("↓"))).toBe(true);
  });

  it("excludes only output when showOutput is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showOutput: false });
    expect(parts.some((p) => p.includes("↑"))).toBe(true);
    expect(parts.some((p) => p.includes("↓"))).toBe(false);
  });
});

describe("buildStatsParts — visible flag: showContext", () => {
  it("excludes context percent and compactions when showContext is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showContext: false });
    expect(parts.some((p) => p.includes("%"))).toBe(false);
    expect(parts.some((p) => p.includes("↻"))).toBe(false);
  });

  it("includes context percent when showContext is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => p.includes("%"))).toBe(true);
    expect(parts.some((p) => p.includes("↻"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showCost", () => {
  it("excludes cost when showCost is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showCost: false });
    expect(parts.some((p) => p.includes("$"))).toBe(false);
  });

  it("includes cost when showCost is true (default)", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — visible flag: showTime", () => {
  it("excludes time when showTime is false", () => {
    const parts = buildStatsParts(allStats, mockTheme, { showTime: false });
    expect(parts.some((p) => p.includes("m") || p.includes("s") || p.includes("<1s"))).toBe(false);
  });

  it("includes time when durationMs is provided and showTime is true", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => p.includes("1m"))).toBe(true);
  });
});

describe("buildStatsParts — all visible flags false", () => {
  it("returns empty array when all flags are false", () => {
    const parts = buildStatsParts(allStats, mockTheme, {
      showTools: false,
      showTurns: false,
      showInput: false,
      showOutput: false,
      showContext: false,
      showCost: false,
      showTime: false,
    });
    expect(parts).toEqual([]);
  });
});

describe("buildStatsParts — backward compatibility", () => {
  it("without visible parameter, behaves the same as before", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((p) => p.includes("🛠︎"))).toBe(true);
    expect(parts.some((p) => p.includes("⟳"))).toBe(true);
    expect(parts.some((p) => p.includes("↑"))).toBe(true);
    expect(parts.some((p) => p.includes("$"))).toBe(true);
  });
});

describe("buildStatsParts — cost behavior", () => {
  it("does not include cost when not provided", () => {
    const parts = buildStatsParts(
      {
        toolUses: 5,
        turnCount: 3,
        maxTurns: 30,
        input: 1000,
        output: 500,
        contextPercent: 50,
        compactions: 2,
        durationMs: 65000,
      },
      mockTheme,
    );
    expect(parts.some((p) => p.includes("$"))).toBe(false);
  });

  it("does not include cost when cost is 0", () => {
    const parts = buildStatsParts({ ...allStats, cost: 0 }, mockTheme);
    expect(parts.some((p) => p.includes("$"))).toBe(false);
  });

  it("includes cost formatted as dollar amount", () => {
    const parts = buildStatsParts(allStats, mockTheme);
    expect(parts.some((p) => /^\$\d+\.\d{2}$/.test(p))).toBe(true);
  });
});

describe("getDisplayName", () => {
  beforeEach(() => {
    // Set up test agents
    const agents = new Map<string, AgentConfig>();

    // Visible agent with displayName
    agents.set("visible-agent", {
      name: "visible-agent",
      displayName: "Visible Agent Display",
      description: "A visible agent",
      systemPrompt: "test",
    });

    // Hidden agent with displayName
    agents.set("hidden-agent", {
      name: "hidden-agent",
      displayName: "Hidden Agent Display",
      description: "A hidden agent",
      hidden: true,
      systemPrompt: "test",
    });

    // Agent without displayName (should fall back to name)
    agents.set("no-display-name", {
      name: "no-display-name",
      description: "An agent without displayName",
      systemPrompt: "test",
    });

    registerAgents(agents);
  });

  it("returns displayName for visible agents", () => {
    expect(getDisplayName("visible-agent")).toBe("Visible Agent Display");
  });

  it("returns displayName for hidden agents", () => {
    // Hidden agents resolve from their own config, not general-purpose's "Agent".
    expect(getDisplayName("hidden-agent")).toBe("Hidden Agent Display");
  });

  it("falls back to name when displayName is not set", () => {
    expect(getDisplayName("no-display-name")).toBe("no-display-name");
  });

  it("falls back to 'Agent' when agent type is not found", () => {
    expect(getDisplayName("non-existent-agent")).toBe("Agent");
  });
});

/**
 * Mock factories for buildContinuationLineParts tests.
 */
function makeAgentRecord(overrides?: Partial<any>): any {
  return {
    id: "test-agent",
    lifecycle: { status: "running", startedAt: Date.now() - 60000 },
    display: {
      type: "builder",
      description: "Test agent",
      worktreeLabel: undefined,
      outputFile: undefined,
      invocation: { modelName: "haiku", thinkingLevel: "medium" },
    },
    execution: { session: { model: { id: "haiku", name: "Haiku" }, thinkingLevel: "medium" } },
    stats: {
      toolUses: 5,
      compactionCount: 0,
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0, cost: 0 },
      turnCount: 3,
      maxTurns: 30,
    },
    ...overrides,
  };
}

describe("buildContinuationLineParts", () => {
  describe("part order", () => {
    it("puts model/thinking before worktreeLabel", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          worktreeLabel: "my-feature",
          outputFile: undefined,
          invocation: { modelName: "haiku", thinkingLevel: "medium" },
        },
      });
      const parts = buildContinuationLineParts(agent, "name");
      // model/thinking should be first, worktree should be second
      expect(parts[0]).toBe("Haiku • medium");
      expect(parts[1]).toBe("@my-feature");
    });

    it("puts outputFile last when all parts present", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          worktreeLabel: "my-feature",
          outputFile: "/tmp/test.log",
          invocation: { modelName: "haiku", thinkingLevel: "medium" },
        },
      });
      const parts = buildContinuationLineParts(agent, "name");
      // model/thinking first, worktree second, outputFile last
      expect(parts[0]).toBe("Haiku • medium");
      expect(parts[1]).toBe("@my-feature");
      expect(parts[2]).toBe("tail -f /tmp/test.log");
    });

    it("omits worktreeLabel when not present", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          worktreeLabel: undefined,
          outputFile: undefined,
          invocation: { modelName: "haiku", thinkingLevel: "medium" },
        },
      });
      const parts = buildContinuationLineParts(agent, "name");
      expect(parts[0]).toBe("Haiku • medium");
      expect(parts.length).toBe(1);
    });

    it("omits model/thinking when not present", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          worktreeLabel: "my-feature",
          outputFile: undefined,
        },
        execution: { session: undefined },
      });
      const parts = buildContinuationLineParts(agent, "name");
      expect(parts[0]).toBe("@my-feature");
      expect(parts.length).toBe(1);
    });
  });

  describe("model display style", () => {
    it("uses model name when style is 'name'", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          invocation: { modelName: "haiku", thinkingLevel: undefined },
        },
        execution: { session: { model: { id: "claude-3-haiku", name: "Haiku" } } },
      });
      const parts = buildContinuationLineParts(agent, "name");
      expect(parts[0]).toBe("Haiku");
    });

    it("uses model id when style is 'id'", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          invocation: { modelName: "haiku", thinkingLevel: undefined },
        },
        execution: { session: { model: { id: "claude-3-haiku", name: "Haiku" } } },
      });
      const parts = buildContinuationLineParts(agent, "id");
      expect(parts[0]).toBe("claude-3-haiku");
    });
  });
});
