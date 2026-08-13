/**
 * agent-types-resolver.test.ts — Tests for resolveVisibleTools.
 *
 * Verifies that the single-owner tool visibility resolver in agent-types.ts
 * correctly handles allowlist, denylist, ext/* expansion, and the
 * no-sub-subagent exclude policy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Import the module under test
import {
  resolveVisibleTools,
  resolveSessionAllowedTools,
  EXCLUDED_TOOL_NAMES,
  BUILTIN_TOOL_NAMES,
  DEFAULT_ACTIVE_TOOL_NAMES,
  getConfig,
  getToolNamesForType,
  registerAgents,
} from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/types.ts";

/* ------------------------------------------------------------------ */
/*  Sanity: constants                                                 */
/* ------------------------------------------------------------------ */

describe("EXCLUDED_TOOL_NAMES", () => {
  it("contains 'Agent' to prevent sub-subagent spawning", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("Agent");
  });
});

describe("BUILTIN_TOOL_NAMES", () => {
  it("is exported and non-empty", () => {
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("includes all 7 pi built-in tools (validation set)", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("read");
    expect(BUILTIN_TOOL_NAMES).toContain("bash");
    expect(BUILTIN_TOOL_NAMES).toContain("edit");
    expect(BUILTIN_TOOL_NAMES).toContain("write");
    expect(BUILTIN_TOOL_NAMES).toContain("grep");
    expect(BUILTIN_TOOL_NAMES).toContain("find");
    expect(BUILTIN_TOOL_NAMES).toContain("ls");
    expect(BUILTIN_TOOL_NAMES).toHaveLength(7);
  });
});

describe("DEFAULT_ACTIVE_TOOL_NAMES", () => {
  it("is exported and has 4 items", () => {
    expect(DEFAULT_ACTIVE_TOOL_NAMES).toHaveLength(4);
  });

  it("contains pi's default active tools", () => {
    expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("read");
    expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("bash");
    expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("edit");
    expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("write");
  });

  it("does not contain grep, find, or ls", () => {
    expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("grep");
    expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("find");
    expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("ls");
  });
});

/* ------------------------------------------------------------------ */
/*  Allowlist mode (tools: string[])                                  */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — allowlist mode", () => {
  it("returns only allowed tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash", "edit"],
    });
    expect(result).toEqual(["read", "bash", "edit"]);
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: ["read", "bash", "edit", "Agent"],
    });
    expect(result).not.toContain("Agent");
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
  });

  it("returns [] when all active tools are excluded", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent"],
      tools: ["Agent"],
    });
    expect(result).toEqual([]);
  });

  it("ext/* expands to all tools from extension", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: ["read", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).not.toContain("bash");
  });

  it("ext/* with non-loaded extension: warns and resolves to nothing", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is not loaded, "tavily/*" will have no effect'),
    );
  });

  it("ext/tool syntax: extracts tool name from entry", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search"],
      tools: ["read", "tavily/web_search"],
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).not.toContain("bash");
  });

  it("warns about unknown bare tool name not in builtins or extensions", () => {
    const notify = vi.fn();

    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "foobar"],
      notify,
    });
    expect(result).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('tool "foobar" not found in any loaded extension'));
  });

  it("whitelists grep, find, or ls without warning (AC-4)", () => {
    const notify = vi.fn();

    const grepResult = resolveVisibleTools({
      activeTools: ["read", "bash", "grep"],
      tools: ["read", "grep"],
      notify,
    });
    expect(grepResult).toContain("grep");
    expect(grepResult).not.toContain("bash");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('tool "grep" not found'));

    const findResult = resolveVisibleTools({
      activeTools: ["read", "bash", "find"],
      tools: ["read", "find"],
      notify,
    });
    expect(findResult).toContain("find");
    expect(findResult).not.toContain("bash");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('tool "find" not found'));

    const lsResult = resolveVisibleTools({
      activeTools: ["read", "bash", "ls"],
      tools: ["read", "ls"],
      notify,
    });
    expect(lsResult).toContain("ls");
    expect(lsResult).not.toContain("bash");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('tool "ls" not found'));
  });

  it("warns when extension is loaded but none of its tools are in tools", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract"],
      tools: ["read", "bash"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("does not warn when ext/* covers the extension", () => {
    const notify = vi.fn();
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract"],
      tools: ["read", "tavily/*"],
      extToolMap,
      notify,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("ext/* combined with named extension tool", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);
    extToolMap.set("exa", ["exa_search"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract", "web_crawl", "exa_search"],
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
    expect(result).toContain("exa_search");
  });
});

/* ------------------------------------------------------------------ */
/*  Denylist mode (excludeTools, no tools whitelist)                  */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — denylist mode", () => {
  it("excludes tools listed in excludeTools", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });

  it("always excludes EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("ext/* syntax in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract", "web_crawl"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search", "web_extract", "web_crawl"],
      tools: undefined,
      excludeTools: ["tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
    expect(result).not.toContain("web_crawl");
  });

  it("mixed ext/* and bare names in excludeTools", () => {
    const extToolMap = new Map<string, string[]>();
    extToolMap.set("tavily", ["web_search", "web_extract"]);

    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "write", "web_search", "web_extract"],
      tools: undefined,
      excludeTools: ["write", "tavily/*"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("write");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("web_extract");
  });

  it("excludeTools is ignored when tools whitelist is set", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write", "grep"],
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });
    expect(result).toEqual(["read", "bash"]);
  });

  it("returns null when no filtering needed (excludeTools doesn't match any active)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toBeNull();
  });

  it("returns [] when excludeTools removes all non-excluded active tools", () => {
    const result = resolveVisibleTools({
      activeTools: ["Agent", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  tools: true / false / undefined                                   */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — tools: true/false/undefined", () => {
  it("tools: true — all tools visible except EXCLUDED_TOOL_NAMES", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "Agent"],
      tools: true,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("Agent");
  });

  it("tools: true, no excluded tools in active — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: true,
    });
    expect(result).toBeNull();
  });

  it("tools: false — returns []", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: false,
    });
    expect(result).toEqual([]);
  });

  it("tools: undefined, no excluded tools — returns null", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit"],
      tools: undefined,
    });
    expect(result).toBeNull();
  });

  it("tools: undefined with Agent in activeTools — returns filtered list", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "Agent"],
      tools: undefined,
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).not.toContain("Agent");
  });

  it("tools: undefined with excludeTools — applies denylist", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "edit", "write"],
      tools: undefined,
      excludeTools: ["write"],
    });
    expect(result).toContain("read");
    expect(result).toContain("bash");
    expect(result).toContain("edit");
    expect(result).not.toContain("write");
  });
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                        */
/* ------------------------------------------------------------------ */

