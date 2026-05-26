/**
 * agent-discovery.ts — Agent file discovery, parsing, and config merging.
 *
 * Extended from subagent-lazy/agent-discovery.ts with full frontmatter support.
 *
 * Scans:
 *   ~/.pi/agent/agents/*.md   (user agents)
 *   <project>/.pi/agents/*.md (project agents)
 *
 * Parses YAML frontmatter, extracts all fields, produces AgentConfig objects.
 * Merges with per-field precedence: default < user < project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, ThinkingLevel } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
] as const;

/** Validate and narrow a raw thinking value to ThinkingLevel. */
function validateThinking(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  return VALID_THINKING_LEVELS.includes(raw as ThinkingLevel) ? (raw as ThinkingLevel) : undefined;
}

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** Raw agent config as parsed from .md frontmatter. */
export interface AgentConfigFromMd {
  name?: string;
  display_name?: string;
  description?: string;
  tools?: string[];
  extensions?: boolean | string[];
  skills?: boolean | string[];
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  disallowed_tools?: string[];
  enabled?: boolean;
  systemPrompt: string;
  source: "user" | "project";
}

/* ------------------------------------------------------------------ */
/*  Simple frontmatter parser                                          */
/* ------------------------------------------------------------------ */

/**
 * Naive YAML frontmatter splitter.
 *
 * Handles triple-dash delimited frontmatter blocks. Does NOT parse nested
 * YAML structures or complex types — only flat key: value pairs and
 * YAML array syntax (lines starting with "- ").
 *
 * Returns { frontmatter: Record<string, unknown>, body: string }.
 */
function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, unknown>; body: string } {
  if (!content) {
    return { frontmatter: {}, body: "" };
  }

  // Check for triple-dash delimited frontmatter
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmRaw = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5).trim();

  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentValues: string[] | null = null;

  for (const line of fmRaw.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Array item (continuation of previous key)
    if (trimmed.startsWith("- ")) {
      if (currentKey) {
        if (!currentValues) currentValues = [];
        currentValues.push(trimmed.slice(2).trim());
      }
      continue;
    }

    // Flush previous array before processing a new key
    if (currentKey && currentValues) {
      frontmatter[currentKey] = currentValues;
      currentValues = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      currentKey = trimmed;
      continue;
    }

    currentKey = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      // Might be followed by array items
      currentValues = [];
      continue;
    }

    // Strip surrounding quotes if present (YAML convention)
    frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
    currentValues = null;
  }

  // Flush trailing array items
  if (currentKey && currentValues) {
    frontmatter[currentKey] = currentValues;
  }

  return { frontmatter, body };
}

/* ------------------------------------------------------------------ */
/*  parseExtensions                                                    */
/* ------------------------------------------------------------------ */

/** Split comma-separated string, trim whitespace, and remove empty entries. */
function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse the extensions/skills field from frontmatter.
 *
 * - false / "false" / "none" → false
 * - true / "true" / "all" → true
 * - Comma-separated string → string[]
 * - undefined → undefined
 */
