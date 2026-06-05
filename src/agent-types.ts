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
 * `grep` must be explicitly activated via setActiveToolsByName().
 * `find` and `ls` were removed — they're thin wrappers over bash commands
 * that add ~180 tokens/turn with no real benefit.
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

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Hidden agents (hidden === true) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  // Start with defaults
  for (const [name, config] of DEFAULT_AGENTS) {
    agents.set(name, config);
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

/**
 * Scan the known agent directories and register any newly discovered agents
 * that aren't already in the registry. Returns the number of new agents added.
 *
 * @param worktreeDir - Optional absolute path to a worktree's `.pi/agents/` directory.
 *   When set, agents from this directory are also scanned and added to the registry.
 *   Worktree-local types use "project" source attribution and follow the same
 *   parsing and name-uniqueness rules as the parent's project scan.
 */
export async function discoverNewAgents(worktreeDir?: string): Promise<number> {
  const [userAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);

  const merged = mergeAgents(DEFAULT_AGENTS, userAgents, projectAgents);

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
    // Use mergeAgents to convert AgentConfigFromMd to AgentConfig (applies fromMd
    // and BASE_DEFAULTS), then add only names not already in the registry.
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

function toResolved(config: AgentConfig): ResolvedAgentConfig {
  return {
    displayName: config.displayName ?? config.name,
    description: config.description,
    registeredTools: config.registeredTools ?? BUILTIN_TOOL_NAMES,
    tools: config.tools,
    extensions: config.extensions,
    skills: config.skills,
  };
}

/** Get config for a type (case-insensitive). Falls back to general-purpose. */
export function getConfig(type: string): ResolvedAgentConfig {
  const resolvedKey = resolveType(type);
  const config = resolvedKey ? agents.get(resolvedKey) : undefined;

  // If config exists and is not hidden, use it; otherwise fall back to general-purpose
  const activeConfig = config?.hidden !== true
    ? config
    : agents.get("general-purpose");

  if (activeConfig && activeConfig.hidden !== true) {
    return toResolved(activeConfig);
  }

  // Absolute fallback — general-purpose was hidden or missing
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    registeredTools: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
  };
}