describe("resolveVisibleTools — edge cases", () => {
  it("empty activeTools with whitelist returns []", () => {
    const result = resolveVisibleTools({
      activeTools: [],
      tools: ["read"],
    });
    expect(result).toEqual([]);
  });

  it("notify is optional (no crash when omitted)", () => {
    expect(() => {
      resolveVisibleTools({
        activeTools: ["read"],
        tools: ["foobar"],
      });
    }).not.toThrow();
  });

  it("extToolMap is optional (no crash when omitted)", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read"],
    });
    expect(result).toEqual(["read"]);
  });
});

/* ------------------------------------------------------------------ */
/*  getConfig with global implicit defaults                           */
/* ------------------------------------------------------------------ */

describe("getConfig — global implicit defaults", () => {
  beforeEach(() => {
    const agents = new Map<string, AgentConfig>();
    agents.set("test-agent", {
      name: "test-agent",
      description: "Test agent",
      extensions: true,
      skills: true,
      systemPrompt: "test",
    });
    agents.set("implicit-agent", {
      name: "implicit-agent",
      description: "Agent with no skills/extensions set",
      systemPrompt: "test",
    });
    agents.set("explicit-skills", {
      name: "explicit-skills",
      description: "Agent with explicit skills list",
      // extensions intentionally omitted — uses global default
      skills: ["tdd"],
      systemPrompt: "test",
    });
    agents.set("explicit-tools", {
      name: "explicit-tools",
      description: "Agent with explicit tools",
      registeredTools: ["read", "bash", "grep"],
      systemPrompt: "test",
    });
    agents.set("no-skills", {
      name: "no-skills",
      description: "Agent with skills disabled",
      extensions: false,
      skills: false,
      systemPrompt: "test",
    });
    registerAgents(agents);
  });

  it("agent with explicit skills: true ignores global loadSkillsImplicitly=false", () => {
    const result = getConfig("test-agent", false, true);
    expect(result.skills).toBe(true);
  });

  it("agent with explicit extensions: true ignores global loadExtensionsImplicitly=false", () => {
    const result = getConfig("test-agent", true, false);
    expect(result.extensions).toBe(true);
  });

  it("agent with no skills/extensions uses global default (false)", () => {
    const result = getConfig("implicit-agent", false, false);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("agent with no skills/extensions uses global default (true)", () => {
    const result = getConfig("implicit-agent", true, true);
    expect(result.skills).toBe(true);
    expect(result.extensions).toBe(true);
  });

  it("agent with skills: true gets global loadSkillsImplicitly=true", () => {
    const result = getConfig("test-agent", true, true);
    expect(result.skills).toBe(true);
  });

  it("agent with explicit skills list ignores global default", () => {
    const result = getConfig("explicit-skills", false, false);
    expect(result.skills).toEqual(["tdd"]);
    // extensions not explicitly set, so global default false applies
    expect(result.extensions).toBe(false);
  });

  it("agent with skills: false ignores global default", () => {
    const result = getConfig("no-skills", true, true);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type uses global defaults", () => {
    const result = getConfig("nonexistent", false, false);
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type with load-all defaults to true", () => {
    const result = getConfig("nonexistent", true, true);
    expect(result.skills).toBe(true);
    expect(result.extensions).toBe(true);
  });

  it("registeredTools defaults to DEFAULT_ACTIVE_TOOL_NAMES when not explicitly set", () => {
    const result = getConfig("implicit-agent");
    expect(result.registeredTools).toEqual(DEFAULT_ACTIVE_TOOL_NAMES);
  });

  it("registeredTools uses explicit value when set", () => {
    const result = getConfig("explicit-tools");
    expect(result.registeredTools).toEqual(["read", "bash", "grep"]);
  });
});

/* ------------------------------------------------------------------ */
/*  getToolNamesForType                                              */
/* ------------------------------------------------------------------ */

describe("getToolNamesForType", () => {
  beforeEach(() => {
    const agents = new Map<string, AgentConfig>();
    agents.set("test-agent", {
      name: "test-agent",
      description: "Test agent",
      systemPrompt: "test",
    });
    agents.set("explicit-tools", {
      name: "explicit-tools",
      description: "Agent with explicit tools",
      registeredTools: ["read", "bash"],
      systemPrompt: "test",
    });
    registerAgents(agents);
  });

  it("returns DEFAULT_ACTIVE_TOOL_NAMES for agent with no explicit registeredTools", () => {
    const result = getToolNamesForType("test-agent");
    expect(result).toEqual(DEFAULT_ACTIVE_TOOL_NAMES);
  });

  it("returns explicit registeredTools when set", () => {
    const result = getToolNamesForType("explicit-tools");
    expect(result).toEqual(["read", "bash"]);
  });

  it("returns DEFAULT_ACTIVE_TOOL_NAMES for unknown agent type", () => {
    const result = getToolNamesForType("nonexistent");
    expect(result).toEqual(DEFAULT_ACTIVE_TOOL_NAMES);
  });
});

/* ------------------------------------------------------------------ */
/*  resolveSessionAllowedTools                                         */
/* ------------------------------------------------------------------ */

describe("resolveSessionAllowedTools", () => {
  const builtins = ["read", "bash", "edit"];
  const extToolMap = new Map<string, string[]>([
    ["tavily", ["web_search", "web_extract", "web_crawl"]],
    ["exa", ["exa_search"]],
  ]);

  it("tools: false — no tools allowed", () => {
    expect(resolveSessionAllowedTools({ registeredTools: builtins, tools: false, extToolMap })).toEqual([]);
  });

  it("tools: string[] — only whitelisted builtins and extension tools register (no leak)", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
    });
    expect(result).toEqual(expect.arrayContaining(["read", "web_search", "web_extract", "web_crawl", "exa_search"]));
    expect(result).toHaveLength(5);
    // Builtins not in the whitelist must NOT leak into the registry gate.
    expect(result).not.toContain("bash");
    expect(result).not.toContain("edit");
  });

  it("tools: string[] with ext/tool entry — expands to the bare tool name", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/web_search"],
      extToolMap,
    });
    expect(result).toContain("web_search");
    expect(result).not.toContain("web_extract");
  });

  it("tools: string[] with ext/* for an unloaded extension — resolves to nothing (silent)", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "ghost/*"],
      extToolMap,
    });
    expect(result).toEqual(["read"]);
  });

  it("tools: true — builtins plus every loaded extension tool", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: true,
      extToolMap,
    });
    expect(result).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "web_search", "web_extract", "web_crawl", "exa_search"]),
    );
    expect(result).toHaveLength(7);
  });

  it("tools: undefined — behaves like tools: true", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: undefined,
      extToolMap,
    });
    expect(result).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "web_search", "web_extract", "web_crawl", "exa_search"]),
    );
  });

  it("excludes EXCLUDED_TOOL_NAMES so the Agent tool never enters the registry", () => {
    const withAgent = new Map(extToolMap);
    withAgent.set("subagents", ["Agent"]);
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: true,
      extToolMap: withAgent,
    });
    expect(result).not.toContain("Agent");
  });

  it("tools: string[] with no extToolMap — bare whitelisted builtins only", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: builtins,
      tools: ["read", "tavily/*"],
    });
    // No extToolMap means "tavily/*" can't expand; only the bare "read" registers.
    expect(result).toEqual(["read"]);
  });
  it("raw wildcard literals never reach pi as bogus allowedToolNames", () => {
    const result = resolveSessionAllowedTools({
      registeredTools: ["read", "tavily/*"],
      tools: ["read", "tavily/*"],
      extToolMap,
    });
    expect(result).not.toContain("tavily/*");
    expect(result).toContain("web_search");
  });
});
