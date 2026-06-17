/**
 * skill-loader.ts — Load skills using Pi's exported APIs.
 *
 * Aligns skill discovery with Pi so subagents see the same skills as the parent session.
 *
 * Roots, in precedence order (first match wins by name):
 *   1. Ancestor .agents/skills (cwd → git root, root .md files filtered out)
 *   2. ~/.agents/skills (root .md files filtered out)
 *   3. ~/.pi/agent/skills (Pi's user default)
 *   4. <cwd>/.pi/skills (Pi's project default)
 *
 * Pi's loadSkills handles: .gitignore/.ignore/.fdignore, symlinks (follow +
 * canonical-path dedup), YAML frontmatter, name validation.
 *
 * loadSkillsFromDir handles the same for individual .agents/skills directories.
 * Root .md files from .agents/skills are filtered out because Pi's "agents"
 * mode (no root files) is not exported.
 */

import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadSkills,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { isUnsafeName } from "../utils.js";

export interface PreloadedSkill {
  name: string;
  description: string;
  content: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Whether the skill should be excluded from the <available_skills> prompt block. */
  disableModelInvocation: boolean;
  /** Full skill content — present when the skill is preloaded. */
  content?: string;
}

/**
 * Load all skills in correct precedence order.
 *
 * Precedence (first match wins by name):
 *   1. Ancestor .agents/skills directories (cwd → git root)
 *   2. ~/.agents/skills
 *   3. Pi defaults: ~/.pi/agent/skills, <cwd>/.pi/skills
 *
 * Deduplication: by canonical path (symlink dedup) and by name (first match wins).
 */
export function loadAllSkills(cwd: string): Skill[] {
  const resolvedCwd = resolve(cwd);

  // Ancestor .agents/skills (highest precedence)
  const ancestorsSkills = loadAncestorAgentsSkills(resolvedCwd);

  // ~/.agents/skills
  const homeAgentsResult = loadSkillsFromDir({
    dir: join(homedir(), ".agents", "skills"),
    source: "agents",
  });
  const homeAgentsSkills = filterRootMdFiles(
    homeAgentsResult.skills,
    join(homedir(), ".agents", "skills"),
  );

  // Pi defaults: ~/.pi/agent/skills and <cwd>/.pi/skills
  const defaultsResult = loadSkills({
    cwd: resolvedCwd,
    agentDir: join(homedir(), ".pi", "agent"),
    skillPaths: [],
    includeDefaults: true,
  });

  // Merge in precedence order: ancestors first, then home, then defaults.
  // First match wins by name and by canonical path.
  const nameSet = new Set<string>();
  const realPathSet = new Set<string>();
  const result: Skill[] = [];

  for (const skill of [...ancestorsSkills, ...homeAgentsSkills, ...defaultsResult.skills]) {
    const realPath = canonicalizePath(skill.filePath);
    if (realPathSet.has(realPath) || nameSet.has(skill.name)) continue;
    nameSet.add(skill.name);
    realPathSet.add(realPath);
    result.push(skill);
  }

  return result;
}

/**
 * Walk from cwd up to git root, loading skills from each .agents/skills directory.
 * Filters out root .md files (Pi's exported API doesn't support "agents" mode).
 */
function loadAncestorAgentsSkills(resolvedCwd: string): Skill[] {
  const gitRoot = findGitRoot(resolvedCwd);
  const result: Skill[] = [];
  let dir = resolvedCwd;

  while (true) {
    const agentsSkillsDir = join(dir, ".agents", "skills");
    const dirResult = loadSkillsFromDir({
      dir: agentsSkillsDir,
      source: "agents",
    });
    result.push(...filterRootMdFiles(dirResult.skills, agentsSkillsDir));

    if (dir === gitRoot) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return result;
}

/**
 * Filter out root .md files from .agents/skills directories.
 *
 * loadSkillsFromDir always includes root .md files (includeRootFiles: true),
 * but .agents/skills directories should only contain subdirectory skills.
 * A root .md skill has a filePath whose parent is the skills root itself.
 */
function filterRootMdFiles(skills: Skill[], skillsRoot: string): Skill[] {
  const normalizedRoot = resolve(skillsRoot);
  return skills.filter((skill) => {
    const parent = resolve(skill.filePath, "..");
    return parent !== normalizedRoot;
  });
}

/** Walk up from dir to find the git root (directory containing .git). */
function findGitRoot(dir: string): string {
  let current = resolve(dir);
  while (true) {
    try {
      const entries = readdirSync(current);
      if (entries.includes(".git")) return current;
    } catch { /* ignore */ }
    const parent = resolve(current, "..");
    if (parent === current) return current; // filesystem root
    current = parent;
  }
}

/** Resolve path to canonical form, following symlinks. Falls back to raw path. */
function canonicalizePath(filePath: string): string {
  try { return realpathSync(filePath); } catch { return filePath; }
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  const skills = loadAllSkills(cwd);
  return skillNames.map((name) => {
    if (isUnsafeName(name)) {
      return { name, description: "", content: `(Skill "${name}" skipped: name contains path traversal characters)` };
    }
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return { name, description: "", content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)` };
    }
    try {
      return { name, description: match.description, content: readFileSync(match.filePath, "utf-8").trim() };
    } catch {
      return { name, description: "", content: `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)` };
    }
  });
}

/**
 * Load skill metadata only (name, description, location) without full content.
 * Used for the skills whitelist — agent can read full content on-demand.
 */
export function loadSkillMeta(skillNames: string[], cwd: string): SkillMeta[] {
  const skills = loadAllSkills(cwd);
  return skillNames.map((name) => {
    const match = skills.find((s) => s.name === name);
    if (!match) {
      return { name, description: `(Skill "${name}" not found)`, location: "", disableModelInvocation: false };
    }
    return {
      name,
      description: match.description,
      location: match.filePath,
      disableModelInvocation: match.disableModelInvocation,
    };
  });
}


