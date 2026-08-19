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

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  buildStatsParts,
  getDisplayName,
  buildMetadataLineParts,
  describeActivity,
  statusIcon,
  agentBulletPrefix,
  agentColoredText,
} from "../../src/ui/format.js";
import { registerAgents } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { AgentRecord } from "../../src/types.js";
import { asAgentSession } from "../pi-boundaries.js";

// Mutable mock store state for testing functions that depend on getStore()
let mockShowAgentColors = true;

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    agent: {
      get showAgentColors() {
        return mockShowAgentColors;
      },
    },
  }),
}));

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
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
    const agents = new Map<string, AgentConfig>();

    agents.set("visible-agent", {
      name: "visible-agent",
      displayName: "Visible Agent Display",
      description: "A visible agent",
      systemPrompt: "test",
    });

    agents.set("hidden-agent", {
      name: "hidden-agent",
      displayName: "Hidden Agent Display",
      description: "A hidden agent",
      hidden: true,
      systemPrompt: "test",
    });

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

function makeAgentRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    id: "test-agent",
    lifecycle: { status: "running", startedAt: Date.now() - 60000, started: true },
    display: {
      type: "builder",
      description: "Test agent",
      worktreeLabel: undefined,
      outputFile: undefined,
      invocation: { modelName: "haiku", thinkingLevel: "medium" },
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
    ...overrides,
  };
}

describe("buildMetadataLineParts", () => {
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
      const parts = buildMetadataLineParts(agent, "name", undefined, "metadata");
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
      const parts = buildMetadataLineParts(agent, "name", undefined, "metadata");
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
      const parts = buildMetadataLineParts(agent, "name", undefined, "metadata");
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
        execution: { settled: false, settlementCount: 0, session: undefined },
      });
      const parts = buildMetadataLineParts(agent, "name", undefined, "metadata");
      expect(parts[0]).toBe("@my-feature");
      expect(parts.length).toBe(1);
    });

    it("omits model/thinking by default (placement defaults to 'header')", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          worktreeLabel: "my-feature",
          outputFile: undefined,
          invocation: { modelName: "haiku", thinkingLevel: "medium" },
        },
      });
      const parts = buildMetadataLineParts(agent, "name");
      // Default placement is 'header' - model/thinking stays out of the metadata line
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
        execution: {
          settled: false,
          settlementCount: 0,
          session: asAgentSession({ model: { id: "claude-3-haiku", name: "Haiku" } }),
        },
      });
      const parts = buildMetadataLineParts(agent, "name", undefined, "metadata");
      expect(parts[0]).toBe("Haiku");
    });

    it("uses model id when style is 'id'", () => {
      const agent = makeAgentRecord({
        display: {
          type: "builder",
          description: "Test",
          invocation: { modelName: "haiku", thinkingLevel: undefined },
        },
        execution: {
          settled: false,
          settlementCount: 0,
          session: asAgentSession({ model: { id: "claude-3-haiku", name: "Haiku" } }),
        },
      });
      const parts = buildMetadataLineParts(agent, "id", undefined, "metadata");
      expect(parts[0]).toBe("claude-3-haiku");
    });
  });
});

describe("describeActivity", () => {
  it("does not truncate response text longer than 60 characters", () => {
    const longResponse = "a".repeat(100);
    const result = describeActivity(new Map(), longResponse);
    expect(result.length).toBe(100);
    expect(result).toBe(longResponse);
  });
});

