/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { AgentConfig, EnvInfo } from "./types.js";
import type { SkillMeta } from "./skill-loader.js";

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Preloaded skill contents to inject (full content). */
  skillBlocks?: { name: string; content: string }[];
  /** Skill metadata for whitelist display (name, description, location only). */
  skillMetas?: SkillMeta[];
}

/**
 * Build the system prompt for an agent from its config.
 *
 * Always uses fresh-context mode: env header + config.systemPrompt.
 * Prepends an `<active_agent name=""/>` tag so downstream extensions
 * (e.g. permission/policy systems) can resolve per-agent policy.
 *
 * @param extras  Optional extra sections to inject (preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envLines = [
    "# Environment",
    `Working directory: ${cwd}`,
    env.isGitRepo ? "Git repository: yes" : "Not a git repository",
  ];
  if (env.isGitRepo && env.branch) {
    envLines.push(`Branch: ${env.branch}`);
  }
  envLines.push(`Platform: ${env.platform}`);
  const envBlock = envLines.join("\n");

  // Build optional extras suffix (skills)
  const extraSections: string[] = [];

  // Skill metadata whitelist (like Pi's available_skills format)
  if (extras?.skillMetas?.length) {
    const lines = [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
    ];
    for (const skill of extras.skillMetas) {
      lines.push("  <skill>");
      lines.push(`    <name>${escapeXml(skill.name)}</name>`);
      lines.push(`    <description>${escapeXml(skill.description)}</description>`);
      lines.push(`    <location>${escapeXml(skill.location)}</location>`);
      lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    extraSections.push(lines.join("\n"));
  }

  // Preloaded skill contents (full dump into system prompt)
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }

  const extrasSuffix = extraSections.length > 0 ? `\n\n${extraSections.join("\n")}` : "";

  const header = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return `${activeAgentTag}${header}\n\n${config.systemPrompt}${extrasSuffix}`;
}

function escapeXml(value: string): string {
  // Only escape < and > — enough for XML-like tags, keeps text readable for LLMs
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


