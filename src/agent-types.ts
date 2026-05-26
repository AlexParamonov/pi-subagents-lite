/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 *
 * Trimmed from upstream: removed getMemoryToolNames(), getReadOnlyMemoryToolNames(),
 * MEMORY_TOOL_NAMES, READONLY_MEMORY_TOOL_NAMES (memory feature cut).
 */

import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/** All known built-in tool names. */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
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

/** Case-insensitive key resolution, also matches displayName. */
function resolveKey(name: string): string | undefined {
  if (!name) return undefined;
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const [key, config] of agents.entries()) {
    if (key.toLowerCase() === lower) return key;
    if ((config.displayName ?? '').toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const config = getAgentConfig(type);
  return config !== undefined && config.enabled !== false;
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const config = getAgentConfig(type);
  return config?.builtinToolNames?.length
    ? config.builtinToolNames
    : [...BUILTIN_TOOL_NAMES];
}

/** Convert an AgentConfig to the SubagentTypeConfig shape used by getConfig. */
function toSubagentTypeConfig(config: AgentConfig): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
} {
  return {
    displayName: config.displayName ?? config.name,
    description: config.description,
    builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
    extensions: config.extensions,
    skills: config.skills,
  };
}

/** Get config for a type (case-insensitive). Falls back to general-purpose. */
export function getConfig(type: string): ReturnType<typeof toSubagentTypeConfig> {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;

  const activeConfig = (config?.enabled !== false)
    ? config
    : agents.get("general-purpose");

  if (activeConfig && activeConfig.enabled !== false) {
    return toSubagentTypeConfig(activeConfig);
  }

  // Absolute fallback — general-purpose was disabled or missing
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
  };
}
