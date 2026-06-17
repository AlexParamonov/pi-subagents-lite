/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { AgentConfig, EnvInfo, SystemPromptMode } from "./types.js";
import type { SkillMeta } from "./skill-loader.js";

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Preloaded skill contents to inject (full content). */
  skillBlocks?: { name: string; content: string }[];
  /** Skill metadata for whitelist display (name, description, location only). */
  skillMetas?: SkillMeta[];
  /** Parent system prompt (for inherit mode). */
  parentSystemPrompt?: string;
  /** Custom system prompt content (for custom mode). */
  customSystemPrompt?: string;
  /** Project context files (AGENTS.md) for custom mode. */
  contextFiles?: Array<{ path: string; content: string }>;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * Three modes:
 * - replace (default): generic header + env + agent's systemPrompt
 * - inherit: parent's full system prompt (verbatim) + env + agent's systemPrompt
 * - custom: content of ~/.pi/agent/subagents-lite-prompt.md + env + agent's systemPrompt
 *
 * Agent's own systemPrompt is always included in <agent_instructions> tags.
 *
 * @param config   Agent configuration.
 * @param cwd      Current working directory.
 * @param env      Environment info.
 * @param extras   Optional extra sections to inject (skills, parent/custom prompts).
 * @param mode     System prompt mode (replace, inherit, custom).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
  mode: SystemPromptMode = "replace",
): string {
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
      lines.push(`<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.location)}</location></skill>`);
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

  // Agent's own system prompt wrapped in <agent_instructions> tags
  const agentInstructions = `\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`;

  // Project context files (AGENTS.md) — placed after agent_instructions, before extras
  let contextSuffix = "";
  if (extras?.contextFiles?.length) {
    const lines = [
      "<project_context>",
      "",
      "Project-specific instructions and guidelines:",
      "",
    ];
    for (const file of extras.contextFiles) {
      lines.push(`<project_instructions path="${escapeXml(file.path)}">`);
      lines.push(file.content);
      lines.push(`</project_instructions>`);
      lines.push("");
    }
    lines.push("</project_context>");
    contextSuffix = `\n\n${lines.join("\n")}`;
  }

  // Build base prompt: mode-specific header if provided, otherwise default
  const activeAgentTag = `<active_agent name="${config.name}"/>`;
  const customHeader = mode === "inherit" ? extras?.parentSystemPrompt
                    : mode === "custom"  ? extras?.customSystemPrompt
                    : undefined;
  const basePrompt = customHeader
    ? `${customHeader}\n${activeAgentTag}\n\n${envBlock}`
    : `You are Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously.\n\n${activeAgentTag}\n\n${envBlock}`;

  return `${basePrompt}${agentInstructions}${contextSuffix}${extrasSuffix}`;
}

function escapeXml(value: string): string {
  // Only escape < and > — enough for XML-like tags, keeps text readable for LLMs
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