export function parseExtensions(
  raw: unknown,
): boolean | string[] | undefined {
  if (raw === false || raw === "false" || raw === "none") {
    return false;
  }
  if (raw === true || raw === "true" || raw === "all") {
    return true;
  }
  if (typeof raw === "string" && raw.length > 0) {
    return splitCommaList(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Frontmatter value helpers                                          */
/* ------------------------------------------------------------------ */

/** Extract a non-empty string value from frontmatter. */
export function parseString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = frontmatter[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Extract a string array from frontmatter (array or comma-separated string). */
export function parseStringArray(
  frontmatter: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = frontmatter[key];
  if (Array.isArray(v)) {
    return v.map(String);
  }
  if (typeof v === "string" && v.length > 0) {
    return splitCommaList(v);
  }
  return undefined;
}

/**
 * Build an object containing only the entries whose value is not undefined.
 * Used to transform AgentConfigFromMd fields into a Partial<AgentConfig>
 * without 14 repetitive `if (x !== undefined)` blocks.
 */
function compactDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined),
  ) as Partial<T>;
}

/* ------------------------------------------------------------------ */
/*  parseAgentFile                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a single agent .md file into AgentConfigFromMd.
 *
 * @param content - Raw file content
 * @param filename - Filename (for context, currently unused)
 * @param source - Source designation ("user" or "project")
 * @returns Parsed agent config with frontmatter and body
 */
export function parseAgentFile(
  content: string,
  _filename: string,
  source: "user" | "project",
): AgentConfigFromMd {
  const { frontmatter, body } = parseFrontmatter(content);

  const extensions = parseExtensions(frontmatter.extensions);
  const skills = parseExtensions(frontmatter.skills);

  // enabled field
  const enabledRaw = frontmatter.enabled;
  let enabled: boolean | undefined;
  if (enabledRaw === "false" || enabledRaw === false) {
    enabled = false;
  } else if (enabledRaw === "true" || enabledRaw === true) {
    enabled = true;
  }

  // max_turns field
  const maxTurnsRaw = frontmatter.max_turns;
  let maxTurns: number | undefined;
  if (typeof maxTurnsRaw === "number") {
    maxTurns = maxTurnsRaw;
  } else if (typeof maxTurnsRaw === "string" && maxTurnsRaw.length > 0) {
    const parsed = Number(maxTurnsRaw);
    if (!Number.isNaN(parsed)) {
      maxTurns = parsed;
    }
  }

  return {
    name: parseString(frontmatter, "name"),
    display_name: parseString(frontmatter, "display_name"),
    description: parseString(frontmatter, "description"),
    tools: parseStringArray(frontmatter, "tools"),
    extensions,
    skills,
    model: parseString(frontmatter, "model"),
    thinking: validateThinking(parseString(frontmatter, "thinking")),
    max_turns: maxTurns,
    disallowed_tools: parseStringArray(frontmatter, "disallowed_tools"),
    enabled,
    systemPrompt: body,
    source: source,
  };
}

/* ------------------------------------------------------------------ */
/*  scanAgentFilesInDir                                                */
/* ------------------------------------------------------------------ */

/**
 * Scan a directory for .md files and parse them into AgentConfigFromMd[].
 * Returns empty array if directory doesn't exist.
 */
export async function scanAgentFilesInDir(
  dirPath: string,
  source: "user" | "project" = "user",
): Promise<AgentConfigFromMd[]> {
  try {
    await fs.promises.access(dirPath);
  } catch {
    return [];
  }

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const mdFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith(".md"),
  );

  const agents: AgentConfigFromMd[] = [];
  for (const entry of mdFiles) {
    const filePath = path.join(dirPath, entry.name);
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const info = parseAgentFile(content, entry.name, source);
      if (info.name) {
        agents.push(info);
      }
    } catch {
      // Skip files that can't be read
    }
  }
  return agents;
}

/* ------------------------------------------------------------------ */
/*  mergeAgents                                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge default agents with user and project overrides.
 *
 * Per-field merge precedence (highest to lowest):
 *   1. project agents
 *   2. user agents
 *   3. default agents
 *
 * For each field, if a higher-precedence layer sets the field (not undefined),
 * it wins. Otherwise, the lower layer's value is preserved.
 *
 * @param defaults - Map of default agent configs
 * @param userAgents - User-defined agent configs
 * @param projectAgents - Project-specific agent configs
 * @returns Merged Map<string, AgentConfig> keyed by agent name
 */
export function mergeAgents(
  defaults: Map<string, AgentConfig>,
  userAgents: AgentConfigFromMd[],
  projectAgents: AgentConfigFromMd[],
): Map<string, AgentConfig> {
  const result = new Map<string, AgentConfig>();

  // Start with defaults
  for (const [name, config] of defaults) {
    result.set(name, { ...config });
  }

  // Apply user overrides (middle priority), then project (highest priority)
  mergeAgentOverrides(result, userAgents);
  mergeAgentOverrides(result, projectAgents);

  return result;
}

/**
 * Apply a list of agent configs onto the result map.
 * Existing agents are merged per-field; new agents are built from scratch.
 */
function mergeAgentOverrides(
  result: Map<string, AgentConfig>,
  agents: AgentConfigFromMd[],
): void {
  for (const md of agents) {
    if (!md.name) continue;
    const existing = result.get(md.name);
    if (existing) {
      result.set(md.name, { ...existing, ...fromMd(md) });
    } else {
      result.set(md.name, { ...BASE_DEFAULTS, ...fromMd(md) });
    }
  }
}

/**
 * Translate AgentConfigFromMd fields to a Partial<AgentConfig> containing
 * only fields that are explicitly set in the frontmatter (not undefined).
 *
 * When merging into an existing AgentConfig, spread this result after the
 * existing config so frontmatter fields override defaults while undefined
 * fields fall through to the existing values.
 */
function fromMd(md: AgentConfigFromMd): Partial<AgentConfig> {
  return compactDefined({
    name: md.name,
    displayName: md.display_name,
    description: md.description,
    builtinToolNames: md.tools,
    extensions: md.extensions,
    skills: md.skills,
    model: md.model,
    thinking: md.thinking,
    maxTurns: md.max_turns,
    disallowedTools: md.disallowed_tools,
    enabled: md.enabled,
    systemPrompt: md.systemPrompt,
    source: md.source === "project" ? "project" : "global",
  });
}

/**
 * Defaults used when creating a new AgentConfig from a .md file that has
 * no existing default to merge into. Satisfies all required AgentConfig
 * fields.
 */
const BASE_DEFAULTS: AgentConfig = {
  name: "unknown",
  description: "",
  extensions: true,
  skills: true,
  systemPrompt: "",
};
