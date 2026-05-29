/**
 * skill-loader.ts — Preload named skills.
 *
 * Roots, in precedence order:
 *   - <cwd>/.pi/skills           (project, Pi's standard)
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself contains
 * SKILL.md is a skill — we don't descend into it (Pi: skills don't nest).
 *
 * Symlinks are rejected for security (deviation from Pi, which follows them).
 *
 * Changed from upstream: imports from ./utils.js instead of ./memory.js.
 */

import type { Dirent } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "./utils.js";

interface PreloadedSkill {
  name: string;
  content: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd) }));
}

/**
 * Load skill metadata only (name, description, location) without full content.
 * Used for the skills whitelist — agent can read full content on-demand.
 */
export function loadSkillMeta(skillNames: string[], cwd: string): SkillMeta[] {
  return skillNames.map((name) => {
    const location = findSkillLocation(name, cwd);
    if (!location) {
      return { name, description: `(Skill "${name}" not found)`, location: "" };
    }
    const description = extractDescription(location);
    return { name, description, location };
  });
}

function loadSkillContent(name: string, cwd: string): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  const roots = [
    join(cwd, ".pi", "skills"), // project — Pi standard
    join(cwd, ".agents", "skills"), // project — Agent Skills spec
    join(getAgentDir(), "skills"), // user — Pi standard
    join(homedir(), ".agents", "skills"), // user — Agent Skills spec
    join(homedir(), ".pi", "skills"), // legacy global, pre-Pi
  ];
  for (const root of roots) {
    const content = findInRoot(root, name);
    if (content !== undefined) return content;
  }
  return `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;
}

function findInRoot(root: string, name: string): string | undefined {
  if (isSymlink(root)) return undefined; // reject symlinked roots entirely
  const flat = safeReadFile(join(root, `${name}.md`))?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name);
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
function findSkillDirectory(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      // Symlinked dirs already filtered by entry.isDirectory() — Dirent uses lstat semantics.
      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const content = safeReadFile(skillMd)?.trim();
          if (content !== undefined) return content;
        }
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}

/**
 * Find skill file location without reading content.
 * Returns the full path to the SKILL.md or .md file, or undefined if not found.
 */
function findSkillLocation(name: string, cwd: string): string | undefined {
  if (isUnsafeName(name)) return undefined;
  const roots = [
    join(cwd, ".pi", "skills"),
    join(cwd, ".agents", "skills"),
    join(getAgentDir(), "skills"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".pi", "skills"),
  ];
  for (const root of roots) {
    const location = findLocationInRoot(root, name);
    if (location !== undefined) return location;
  }
  return undefined;
}

/** Find skill file path in a root directory. */
function findLocationInRoot(root: string, name: string): string | undefined {
  if (isSymlink(root)) return undefined;
  const flatPath = join(root, `${name}.md`);
  if (existsSync(flatPath)) return flatPath;
  return findSkillDirectoryLocation(root, name);
}

/** BFS for skill directory, returns path to SKILL.md. */
function findSkillDirectoryLocation(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          return skillMd;
        }
        continue;
      }

      queue.push(path);
    }
  }
  return undefined;
}

/** Extract description from SKILL.md frontmatter. */
function extractDescription(filePath: string): string {
  try {
    const content = safeReadFile(filePath);
    if (!content) return "(no description)";

    // Simple frontmatter extraction
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---\n")) return "(no description)";
    const endIndex = normalized.indexOf("\n---\n", 4);
    if (endIndex === -1) return "(no description)";

    const yamlString = normalized.slice(4, endIndex);
    // Simple extraction of description field
    const descMatch = yamlString.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch && descMatch[1]) {
      // Truncate long descriptions
      const desc = descMatch[1].trim();
      return desc.length > 200 ? desc.slice(0, 197) + "..." : desc;
    }
    return "(no description)";
  } catch {
    return "(error reading description)";
  }
}
