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
  EXCLUDED_TOOL_NAMES,
  BUILTIN_TOOL_NAMES,
  getConfig,
  registerAgents,
} from "../src/agents/agent-types.js";
import type { AgentConfig } from "../src/types.ts";

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

  it("includes core built-in tools", () => {
    expect(BUILTIN_TOOL_NAMES).toContain("read");
    expect(BUILTIN_TOOL_NAMES).toContain("bash");
    expect(BUILTIN_TOOL_NAMES).toContain("edit");
    expect(BUILTIN_TOOL_NAMES).toContain("write");
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
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('tool "foobar" not found in any loaded extension'),
    );
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
    // Should NOT warn about tavily having no tools in tools (ext/* covers it)
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
    // tools whitelist wins — only read and bash
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
    // Register a test agent with skills: true and extensions: true
    const agents = new Map<string, AgentConfig>();
    agents.set("test-agent", {
      name: "test-agent",
      description: "Test agent",
      extensions: true,
      skills: true,
      systemPrompt: "test",
    });
    agents.set("explicit-skills", {
      name: "explicit-skills",
      description: "Agent with explicit skills list",
      extensions: true,
      skills: ["tdd"],
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

  it("agent with skills: true gets global loadSkillsImplicitly=none → false", () => {
    const result = getConfig("test-agent", "none", "load-all");
    expect(result.skills).toBe(false);
  });

  it("agent with extensions: true gets global loadExtensionsImplicitly=none → false", () => {
    const result = getConfig("test-agent", "load-all", "none");
    expect(result.extensions).toBe(false);
  });

  it("agent with skills: true gets global loadSkillsImplicitly=load-all → true", () => {
    const result = getConfig("test-agent", "load-all", "load-all");
    expect(result.skills).toBe(true);
  });

  it("agent with explicit skills list ignores global default", () => {
    const result = getConfig("explicit-skills", "none", "none");
    expect(result.skills).toEqual(["tdd"]);
    expect(result.extensions).toBe(false);
  });

  it("agent with skills: false ignores global default", () => {
    const result = getConfig("no-skills", "load-all", "load-all");
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type uses global defaults", () => {
    const result = getConfig("nonexistent", "none", "none");
    expect(result.skills).toBe(false);
    expect(result.extensions).toBe(false);
  });

  it("unknown agent type with load-all defaults to true", () => {
    const result = getConfig("nonexistent", "load-all", "load-all");
    expect(result.skills).toBe(true);
    expect(result.extensions).toBe(true);
  });
});
