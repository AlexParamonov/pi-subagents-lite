/**
 * prompts.ts — System prompt builder for agents.
 *
 * Every agent gets a fresh context — no inherited parent identity.
 * EnvInfo is imported from types.ts — branch is a string (empty when unknown).
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (skills only — no memoryBlock). */
export interface PromptExtras {
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
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

  // Build optional extras suffix (skills only — no memoryBlock)
  const extraSections: string[] = [];
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


