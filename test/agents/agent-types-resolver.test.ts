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
  resolveSessionToolOptions,
  getConfig,
  registerAgents,
} from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

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

  it("always excludes the Agent tool (no sub-subagent policy)", () => {
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
  it("recognizes read, bash, edit, and write as built-ins without a not-found warning", () => {
    const notify = vi.fn();
    for (const tool of ["read", "bash", "edit", "write"]) {
      const result = resolveVisibleTools({
        activeTools: [tool],
        tools: [tool],
        notify,
      });
      expect(result).toEqual([tool]);
      expect(notify).not.toHaveBeenCalled();
    }
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

  it("always excludes the Agent tool (no sub-subagent policy)", () => {
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
  it("tools: true — all tools visible except Agent", () => {
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

  it("registeredTools passes the explicit value through when set", () => {
    const result = getConfig("explicit-tools");
    expect(result.registeredTools).toEqual(["read", "bash", "grep"]);
  });

  it("registeredTools stays absent when the config is silent — pi owns the fallback", () => {
    const result = getConfig("implicit-agent");
    expect(result.registeredTools).toBeUndefined();
  });

  it("unknown agent type leaves registeredTools absent — no hardcoded fallback", () => {
    const result = getConfig("nonexistent");
    expect(result.registeredTools).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  resolveSessionToolOptions                                         */
/* ------------------------------------------------------------------ */

describe("resolveSessionToolOptions", () => {
  const extToolMap = new Map<string, string[]>([
    ["tavily", ["web_search", "web_extract", "web_crawl"]],
    ["exa", ["exa_search"]],
  ]);

  it("tools: false — empty registry gate in both implicit modes", () => {
    expect(resolveSessionToolOptions({ tools: false, loadToolsImplicitly: true })).toEqual({ tools: [] });
    expect(resolveSessionToolOptions({ tools: false, loadToolsImplicitly: false })).toEqual({ tools: [] });
  });

  it("tools: string[] — only whitelisted builtins and extension tools register (no leak)", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "tavily/*", "exa_search"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toEqual(expect.arrayContaining(["read", "web_search", "web_extract", "web_crawl", "exa_search"]));
    expect(result.tools).toHaveLength(5);
    // Builtins not in the whitelist must NOT leak into the registry gate.
    expect(result.tools).not.toContain("bash");
    expect(result.tools).not.toContain("edit");
    expect(result.noTools).toBeUndefined();
  });

  it("tools: string[] with ext/tool entry — expands to the bare tool name", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "tavily/web_search"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toContain("web_search");
    expect(result.tools).not.toContain("web_extract");
  });

  it("tools: string[] with ext/* for an unloaded extension — resolves to nothing (silent)", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "ghost/*"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toEqual(["read"]);
  });

  it("excludes the Agent tool so it never enters the registry", () => {
    const withAgent = new Map(extToolMap);
    withAgent.set("subagents", ["Agent"]);
    const result = resolveSessionToolOptions({
      tools: true,
      extToolMap: withAgent,
      loadToolsImplicitly: true,
    });
    expect(result).toEqual({});
  });

  it("tools: string[] with no extToolMap — bare whitelisted builtins only", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "tavily/*"],
      loadToolsImplicitly: true,
    });
    // No extToolMap means "tavily/*" can't expand; only the bare "read" registers.
    expect(result.tools).toEqual(["read"]);
  });

  it("raw wildcard literals never reach pi as bogus allowedToolNames", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "tavily/*"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).not.toContain("tavily/*");
    expect(result.tools).toContain("web_search");
  });

  it("explicit registeredTools becomes the session gate (union with loaded extension tools)", () => {
    const result = resolveSessionToolOptions({
      registeredTools: ["read", "bash", "grep"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toEqual(expect.arrayContaining(["read", "bash", "grep", "web_search", "exa_search"]));
    expect(result.noTools).toBeUndefined();
  });

  it("explicit registeredTools gates the same with implicit loading OFF", () => {
    const result = resolveSessionToolOptions({
      registeredTools: ["read", "bash"],
      loadToolsImplicitly: false,
    });
    expect(result.tools).toEqual(["read", "bash"]);
  });

  it("explicit registeredTools excludes the Agent tool", () => {
    const withAgent = new Map([["subagents", ["Agent"]]]);
    const result = resolveSessionToolOptions({
      registeredTools: ["read"],
      extToolMap: withAgent,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toEqual(["read"]);
  });

  it("explicit registeredTools [] is a zero-tool gate, not a fallback trigger", () => {
    expect(resolveSessionToolOptions({ registeredTools: [], loadToolsImplicitly: true })).toEqual({ tools: [] });
    expect(resolveSessionToolOptions({ registeredTools: [], loadToolsImplicitly: false })).toEqual({ tools: [] });
  });

  it("no frontmatter tool fields + implicit ON — no override, pi applies defaultTools", () => {
    expect(resolveSessionToolOptions({ loadToolsImplicitly: true })).toEqual({});
    expect(resolveSessionToolOptions({ tools: undefined, extToolMap, loadToolsImplicitly: true })).toEqual({});
  });

  it("no frontmatter tool fields + implicit OFF — noTools: all", () => {
    expect(resolveSessionToolOptions({ loadToolsImplicitly: false })).toEqual({ noTools: "all" });
    expect(resolveSessionToolOptions({ tools: undefined, extToolMap, loadToolsImplicitly: false })).toEqual({
      noTools: "all",
    });
  });

  it("tools: true is explicit — pi's standard selection applies in both implicit modes", () => {
    expect(resolveSessionToolOptions({ tools: true, loadToolsImplicitly: true })).toEqual({});
    expect(resolveSessionToolOptions({ tools: true, loadToolsImplicitly: false })).toEqual({});
  });

  it("mutually exclusive: tools wins over registeredTools", () => {
    const result = resolveSessionToolOptions({
      registeredTools: ["read", "bash", "grep"],
      tools: ["edit"],
      loadToolsImplicitly: true,
    });
    expect(result.tools).toEqual(["edit"]);
  });
});

/* ------------------------------------------------------------------ */
/*  ext/none — suppress warning without registering tools              */
/* ------------------------------------------------------------------ */

describe("ext/none — warning suppression", () => {
  const extToolMap = new Map<string, string[]>([
    ["tavily", ["web_search", "web_extract", "web_crawl"]],
    ["exa", ["exa_search"]],
  ]);

  it("ext/none suppresses the warning for that extension", () => {
    const notify = vi.fn();
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/none"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(result).not.toContain("web_search");
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("ext/none adds no tools to the result", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash", "web_search"],
      tools: ["read", "tavily/none"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).not.toContain("web_search");
    expect(result).not.toContain("none");
  });

  it("warning still fires for extensions not in the tools list", () => {
    const notify = vi.fn();
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/none"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('extension "exa" is loaded but none of its tools are in tools'),
    );
  });

  it("ext/none does not leak 'none' as a tool name", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["tavily/none"],
      extToolMap,
    });
    expect(result).not.toContain("none");
  });

  it("multiple ext/none entries suppress warnings for each extension", () => {
    const notify = vi.fn();
    const result = resolveVisibleTools({
      activeTools: ["read", "bash"],
      tools: ["read", "tavily/none", "exa/none"],
      extToolMap,
      notify,
    });
    expect(result).toContain("read");
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
    expect(notify).not.toHaveBeenCalledWith(
      expect.stringContaining('extension "exa" is loaded but none of its tools are in tools'),
    );
  });

  it("ext/none combined with ext/* still works", () => {
    const result = resolveVisibleTools({
      activeTools: ["read", "web_search", "web_extract", "web_crawl"],
      tools: ["read", "tavily/*", "exa/none"],
      extToolMap,
    });
    expect(result).toContain("read");
    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("web_crawl");
  });

  it("ext/none with the session gate does not leak 'none'", () => {
    const result = resolveSessionToolOptions({
      tools: ["read", "tavily/none"],
      extToolMap,
      loadToolsImplicitly: true,
    });
    expect(result.tools).toContain("read");
    expect(result.tools).not.toContain("none");
  });
});
