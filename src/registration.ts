import { Type, type TSchema } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import {
  renderAgentToolCall,
  renderAgentToolResult,
  renderSubagentResult,
  registerAgentInvalidation,
} from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getStore } from "./shell.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama).
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" };

// --- Agent tool registration — dynamic enum for agent types ---

/**
 * Register (or re-register) the Agent tool with current agent types.
 * Call again from session_start after user/project agents load.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  const types = getAvailableTypes();
  const useConstrained = getStore().agent.agentToolStrictMode;

  // Plain string (not anyOf) keeps the prompt concise; types listed in description for discoverability.
  const agentType = types.length > 0 ? Type.String({ description: types.join(",") }) : Type.String();

  // Constrained sampling (strict mode) requires every property in `required`,
  // so optional fields become nullable unions instead of Type.Optional.
  const optional = <T extends TSchema>(base: T) =>
    useConstrained ? Type.Union([base, Type.Null()]) : Type.Optional(base);

  const params = Type.Object(
    {
      prompt: Type.String(),
      description: optional(Type.String()),
      agent: optional(agentType),
      run_in_background: optional(Type.Boolean()),
      worktree_path: optional(Type.String()),
    },
    useConstrained
      ? {
          additionalProperties: false,
          required: ["prompt", "description", "agent", "run_in_background", "worktree_path"],
        }
      : { additionalProperties: false },
  );

  const tool = {
    name: "Agent",
    label: "Agent",
    parameters: params,
    execute: executeAgentTool,
    ...(useConstrained ? { constrainedSampling: CONSTRAINED_SAMPLING } : {}),

    renderCall: (
      args: Record<string, unknown>,
      theme: any,
      context?: { state?: Record<string, unknown>; toolCallId?: string },
    ) => renderAgentToolCall(args, theme, context),

    renderResult: (
      result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> },
      options: { expanded?: boolean },
      theme: any,
      context: {
        isError?: boolean;
        invalidate?: () => void;
        state?: Record<string, unknown>;
        executionStarted?: boolean;
      },
    ) => {
      const isError = context?.isError ?? false;
      const store = getStore();
      const agentId = result.details?.agentId as string | undefined;
      // Register invalidate callback so onComplete can trigger a re-render
      if (agentId && context?.invalidate) {
        registerAgentInvalidation(agentId, context.invalidate);
        // Store agentId and background flag in context state so call renderer can access it on re-render
        if (context.state) {
          context.state.agentId = agentId;
          context.state.isBackground = true;
        }
      }
      return renderAgentToolResult(
        { ...result, isError },
        options,
        theme,
        store.agent.showCost,
        store.agent.modelDisplayStyle,
        context,
      );
    },
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(tool);
}

// --- Tool/Command/Message registration ---

export function registerTools(pi: ExtensionAPI): void {
  registerAgentTool(pi);

  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object(
      {
        agent_id: Type.String(),
      },
      { additionalProperties: false },
    ),
    execute: executeStopAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
    renderResult: (
      result: { content: Array<{ type: string; text?: string }> },
      _options: { expanded?: boolean },
      theme: any,
      context: { isError?: boolean },
    ) => {
      const isError = context?.isError ?? false;
      const text = result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return new Text(`${icon} ${text}`, 0, 0);
    },
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(stopAgentTool);

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
      !store.agent.showCompletionCards,
    );
  });

  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // ctx.scopedModels added in pi 0.83.0 — session-scoped model list from --models / enabledModels.
      // Empty array means no scoping (all models usable). Undefined on pi < 0.83.
      const scoped = (ctx as any).scopedModels as
        ReadonlyArray<{ model: { provider: string; id: string } }> | undefined;
      const modelOptions = scoped?.length
        ? scoped.map((s) => `${s.model.provider}/${s.model.id}`)
        : ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
