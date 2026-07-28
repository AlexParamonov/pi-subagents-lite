import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getPiInstance, getStore } from "./shell.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama). Runtime-supported field,
// not yet declared in pi's ToolDefinition type.
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" };

/** Register the fixed, intentionally bare Agent tool once at extension init. */
function registerAgentTool(pi: ExtensionAPI): void {
  const tool = {
    name: "Agent",
    label: "Agent",
    parameters: Type.Object({
      prompt: Type.String(),
      description: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      run_in_background: Type.Optional(Type.Boolean()),
      worktree_path: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    execute: executeAgentTool,
    renderCall: (args: Record<string, unknown>, theme: any) => renderAgentToolCall(args, theme),
    renderResult: (result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean }, options: { expanded?: boolean }, theme: any) => renderAgentToolResult(result, options, theme, getStore().agent.showCost),
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(tool);
}

// ============================================================================
// Tool/Command/Message registration
// ============================================================================

/** Register all tools, commands, and message renderers. */
export function registerTools(pi: ExtensionAPI): void {
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
