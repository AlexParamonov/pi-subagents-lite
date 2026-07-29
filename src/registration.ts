import { Type, type TSchema } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getPiInstance, getStore } from "./shell.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama). Runtime-supported field,
// not yet declared in pi's ToolDefinition type.
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" };

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
  const useConstrained = getStore().agent.agentToolStrictMode;

  // Use plain string to avoid verbose anyOf in prompt.
  // Available types are listed in description for discoverability.
  const agentType = types.length > 0
    ? Type.String({ description: types.join(",") })
    : Type.String();

  // Constrained sampling (strict mode) requires every property in `required`,
  // so optional fields become nullable unions instead of Type.Optional.
  const optional = <T extends TSchema>(base: T) =>
    useConstrained ? Type.Union([base, Type.Null()]) : Type.Optional(base);

  const params = Type.Object({
    prompt: Type.String(),
    description: optional(Type.String()),
    agent: optional(agentType),
    run_in_background: optional(Type.Boolean()),
    worktree_path: optional(Type.String()),
  }, useConstrained
    ? { additionalProperties: false, required: ["prompt", "description", "agent", "run_in_background", "worktree_path"] }
    : { additionalProperties: false });

  const tool = {
    name: "Agent",
    label: "Agent",
    parameters: params,
    execute: executeAgentTool,
    ...(useConstrained ? { constrainedSampling: CONSTRAINED_SAMPLING } : {}),

    renderCall: (args: Record<string, unknown>, theme: any) => renderAgentToolCall(args, theme),

    renderResult: (result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean }, options: { expanded?: boolean }, theme: any) => {
      const store = getStore();
      return renderAgentToolResult(
        result,
        options,
        theme,
        store.agent.showCost,
        store.agent.modelDisplayStyle,
      );
    },
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(tool);
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
  // Agent tool — stealth schema with dynamic agent type enum
  registerAgentTool(pi);

  // StopAgent tool — stealth schema, stop a running agent by ID
  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object({
      agent_id: Type.String(),
    }, { additionalProperties: false }),
    execute: executeStopAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(stopAgentTool);

  // AgentStatus tool — stealth schema, list all agents and their statuses
  const agentStatusTool = {
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: executeAgentStatusTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(agentStatusTool);

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const store = getStore();
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      store.agent.showCost,
      store.agent.modelDisplayStyle,
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
