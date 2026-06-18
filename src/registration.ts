import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getPiInstance, getStore } from "./shell.js";

// ============================================================================
// Agent tool registration helper — dynamic enum for agent types
// ============================================================================

/**
 * Register (or re-register) the Agent tool with current agent types.
 * At init time only defaults exist; call again from session_start after
 * user/project agents are loaded to update the enum.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  const types = getAvailableTypes();
  // Use plain string to avoid verbose anyOf in prompt.
  // Available types are listed in description for discoverability.
  const agentParam = types.length > 0
    ? Type.Optional(Type.String({ description: types.join(",") }))
    : Type.Optional(Type.String());
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: agentParam,
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }),
    execute: executeAgentTool,

    renderCall: (args, theme) => renderAgentToolCall(args as Record<string, unknown>, theme),

    renderResult: (result, options, theme) => {
      const showCost = getStore().agent.showCost;
      return renderAgentToolResult(
        result as { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
        options as { expanded?: boolean },
        theme,
        showCost,
      );
    },
  });
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
  // Agent tool — stealth schema with dynamic agent type enum
  registerAgentTool(pi);

  // StopAgent tool — stealth schema, stop a running agent by ID
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }),
    execute: executeStopAgentTool,
  });

  // AgentStatus tool — stealth schema, list all agents and their statuses
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool({
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({}),
    execute: executeAgentStatusTool,
  });

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const showCost = getStore().agent.showCost;
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      showCost,
    );
  });

  // Command registration
  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const modelOptions = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
