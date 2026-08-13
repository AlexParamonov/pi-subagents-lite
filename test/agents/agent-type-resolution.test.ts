/**
 * agent-type-resolution.test.ts — Tests for case-insensitive agent type resolution.
 *
 * Verifies the resolution contract in agent-types.ts:
 *   - the exact registered name wins
 *   - a single case-insensitive match resolves to the canonical registered name
 *   - two or more registered types differing only by case are ambiguous
 *   - unknown names are not found; displayName is display-only (no synonym matching)
 *   - hidden agents participate in resolution like any registered type
 */

import { describe, it, expect, beforeEach } from "vitest";

import { registerAgents, resolveType, getAgentConfig, getAvailableTypes } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/types.ts";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name, description: `Agent ${name}`, systemPrompt: "", ...overrides };
}

const EXPLORE_AND_GENERAL = new Map<string, AgentConfig>([
  ["Explore", agent("Explore")],
  ["general-purpose", agent("general-purpose")],
]);

describe("resolveType", () => {
  beforeEach(() => {
    registerAgents(new Map(EXPLORE_AND_GENERAL));
  });

  it("resolves an exact-case registered name to itself", () => {
    expect(resolveType("Explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(resolveType("general-purpose")).toEqual({ kind: "resolved", key: "general-purpose" });
  });

  it("resolves a single case-insensitive match to the canonical name", () => {
    expect(resolveType("explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(resolveType("EXPLORE")).toEqual({ kind: "resolved", key: "Explore" });
    expect(resolveType("General-Purpose")).toEqual({ kind: "resolved", key: "general-purpose" });
  });

  it("an exact-case match beats a case-insensitive match when both exist", () => {
    registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(resolveType("Explore")).toEqual({ kind: "resolved", key: "Explore" });
    expect(resolveType("explore")).toEqual({ kind: "resolved", key: "explore" });
  });

  it("two registered types differing only by case are ambiguous with both candidates", () => {
    registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
  });

  it("hidden agents participate in resolution and ambiguity", () => {
    registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore", { hidden: true })],
      ]),
    );
    expect(resolveType("explore")).toEqual({ kind: "resolved", key: "explore" });
    expect(resolveType("EXPLORE")).toEqual({ kind: "ambiguous", candidates: ["Explore", "explore"] });
  });

  it("does not resolve displayName aliases (no synonyms)", () => {
    registerAgents(
      new Map([
        ["general-purpose", agent("general-purpose", { displayName: "Agent" })],
        ["Explore", agent("Explore", { displayName: "Explorer" })],
      ]),
    );
    expect(resolveType("Agent")).toEqual({ kind: "not-found" });
    expect(resolveType("Explorer")).toEqual({ kind: "not-found" });
  });

  it("returns not-found for unknown and empty names", () => {
    expect(resolveType("nope")).toEqual({ kind: "not-found" });
    expect(resolveType("")).toEqual({ kind: "not-found" });
  });
});

describe("getAgentConfig", () => {
  beforeEach(() => {
    registerAgents(new Map(EXPLORE_AND_GENERAL));
  });

  it("returns the config for exact and case-insensitive names", () => {
    expect(getAgentConfig("Explore")?.name).toBe("Explore");
    expect(getAgentConfig("explore")?.name).toBe("Explore");
  });

  it("returns undefined for ambiguous and unknown names", () => {
    registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
      ]),
    );
    expect(getAgentConfig("EXPLORE")).toBeUndefined();
    expect(getAgentConfig("nope")).toBeUndefined();
  });
});

describe("getAvailableTypes", () => {
  it("lists registered names as-is, not normalized variants", () => {
    registerAgents(
      new Map([
        ["Explore", agent("Explore")],
        ["explore", agent("explore")],
        ["general-purpose", agent("general-purpose")],
      ]),
    );
    const types = getAvailableTypes();
    expect(types).toContain("Explore");
    expect(types).toContain("explore");
    expect(types).toContain("general-purpose");
    expect(types).not.toContain("EXPLORE");
  });
});