describe("statusIcon", () => {
  // Theme that records which color was used, returns color name as text
  function makeTrackingTheme() {
    const calls: Array<{ color: string; text: string }> = [];
    return {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return `[${color}:${text}]`;
      },
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      calls,
    };
  }

  beforeEach(() => {
    registerAgents(
      new Map([
        ["red-agent", { name: "red-agent", description: "Red", color: "red", systemPrompt: "" }],
        ["uncolored-agent", { name: "uncolored-agent", description: "No color", systemPrompt: "" }],
      ]),
    );
  });

  it("returns plain icon when status is unknown", () => {
    const theme = makeTrackingTheme();
    expect(statusIcon(undefined, theme)).toBe("▸");
  });

  it("uses theme.fg for agent without color", () => {
    const theme = makeTrackingTheme();
    const result = statusIcon("running", theme, "uncolored-agent");
    expect(result).toBe("[accent:◈]");
  });

  it("uses theme.fg when no agentType is passed", () => {
    const theme = makeTrackingTheme();
    const result = statusIcon("running", theme);
    expect(result).toBe("[accent:◈]");
  });

  it("uses agent color ANSI when agentType has a color", () => {
    const theme = makeTrackingTheme();
    const result = statusIcon("running", theme, "red-agent");
    // Should use raw ANSI foreground (not theme.fg) and include reset
    expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(result).toContain("◈");
    expect(result).toContain("\x1b[39m");
    // Should NOT have called theme.fg
    expect(theme.calls).toHaveLength(0);
  });

  it("tints completed status icon with agent color", () => {
    const theme = makeTrackingTheme();
    const result = statusIcon("completed", theme, "red-agent");
    expect(result).toContain("✓");
    expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
  });

  it("falls back to theme.fg when showAgentColors is false", () => {
    const theme = makeTrackingTheme();
    mockShowAgentColors = false;
    const result = statusIcon("running", theme, "red-agent");
    // Should use theme.fg, not agent color ANSI
    expect(result).toBe("[accent:◈]");
    expect(theme.calls).toHaveLength(1);
    expect(theme.calls[0].color).toBe("accent");
    mockShowAgentColors = true;
  });
});

describe("agentBulletPrefix", () => {
  beforeEach(() => {
    registerAgents(
      new Map([
        ["colored-agent", { name: "colored-agent", description: "Colored", color: "#ff0000", systemPrompt: "" }],
        ["uncolored-agent", { name: "uncolored-agent", description: "No color", systemPrompt: "" }],
      ]),
    );
    mockShowAgentColors = true;
  });

  afterEach(() => {
    mockShowAgentColors = true;
  });

  it("returns colored bullet when showAgentColors is true and agent has a color", () => {
    const result = agentBulletPrefix("colored-agent");
    expect(result).toContain("•");
    expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    // No fg reset (\x1b[39m) — the outer color context (e.g. accent highlight)
    // flows through the agent name that follows the bullet.
    expect(result).not.toContain("\x1b[39m");
    expect(result).toContain(" ");
  });

  it("returns empty string when showAgentColors is true but agent has no color", () => {
    const result = agentBulletPrefix("uncolored-agent");
    expect(result).toBe("");
  });

  it("returns empty string when showAgentColors is false", () => {
    mockShowAgentColors = false;
    const result = agentBulletPrefix("colored-agent");
    expect(result).toBe("");
  });

  it("returns empty string when agentType is undefined", () => {
    const result = agentBulletPrefix(undefined);
    expect(result).toBe("");
  });
});

describe("agentColoredText", () => {
  beforeEach(() => {
    registerAgents(
      new Map([
        ["colored-agent", { name: "colored-agent", description: "Colored", color: "#ff0000", systemPrompt: "" }],
        ["uncolored-agent", { name: "uncolored-agent", description: "No color", systemPrompt: "" }],
      ]),
    );
    mockShowAgentColors = true;
  });

  afterEach(() => {
    mockShowAgentColors = true;
  });

  it("returns colored text when showAgentColors is true and agent has a color", () => {
    const result = agentColoredText("my-name", "colored-agent");
    expect(result).toContain("my-name");
    expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(result).toContain("\x1b[39m");
  });

  it("returns plain text when showAgentColors is true but agent has no color", () => {
    const result = agentColoredText("my-name", "uncolored-agent");
    expect(result).toBe("my-name");
  });

  it("returns plain text when showAgentColors is false", () => {
    mockShowAgentColors = false;
    const result = agentColoredText("my-name", "colored-agent");
    expect(result).toBe("my-name");
  });

  it("returns plain text when agentType is undefined", () => {
    const result = agentColoredText("my-name", undefined);
    expect(result).toBe("my-name");
  });
});
