/**
 * agent-type-descriptions.test.ts — Tests for the Agent tool `agent` param
 * description helpers in agent-types.ts.
 *
 * getVisibleAgentInfos: single filtered registry pass (hidden excluded,
 * name + description from the same entry).
 * formatAgentTypeDescriptions: the enabled-mode listing — "Available agent
 * types:" header, one `name: description` line per agent with trimmed
 * descriptions, bare-name fallback for empty/whitespace ones.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgents,
  getVisibleAgentInfos,
  formatAgentTypeDescriptions,
  getAvailableTypes,
} from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

function agent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
  return { description: "", systemPrompt: "", ...overrides };
}

const REGISTRY = new Map<string, AgentConfig>([
  [
    "general-purpose",
    agent({ name: "general-purpose", description: "General-purpose agent for complex, multi-step tasks" }),
  ],
  ["Explore", agent({ name: "Explore", description: "Fast codebase exploration agent (read-only)" })],
  ["Secret", agent({ name: "Secret", description: "Internal-only agent", hidden: true })],
  ["Bare", agent({ name: "Bare", description: "   " })],
]);

beforeEach(() => {
  registerAgents(REGISTRY, { disableDefaultAgents: true });
});

describe("getVisibleAgentInfos", () => {
  it("returns name and raw description per visible agent, in registry order, hidden excluded", () => {
    expect(getVisibleAgentInfos()).toEqual([
      { name: "general-purpose", description: "General-purpose agent for complex, multi-step tasks" },
      { name: "Explore", description: "Fast codebase exploration agent (read-only)" },
      { name: "Bare", description: "   " },
    ]);
  });

  it("pairs with getAvailableTypes: the name lists are identical", () => {
    expect(getVisibleAgentInfos().map((info) => info.name)).toEqual(getAvailableTypes());
  });
});

describe("formatAgentTypeDescriptions", () => {
  it("builds the header plus one trimmed name: description line per agent", () => {
    expect(formatAgentTypeDescriptions(getVisibleAgentInfos())).toBe(
      "Available agent types:\n" +
        "general-purpose: General-purpose agent for complex, multi-step tasks\n" +
        "Explore: Fast codebase exploration agent (read-only)\n" +
        "Bare",
    );
  });

  it("degrades an empty/whitespace description to the bare name without a colon", () => {
    const listing = formatAgentTypeDescriptions([{ name: "Bare", description: " \t " }]);
    expect(listing).toBe("Available agent types:\nBare");
    expect(listing).not.toContain("Bare:");
  });

  it("trims surrounding whitespace from descriptions", () => {
    const listing = formatAgentTypeDescriptions([{ name: "Explore", description: "  Fast explorer  " }]);
    expect(listing).toBe("Available agent types:\nExplore: Fast explorer");
  });

  it("with no agents, emits the bare header (the registration length guard keeps it off the schema)", () => {
    expect(formatAgentTypeDescriptions([])).toBe("Available agent types:");
  });
});
