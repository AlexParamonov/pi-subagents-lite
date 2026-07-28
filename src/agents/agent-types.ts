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
let sharedAgentDir = "";

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
export function setAgentScanDirs(userDir: string, projectDir: string, sharedDir?: string): void {
  userAgentDir = userDir;
  projectAgentDir = projectDir;
  sharedAgentDir = sharedDir ?? "";
}

/** Scan user, shared, and project agent directories, merge with defaults. Returns the merged Map. */
export async function scanAndMerge(options?: { disableDefaultAgents?: boolean }): Promise<Map<string, AgentConfig>> {
  const [userAgents, sharedAgents, projectAgents] = await Promise.all([
    scanAgentFilesInDir(userAgentDir, "user"),
    scanAgentFilesInDir(sharedAgentDir, "project"),
    scanAgentFilesInDir(projectAgentDir, "project"),
  ]);
  const defaults = options?.disableDefaultAgents ? new Map<string, AgentConfig>() : DEFAULT_AGENTS;
  return mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
}
/**
 * Scan the parent directories and refresh the global registry. Worktree
 * definitions deliberately never pass through this function: a worktree is a
 * spawn-local overlay, not session-global state. Returns the number of names
 * newly added to the parent registry.
 */
export async function discoverNewAgents(options?: RegisterAgentsOptions): Promise<number> {
  const discovered = await scanAndMerge(options);
  const previousNames = new Set(agents.keys());
  agents.clear();
  for (const [name, config] of discovered) {
    agents.set(name, config);
  }
  return [...discovered.keys()].filter((name) => !previousNames.has(name)).length;
}

/** Resolve a type name in an explicit registry without reading global state. */
export function resolveTypeInCatalog(availableAgents: ReadonlyMap<string, AgentConfig>, name: string): string | undefined {
  if (!name) return undefined;
  if (availableAgents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const [key, config] of availableAgents.entries()) {
    if (key.toLowerCase() === lower) return key;
    if ((config.displayName ?? "").toLowerCase() === lower) return key;
  }
  return undefined;
}

/**
 * Build a fresh, local registry for one worktree. This never mutates the
 * parent registry, so concurrent worktree spawns cannot observe each other's
 * partial overlays.
 */
export async function discoverWorktreeAgents(
  worktreeDir: string,
  options?: RegisterAgentsOptions,
): Promise<Map<string, AgentConfig>> {
  const [parentMerged, worktreeAgents] = await Promise.all([
    scanAndMerge(options),
    scanAgentFilesInDir(worktreeDir, "project"),
  ]);
  return mergeAgents(parentMerged, [], [], worktreeAgents);
}

/** Build an invocation-local catalog, optionally overlaid with a trusted worktree directory. */
export async function resolveAgentCatalog(
  trustedWorktreeDir?: string,
  options?: RegisterAgentsOptions,
): Promise<Map<string, AgentConfig>> {
  return trustedWorktreeDir
    ? discoverWorktreeAgents(trustedWorktreeDir, options)
    : scanAndMerge(options);
}

/** A canonical type plus its worktree-local, fully merged configuration. */
export interface WorktreeAgentResolution {
  type: string;
  config: AgentConfig;
}

/**
 * Resolve an agent against a fresh parent merge plus one worktree overlay.
 * The returned configuration belongs solely to this resolution and must be
 * carried by the spawn rather than looked up in the mutable global registry.
 */
export async function resolveWorktreeAgent(
  name: string,
  worktreeDir: string,
  options?: RegisterAgentsOptions,
): Promise<WorktreeAgentResolution | undefined> {
  const localAgents = await discoverWorktreeAgents(worktreeDir, options);
  const type = resolveTypeInCatalog(localAgents, name);
  return type ? { type, config: localAgents.get(type)! } : undefined;
}

/** Return a detached config snapshot safe to retain while a run is queued. */
export function snapshotAgentConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    preloadSkills: Array.isArray(config.preloadSkills) ? [...config.preloadSkills] : config.preloadSkills,
  };
}

/** Resolve a type name case-insensitively. Also matches displayName. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveTypeInCatalog(agents, name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveType(name);
  return key ? agents.get(key) : undefined;
}

/** Get visible agent configs in registry order. */
export function getAvailableAgents(): Array<{ name: string; description: string }> {
  return [...agents.entries()]
    .filter(([, config]) => config.hidden !== true)
    .map(([name, config]) => ({ name, description: config.description }));
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

/**
 * Resolve the concrete tool names that may enter the session's tool registry.
 *
 * Pi's createAgentSession treats `tools` as an allowlist gate: any tool not
 * listed is filtered out of the registry AND the active set, so a whitelist of
 * built-in names alone silently drops every extension tool. This expands the
 * agent's tool config into concrete names (builtins + referenced extension
 * tools) so pi registers them. Final visibility is still owned by
 * resolveVisibleTools; this only seeds the registry gate.
 */
export function resolveSessionAllowedTools(opts: {
  registeredTools: string[];
  tools?: true | string[] | false;
  extToolMap?: Map<string, string[]>;
}): string[] {
  if (opts.tools === false) return [];

  // tools is a whitelist: the gate is exactly its expansion. Builtins and
  // extension tools are gated alike (a builtin not listed is NOT registered),
  // and raw wildcard entries ("tavily/*") never leak as bogus allowedToolNames.
  // registeredTools is not a base here.
  if (Array.isArray(opts.tools)) {
    return [...resolveToolEntries(opts.tools, opts.extToolMap)]
      .filter(t => !EXCLUDED_TOOL_NAMES.includes(t));
  }

  // No whitelist (true | undefined): register everything available so
  // resolveVisibleTools can select freely.
  const extTools = opts.extToolMap ? [...opts.extToolMap.values()].flat() : [];
  const names = new Set(opts.registeredTools);
  for (const t of extTools) {
    if (!EXCLUDED_TOOL_NAMES.includes(t)) names.add(t);
  }
  return [...names];
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string, configOverride?: AgentConfig): string[] {
  const config = configOverride ?? getAgentConfig(type);
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

/** Resolve an already-selected agent definition without consulting the registry. */
export function resolveAgentConfig(
  config: AgentConfig,
  loadSkillsImplicitly: boolean = true,
  loadExtensionsImplicitly: boolean = true,
): ResolvedAgentConfig {
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

/** Get config for an explicitly selected type (case-insensitive). */
export function getConfig(
  type: string,
  loadSkillsImplicitly: boolean = true,
  loadExtensionsImplicitly: boolean = true,
): ResolvedAgentConfig {
  const config = getAgentConfig(type);
  if (!config) {
    throw new Error(`Unknown agent type: ${type || "(missing)"}`);
  }
  return resolveAgentConfig(config, loadSkillsImplicitly, loadExtensionsImplicitly);
}
