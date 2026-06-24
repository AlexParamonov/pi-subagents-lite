/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { scanAgentFilesInDir, mergeAgents } from "./agent-discovery.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/**
 * All tool names that Pi can provide to a session.
 *
 * Note: only `read`, `bash`, `edit`, `write` are active by default.
 * `find` and `grep` must be explicitly activated via setActiveToolsByName().
 * `ls` was removed — it's a thin wrapper over bash that adds ~180 tokens/turn
 * with no real benefit.
 */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find"];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Directories to scan for agent .md files at startup and on-demand.
 * Set by setAgentScanDirs() during session_start.
 */
let userAgentDir = "";
let projectAgentDir = "";

/** Options for registerAgents. */
export interface RegisterAgentsOptions {
  /** When true, skip built-in DEFAULT_AGENTS. */
  disableDefaultAgents?: boolean;
}

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * When options.disableDefaultAgents is true, DEFAULT_AGENTS are skipped.
 * Hidden agents (hidden === true) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>, options?: RegisterAgentsOptions): void {
  agents.clear();

  // Start with defaults (unless disabled)
  if (!options?.disableDefaultAgents) {
    for (const [name, config] of DEFAULT_AGENTS) {
      agents.set(name, config);
    }
  }

  // Overlay user agents (overrides defaults with same name)
  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/**
 * Set the agent scan directories for on-demand discovery.
 * Called during session_start alongside scanAndRegisterAgents.
 */
export function setAgentScanDirs(userDir: string, projectDir: string): void {
  userAgentDir = userDir;
  projectAgentDir = projectDir;
}

/** Scan user and project agent directories, merge with defaults. Returns the merged Map. */
async function scanAndMerge(options?: { disableDefaultAgents?: boolean }): Promise<Map<string, AgentConfig>> {
  const [userAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);
  const defaults = options?.disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
  return mergeAgents(defaults, userAgents, projectAgents);
}
/**
 * Scan the known agent directories and register any newly discovered agents
 * that aren't already in the registry. Returns the number of new agents added.
 *
 * @param worktreeDir - Optional absolute path to a worktree's `.pi/agents/` directory.
 *   When set, agents from this directory are also scanned and added to the registry.
 *   Worktree-local types use "project" source attribution and follow the same
 *   parsing and name-uniqueness rules as the parent's project scan.
 * @param options - Optional settings. disableDefaultAgents skips DEFAULT_AGENTS in the merge.
 */
export async function discoverNewAgents(worktreeDir?: string, options?: { disableDefaultAgents?: boolean }): Promise<number> {
  const merged = await scanAndMerge(options);

  let count = 0;
  for (const [name, config] of merged) {
    if (!agents.has(name)) {
      agents.set(name, config);
      count++;
    }
  }

  // Scan worktree-local agents (only when worktreeDir is provided)
  if (worktreeDir) {
    const worktreeAgents = await scanAgentFilesInDir(worktreeDir, "project");
    const wtMerged = mergeAgents(new Map(), [], worktreeAgents);
    for (const [name, config] of wtMerged) {
      if (!agents.has(name)) {
        agents.set(name, config);
        count++;
      }
    }
  }

  return count;
}

/** Resolve a type name case-insensitively. Also matches displayName. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  if (!name) return undefined;
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const [key, config] of agents.entries()) {
    if (key.toLowerCase() === lower) return key;
    if ((config.displayName ?? '').toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveType(name);
  return key ? agents.get(key) : undefined;
}

/** Get all visible type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.hidden !== true)
    .map(([name]) => name);
}

/** Get all type names including hidden (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Names of tools that subagents must NOT inherit (no sub-subagent policy, ADR 0001). */
export const EXCLUDED_TOOL_NAMES = ["Agent"];

/**
 * Resolve tool entries (with ext/* syntax) into concrete tool names.
 * Supports:
 *   - bare tool names: "read" → "read"
 *   - ext/* syntax: "tavily/*" → all tools from the tavily extension
 *   - ext/tool syntax: "tavily/web_search" → "web_search"
 */
function resolveToolEntries(
  entries: string[],
  extToolMap: Map<string, string[]> | undefined,
  notify?: (msg: string) => void,
): Set<string> {
  const resolved = new Set<string>();

  for (const entry of entries) {
    const slashIdx = entry.indexOf("/");
    if (slashIdx !== -1) {
      // ext/* or ext/tool syntax
      const extName = entry.slice(0, slashIdx);
      const toolPart = entry.slice(slashIdx + 1);
      if (toolPart === "*") {
        const extTools = extToolMap?.get(extName);
        if (extTools && extTools.length > 0) {
          for (const t of extTools) resolved.add(t);
        } else {
          notify?.(`extension "${extName}" is not loaded, "${entry}" will have no effect`);
        }
      } else {
        // ext/tool syntax: e.g. "tavily/web_search"
        resolved.add(toolPart);
      }
    } else {
      // Bare tool name
      resolved.add(entry);
    }
  }

  return resolved;
}

/**
 * Resolve the visible tool set for an agent type from its config.
 *
 * Single owner of tool visibility policy. Handles:
 *   - `tools: true` → all active tools (minus excluded)
 *   - `tools: string[]` → allowlist (minus excluded, with ext/* expansion)
 *   - `tools: false` → no tools
 *   - `tools: undefined` + `excludeTools` → denylist (minus excluded, with ext/* expansion)
 *   - `tools: undefined` → all active tools (minus EXCLUDED_TOOL_NAMES if any are present)
 *
 * `tools` and `excludeTools` are mutually exclusive. If both set, `tools` wins.
 *
 * Returns null when no filtering is needed, otherwise the filtered tool list.
 */
export function resolveVisibleTools(opts: {
  activeTools: string[];
  tools?: true | string[] | false;
  excludeTools?: string[];
  extToolMap?: Map<string, string[]>;
  notify?: (msg: string) => void;
}): string[] | null {
  const { activeTools, tools, excludeTools, extToolMap, notify } = opts;

  // Blacklist mode: excludeTools set and tools not set as whitelist
  if (excludeTools && !Array.isArray(tools)) {
    const excludeSet = resolveToolEntries(excludeTools, extToolMap, notify);
    const filtered = activeTools.filter(t =>
      !EXCLUDED_TOOL_NAMES.includes(t) && !excludeSet.has(t)
    );
    return filtered.length !== activeTools.length ? filtered : null;
  }

  if (Array.isArray(tools)) {
    // Whitelist mode: resolve entries with ext/* expansion
    const allBuiltinSet = new Set(BUILTIN_TOOL_NAMES);
    const allowedTools = resolveToolEntries(tools, extToolMap, notify);

    // Warn about unknown entries
    for (const entry of tools) {
      const slashIdx = entry.indexOf("/");
      if (slashIdx === -1 && !allBuiltinSet.has(entry)) {
        // Bare name, not a known built-in — check if it's an extension tool
        let foundInExt = false;
        for (const [, extToolNames] of extToolMap ?? []) {
          if (extToolNames.includes(entry)) { foundInExt = true; break; }
        }
        if (!foundInExt) {
          notify?.(`tool "${entry}" not found in any loaded extension`);
        }
      }
    }

    const visibleSet = new Set<string>();
    for (const t of activeTools) {
      if (EXCLUDED_TOOL_NAMES.includes(t)) continue;
      if (allowedTools.has(t)) {
        visibleSet.add(t);
      }
    }

    // Warn if a loaded extension has none of its tools in `tools`
    if (extToolMap) {
      for (const [extName, extTools] of extToolMap) {
        const hasAny = extTools.some(t => allowedTools.has(t));
        if (!hasAny) {
          notify?.(`extension "${extName}" is loaded but none of its tools are in tools: [${tools.join(", ")}]`);
        }
      }
    }

    return [...visibleSet];
  }

  if (tools === false) {
    return [];
  }

  // tools: true or undefined — all tools visible (except excluded)
  const hasExcluded = activeTools.some(t => EXCLUDED_TOOL_NAMES.includes(t));
  if (!hasExcluded) return null;
  return activeTools.filter(t => !EXCLUDED_TOOL_NAMES.includes(t));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const config = getAgentConfig(type);
  return config?.registeredTools?.length
    ? config.registeredTools
    : [...BUILTIN_TOOL_NAMES];
}

/** Resolved config shape returned by getConfig. */
export interface ResolvedAgentConfig {
  displayName: string;
  description: string;
  registeredTools: string[];
  /** Controls tool schema visibility. true = all, string[] = listed, false = none. */
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/**
 * Apply global implicit defaults to skills/extensions.
 * undefined means "not explicitly set" → resolve from global default.
 * Concrete values (true, false, string[]) pass through unchanged.
 */
function applyGlobalDefaults(
  skills: true | string[] | false | undefined,
  extensions: true | string[] | false | undefined,
  loadSkillsImplicitly: boolean,
  loadExtensionsImplicitly: boolean,
): { skills: true | string[] | false; extensions: true | string[] | false } {
  return {
    skills: skills === undefined ? loadSkillsImplicitly : skills,
    extensions: extensions === undefined ? loadExtensionsImplicitly : extensions,
  };
}

/** Find the first non-hidden config: resolved type, then general-purpose, then undefined. */
function findActiveConfig(type: string): AgentConfig | undefined {
  const key = resolveType(type);
  const config = key ? agents.get(key) : undefined;
  if (config?.hidden !== true) return config;
  return agents.get("general-purpose");
}

/** Get config for a type (case-insensitive). Falls back to general-purpose. */
export function getConfig(
  type: string,
  loadSkillsImplicitly: boolean = true,
  loadExtensionsImplicitly: boolean = true,
): ResolvedAgentConfig {
  const config = findActiveConfig(type);
  if (config) {
    const { skills, extensions, ...rest } = config;
    const defaults = applyGlobalDefaults(skills, extensions, loadSkillsImplicitly, loadExtensionsImplicitly);
    return {
      displayName: rest.displayName ?? rest.name,
      description: rest.description,
      registeredTools: rest.registeredTools ?? BUILTIN_TOOL_NAMES,
      tools: rest.tools,
      ...defaults,
    };
  }

  // Absolute fallback — no config found at all
  const defaults = applyGlobalDefaults(undefined, undefined, loadSkillsImplicitly, loadExtensionsImplicitly);
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    registeredTools: BUILTIN_TOOL_NAMES,
    ...defaults,
  };
}
