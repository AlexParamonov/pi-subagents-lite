import { describe, expect, it } from "vitest";
import { getAvailableAgents, getAvailableTypes, registerAgents } from "../../src/agents/agent-types.ts";
import {
  MAX_ORCHESTRATION_AGENTS,
  MAX_ORCHESTRATION_CATALOG_LENGTH,
  MAX_ORCHESTRATION_DESCRIPTION_LENGTH,
  MAX_ORCHESTRATION_NAME_LENGTH,
  MAX_ORCHESTRATION_PROMPT_LENGTH,
  ORCHESTRATION_PROMPT_END_MARKER,
  ORCHESTRATION_PROMPT_MARKER,
  buildOrchestrationPrompt,
  getOrchestrationPromptUpdate,
} from "../../src/prompt/orchestration.ts";
import type { AgentConfig } from "../../src/agents/types.ts";

function agent(name: string, description: string, hidden = false): AgentConfig {
  return { name, description, hidden, systemPrompt: "" };
}

describe("parent orchestration prompt", () => {
  it("lists visible dynamic agents with canonical names and frontmatter descriptions", () => {
    registerAgents(new Map([
      ["reviewer", agent("reviewer", "  Review\n  changes carefully.  ")],
      ["shipper", agent("shipper", "Prepare release notes")],
      ["internal", agent("internal", "Must not be shown", true)],
    ]), { disableDefaultAgents: true });

    const prompt = buildOrchestrationPrompt(getAvailableAgents())!;
    expect(prompt).toContain("`reviewer` — Review changes carefully.");
    expect(prompt).toContain("`shipper` — Prepare release notes");
    expect(prompt).not.toContain("internal");
    expect(prompt).toContain("foreground dependencies, background independent work");

    registerAgents(new Map([["reviewer", agent("reviewer", "Review changes carefully.")]]), { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).not.toContain("shipper");
  });

  it("bounds names, descriptions, catalog, agents, and total prompt with deterministic overflow", () => {
    const huge = "x".repeat(1000);
    const agents = Array.from({ length: MAX_ORCHESTRATION_AGENTS + 30 }, (_, i) => agent(`${i.toString().padStart(3, "0")}-agent`, huge));
    const prompt = buildOrchestrationPrompt(agents)!;

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt).toContain("… +");
    expect(prompt).toContain("omitted");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt.match(/`[^`]*`/g)?.every(name => name.length - 2 <= MAX_ORCHESTRATION_NAME_LENGTH)).toBe(true);
    expect(prompt.match(/— ([^;\n]+)/g)?.every(description => description.slice(2).length <= MAX_ORCHESTRATION_DESCRIPTION_LENGTH)).toBe(true);
    expect(prompt.length - ORCHESTRATION_PROMPT_MARKER.length - ORCHESTRATION_PROMPT_END_MARKER.length).toBeGreaterThan(0);
    expect(MAX_ORCHESTRATION_CATALOG_LENGTH).toBeLessThan(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("never truncates advertised identifiers at the catalog boundary", () => {
    const agents = Array.from({ length: 30 }, (_, i) =>
      agent(`${i.toString().padStart(2, "0")}-${"n".repeat(55)}`, "description ".repeat(30)),
    );
    const prompt = buildOrchestrationPrompt(agents)!;
    const advertised = [...prompt.matchAll(/`([^`]*)` —/g)].map(match => match[1]);
    const omitted = Number(prompt.match(/\+(\d+) omitted/)?.[1] ?? 0);

    expect(advertised.every(name => agents.some(candidate => candidate.name === name))).toBe(true);
    expect((prompt.match(/`/g) ?? [])).toHaveLength(advertised.length * 2);
    expect(advertised.length + omitted).toBe(agents.length);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("keeps catalog backticks balanced when descriptions contain backticks", () => {
    const prompt = buildOrchestrationPrompt([agent("reader", "Uses `read` first, then `bash")])!;
    expect(prompt).toContain("Uses 'read' first, then 'bash");
    expect((prompt.match(/`/g) ?? [])).toHaveLength(2);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
  });

  it("enforces UTF-8 byte budgets without splitting CJK or astral code points", () => {
    const prompt = buildOrchestrationPrompt([agent("unicode-agent", "漢字😀".repeat(100))])!;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_ORCHESTRATION_PROMPT_LENGTH);
    expect(prompt).not.toContain("\uFFFD");
    expect([...prompt].some(point => point.length === 1 && point.charCodeAt(0) >= 0xD800 && point.charCodeAt(0) <= 0xDFFF)).toBe(false);
  });

  it("preserves built-in and registry/UI insertion order while sorting only the catalog", () => {
    registerAgents(new Map([["reviewer", agent("reviewer", "Reviews")]]));
    expect(getAvailableTypes()).toEqual(["general-purpose", "Explore", "reviewer"]);

    // The catalog itself is sorted below for prompt cache stability.

    const firstRegistry = new Map([
      ["zebra", agent("zebra", "Last alphabetically")],
      ["alpha", agent("alpha", "First alphabetically")],
    ]);
    const secondRegistry = new Map([...firstRegistry.entries()].reverse());

    registerAgents(firstRegistry, { disableDefaultAgents: true });
    const firstPrompt = buildOrchestrationPrompt(getAvailableAgents());
    expect(getAvailableTypes()).toEqual(["zebra", "alpha"]);

    registerAgents(secondRegistry, { disableDefaultAgents: true });
    expect(buildOrchestrationPrompt(getAvailableAgents())).toBe(firstPrompt);
    expect(getAvailableTypes()).toEqual(["alpha", "zebra"]);
  });

  it("replaces only complete extension blocks and ignores marker collisions", () => {
    const agents = [agent("custom", "Custom role")];
    const base = `Base\n${ORCHESTRATION_PROMPT_MARKER}\nuser text`;
    const updated = getOrchestrationPromptUpdate(base, true, agents)!;
    expect(updated).toContain(`${ORCHESTRATION_PROMPT_MARKER}\nuser text`);
    expect(updated.match(new RegExp(ORCHESTRATION_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);

    const withUnmatchedEnd = `Base\n${ORCHESTRATION_PROMPT_END_MARKER}`;
    expect(getOrchestrationPromptUpdate(withUnmatchedEnd, true, agents)).toContain(withUnmatchedEnd);

    const generated = buildOrchestrationPrompt(agents)!;
    expect(getOrchestrationPromptUpdate(`Base\n\n${generated}`, false, agents)).toBe("Base");
    const replaced = getOrchestrationPromptUpdate(`Base\n\n${generated}`, true, agents);
    expect(replaced).toBeUndefined();
  });

  it("omits unrepresentable names rather than changing their callable identifier", () => {
    const names = [
      "x".repeat(65),
      "two  spaces",
      "tab\tname",
      "line\nname",
      "back`tick",
      `marker${ORCHESTRATION_PROMPT_END_MARKER}`,
      "ordinary name",
    ];
    const prompt = buildOrchestrationPrompt(names.map(name => agent(name, "Description")))!;

    expect(prompt).toContain("`two  spaces`");
    expect(prompt).toContain("`ordinary name`");
    for (const name of [names[0], names[2], names[3], names[4], names[5]]) {
      expect(prompt).not.toContain(name);
    }
    expect(prompt).toContain("+5 omitted");
    expect(buildOrchestrationPrompt([agent("bad`name", "Description")])).toContain("+1 omitted");
  });

  it("strips versioned blocks after rules change and narrowly recognizes legacy blocks", () => {
    const changedRulesBlock = `${ORCHESTRATION_PROMPT_MARKER}\nNew future rules\nAgents: \`reviewer\` — Review\n${ORCHESTRATION_PROMPT_END_MARKER}`;
    expect(getOrchestrationPromptUpdate(`Inherited\n\n${changedRulesBlock}`, false, [])).toBe("Inherited");

    const legacy = "[subagents-lite orchestration]\nDelegate when useful; use bounded briefs; retain ownership; foreground dependencies, background independent work; never concurrent writers.\nAgents: `reviewer` — Review\n[/subagents-lite orchestration]";
    expect(getOrchestrationPromptUpdate(`Custom\n\n${legacy}`, false, [])).toBe("Custom");

    const earlierLegacy = "[subagents-lite orchestration]\nDelegate only when materially useful; retain ownership and final integration; give bounded briefs; avoid concurrent writers; foreground dependent work, background independent work.\nAgents: `reviewer` — Review\n[/subagents-lite orchestration]";
    expect(getOrchestrationPromptUpdate(`Custom\n\n${earlierLegacy}`, false, [])).toBe("Custom");

    const collision = "[subagents-lite orchestration]\nuser-authored rules\nAgents: keep\n[/subagents-lite orchestration]";
    expect(getOrchestrationPromptUpdate(`Custom\n\n${collision}`, false, [])).toBeUndefined();
  });
});
