import { Type, type TSchema } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAgentTypeDescriptions, getVisibleAgentInfos } from "./agents/agent-types.ts";
import { executeAgentTool, executeMessageAgentTool, executeStopAgentTool } from "./agents/tool-execution.ts";
import { executeAgentStatusTool } from "./agents/agent-status.ts";
import { sendParentMessage, type SubagentMessageDetails } from "./agents/parent-message.ts";
import {
  renderAgentToolCall,
  renderAgentToolResult,
  renderStatusLine,
  renderSubagentResult,
  renderSubagentMessage,
  registerAgentInvalidation,
} from "./ui/renderer.ts";
import { showAgentsMainMenu } from "./ui/menu/menus.ts";
import { getStore } from "./shell.ts";
import type { SubagentParentContext } from "./agents/subagent-context.ts";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama).
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

// --- Agent tool registration — dynamic enum for agent types ---

/**
 * Register (or re-register) the Agent tool with current agent types.
 * Call again from session_start after user/project agents load.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  const settings = getStore().agent;
  const visible = getVisibleAgentInfos();
  const types = visible.map((info) => info.name);
  const useConstrained = settings.agentToolStrictMode;

  // Plain string (not anyOf) keeps the prompt concise; types listed in
  // description for discoverability. With exposeDescriptions on, each visible
  // agent's Markdown description joins the listing (read at registration
  // time — re-registered at session_start, so it applies to the next
  // session). No visible types → no description at all, in either mode.
  const agentType =
    types.length > 0
      ? Type.String({
          description: settings.exposeDescriptions ? formatAgentTypeDescriptions(visible) : types.join(","),
        })
      : Type.String();

  // Constrained sampling (strict mode) requires every property in `required`,
  // so optional fields become nullable unions instead of Type.Optional.
  const optional = <T extends TSchema>(base: T) =>
    useConstrained ? Type.Union([base, Type.Null()]) : Type.Optional(base);

  const params = Type.Object(
    {
      prompt: Type.String(),
      description: optional(Type.String()),
      agent: optional(agentType),
      run_in_background: optional(
        Type.Boolean({ description: "Request background execution; active MessageAgent tools force this on." }),
      ),
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
    description: ".",
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
  pi.registerTool(tool);
}

// --- Tool/Command/Message registration ---

export function registerTools(pi: ExtensionAPI): void {
  registerAgentTool(pi);

  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    description: ".",
    parameters: Type.Object({ agent_id: Type.String() }, { additionalProperties: false }),
    execute: executeStopAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
    renderResult: renderStatusLine,
  };
  pi.registerTool(stopAgentTool);

  registerCommunicationTools(pi);
  registerCommandsAndMessages(pi);
}

/** Register just the shared communication tools without touching the parent shell. */
export function registerCommunicationTools(pi: ExtensionAPI, parent?: SubagentParentContext): void {
  const executeMessage: typeof executeMessageAgentTool = (toolCallId, params, signal, onUpdate, ctx) => {
    parent?.onBackgroundPromotion?.();
    if (parent && params.agent_id == null) {
      return sendParentMessage(parent, ctx, params.message);
    }
    return executeMessageAgentTool(
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
      parent?.manager,
      parent?.agentStatusLimit,
    );
  };

  const messageAgentTool = {
    name: "MessageAgent",
    label: "MessageAgent",
    description: parent
      ? "Using this tool ensures the child runs in the background so the parent can act while you continue. The parent can steer you in reply at your next turn. Send only actionable updates. Omit agent_id or pass null to message the parent; provide an ID to message another managed agent. Final responses, including blockers and questions, are delivered automatically. Do not send routine progress, successful test results, or completion summaries."
      : ".",
    parameters: Type.Object(
      {
        agent_id: parent
          ? Type.Optional(
              Type.Union([
                Type.String({ description: "ID of another managed agent. Omit or pass null to message the parent." }),
                Type.Null(),
              ]),
            )
          : Type.String(),
        message: Type.String(),
      },
      { additionalProperties: false },
    ),
    execute: executeMessage,
    // The child schema permits omission; strict JSON schema requires all keys.
    ...(!parent ? { constrainedSampling: CONSTRAINED_SAMPLING } : {}),
    renderResult: renderStatusLine,
  };
  pi.registerTool(messageAgentTool);

  const executeStatus: typeof executeAgentStatusTool = (toolCallId, params, signal, onUpdate, ctx) => {
    return executeAgentStatusTool(
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
      !parent,
      parent?.manager,
      parent?.agentStatusLimit,
    );
  };
  const agentStatusTool = {
    name: "AgentStatus",
    label: "AgentStatus",
    description: ".",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: executeStatus,
  };
  pi.registerTool(agentStatusTool);
}

function registerCommandsAndMessages(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SubagentMessageDetails>("subagent-message", (message, _options, theme) => {
    const store = getStore();
    return renderSubagentMessage(message, theme, store.agent.modelDisplayStyle, store.agent.showCost);
  });

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
        | ReadonlyArray<{ model: { provider: string; id: string } }>
        | undefined;
      const modelOptions = scoped?.length
        ? scoped.map((s) => `${s.model.provider}/${s.model.id}`)
        : ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
