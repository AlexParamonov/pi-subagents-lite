/**
 * menu-debug.ts — Debug menu concern.
 *
 * Exports:
 *   - showDebugMenu: agent types listing, agent briefing
 *
 * Private helpers (single-consumer, co-located):
 *   - showAgentTypes: list available agent types and their configs
 *   - handleAgentBriefing: send agent types/capabilities info to LLM
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig, getAvailableTypes, getAllTypes } from "./agent-types.js";
import { matchMenuChoice } from "./menu-helpers.js";
import { getPiInstance } from "./shell.js";

async function showAgentTypes(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const lines: string[] = ["Available agent types:\n"];
  for (const name of types) {
    const cfg = getAgentConfig(name);
    if (!cfg) continue;
    const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleAgentBriefing(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAvailableTypes();
  const agents = types.map((t) => ({ name: t, config: getAgentConfig(t) }));

  const lines: string[] = [
    "# Agent Types and Capabilities\n",
    "The following agent types are available. Use the `agent` parameter to select one.\n",
  ];

  for (const { name, config } of agents) {
    if (!config) continue;
    lines.push(`## ${config.displayName ?? name}`);
    lines.push(config.description);
    lines.push("");

    if (config.registeredTools) {
      lines.push(`**Tools:** ${config.registeredTools.join(", ")}`);
    }
    if (config.model) {
      lines.push(`**Default model:** ${config.model}`);
    }
    if (config.maxTurns) {
      lines.push(`**Max turns:** ${config.maxTurns}`);
    }
    lines.push("");
  }

  // Parameter descriptions
  lines.push("## Agent Tool Parameters\n");
  lines.push("| Parameter | Description |");
  lines.push("|-----------|-------------|");
  lines.push("| `prompt` | The task for the agent (required) |");
  lines.push("| `description` | One-line summary of what the agent should do (required) |");
  lines.push("| `agent` | Which agent type to use (default: general-purpose) |");
  lines.push("| `thinking` | Optional thinking mode override (e.g., `off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |");
  lines.push("| `run_in_background` | When `true`, result is auto-delivered — do NOT poll. Continue working while waiting. |");
  lines.push("| `worktree_path` | Optional path to a git worktree of the parent's repo. See below for details. |");
  lines.push("");

  // Usage guidelines
  lines.push("## Usage Guidelines\n");
  lines.push("- Agents start fresh with their config — they do NOT inherit the parent conversation");
  lines.push("- For parallel tasks, spawn multiple `run_in_background: true` agents in one turn");
  lines.push("  → Results are auto-delivered — do NOT poll, the result will arrive when ready");
  lines.push("");
  lines.push("## `worktree_path` Parameter\n");
  lines.push("Use `worktree_path` to run a subagent in a different git worktree of the parent's repository.");
  lines.push("");
  lines.push("- **Optional.** Omit to run the subagent in the parent's working directory (default behavior).");
  lines.push("- **Must be a path** inside a git worktree of the parent's repo, including the main checkout. Not a different repo, not a non-git directory.");
  lines.push("- **Relative paths** are resolved against the parent's working directory.");
  lines.push("- **On failure** the validator returns a specific reason (e.g., 'not a worktree of the parent's repository', 'path does not exist') — use this to self-correct.");
  lines.push("- **Agent type discovery:** The worktree's `.pi/agents/` directory is scanned for agent types when this param is set, so worktree-local types become available to that spawn.");
  getPiInstance().sendUserMessage(lines.join("\n"));
  ctx.ui.notify("Agent briefing sent to LLM", "info");
}

export async function showDebugMenu(ctx: ExtensionCommandContext): Promise<void> {
  const menuItems = [
    "1. Agent types — List available agent types and their configs",
    "2. Agent briefing — Send agent types/capabilities info to LLM (Optional, if having issues)",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showAgentTypes(ctx),
    "2": () => handleAgentBriefing(ctx),
  };

  while (true) {
    const choice = await ctx.ui.select("Debug", menuItems);
    if (choice === undefined) return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}
