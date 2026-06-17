/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { AgentConfig, EnvInfo, SystemPromptMode } from "./types.js";
import type { SkillMeta, PreloadedSkill } from "./skill-loader.js";

/** Extra sections to inject into the system prompt (skills). */
export interface PromptExtras {
  /** Preloaded skill contents to inject (full content + description). */
  skillBlocks?: PreloadedSkill[];
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
 * Strip pi scaffolding sections from a parent system prompt.
 *
 * In inherit mode, the parent's prompt already contains:
 *   - <project_context>...</project_context>  (AGENTS.md)
 *   - Skills block (text intro + <available_skills>...</available_skills>)
 *   - Current date: YYYY-MM-DD
 *   - Current working directory: /path
 *
 * These are re-added by subagents-lite from the subagent's own config,
 * so we strip them to avoid duplication.
 *
 * @param prompt  The parent system prompt to clean.
 * @returns       The prompt with scaffolding sections removed.
 */
function stripScaffolding(prompt: string): string {
  let result = prompt;

  // 1. Strip <project_context>...</project_context> block
  result = result.replace(/\n?<\s*project_context\s*>[\s\S]*?<\/\s*project_context\s*>\n?/g, "\n");

  // 2. Strip skills block: optional intro text + <available_skills>...</available_skills>
  result = result.replace(/\n?(?:The following skills provide[\s\S]*?)?<\s*available_skills\s*>[\s\S]*?<\/\s*available_skills\s*>\n?/g, "\n");

  // 3. Strip Current date: line
  result = result.replace(/\n?Current date:.*\n?/g, "\n");

  // 4. Strip Current working directory: line
  result = result.replace(/\n?Current working directory:.*\n?/g, "\n");

  // Clean up: collapse runs of 3+ newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/**
 * Build the system prompt for an agent from its config.
 *
 * Three modes:
 * - replace (default): generic header + env + agent's systemPrompt
 * - inherit: parent's system prompt (stripped of scaffolding) + env + agent's systemPrompt
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

  // Unified skill index — all skills in one <available_skills> block
  const hasSkills = extras?.skillMetas?.length || extras?.skillBlocks?.length;
  let extrasSuffix = "";
  if (hasSkills) {
    const lines = [
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      "<available_skills>",
    ];
    for (const skill of extras?.skillMetas ?? []) {
      lines.push(`<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.location)}</location></skill>`);
    }
    for (const skill of extras?.skillBlocks ?? []) {
      lines.push(`<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><content>${escapeXml(skill.content)}</content></skill>`);
    }
    lines.push("</available_skills>");
    extrasSuffix = `\n\n${lines.join("\n")}`;
  }

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
  const rawHeader = mode === "inherit" ? extras?.parentSystemPrompt
                 : mode === "custom"  ? extras?.customSystemPrompt
                 : undefined;
  // Strip scaffolding from inherited parent prompt to avoid duplication
  const customHeader = mode === "inherit" && rawHeader
    ? stripScaffolding(rawHeader)
    : rawHeader;
  const basePrompt = customHeader
    ? `${customHeader}\n${activeAgentTag}\n\n${envBlock}`
    : `You are a Pi, an expect coding sub-agent.\nYou have been invoked to handle a specific task autonomously.\n\n${activeAgentTag}\n\n${envBlock}`;

  return `${basePrompt}${agentInstructions}${contextSuffix}${extrasSuffix}`;
}

function escapeXml(value: string): string {
  // Only escape < and > — enough for XML-like tags, keeps text readable for LLMs
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
