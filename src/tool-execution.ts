/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool,
 * plus nudge scheduling and activity tracking helpers.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./types.js";
import type { SpawnOptions as AgentManagerSpawnOptions } from "./agent-manager.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import { resolveType, getAgentConfig, discoverNewAgents } from "./agent-types.js";
import { resolveModel } from "./model-precedence.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "./usage.js";

// Shared state imported from index.ts
import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "./utils.js";
import {
  __config,
  sessionOverrides,
  manager,
  piInstance,
  agentActivity,
  widget,
} from "./index.js";

// ============================================================================
// Module-level state
// ============================================================================

/** Agent IDs that were spawned as background — only these trigger a nudge on completion. */
export const backgroundAgentIds = new Set<string>();

const pendingNudges = new Set<string>();
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
export function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
export function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

// ============================================================================
// Activity tracking
// ============================================================================

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: unknown) => {
      state.session = session as Parameters<typeof getSessionContextPercent>[0];
    },
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

// ============================================================================
// Nudge scheduling — batch completion notifications within the hold window
// ============================================================================

export function scheduleNudge(agentId: string): void {
  pendingNudges.add(agentId);

  if (nudgeTimer) return;

  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    const batch = [...pendingNudges];
    pendingNudges.clear();

    for (const id of batch) {
      emitIndividualNudge(id, manager?.getRecord(id));
    }
  }, NUDGE_DELAY_MS);
}

function emitIndividualNudge(agentId: string, record?: AgentRecord): void {
  if (!record) return;

  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const elapsedMs = record.completedAt
    ? record.completedAt - record.startedAt
    : 0;

  const details: Record<string, unknown> = {
    type: record.type,
    description: record.description,
    status: record.status,
    outputFile: record.outputFile,
    turnCount: record.turnCount ?? agentActivity.get(agentId)?.turnCount,
    maxTurns: record.maxTurns,
    toolUses: record.toolUses,
    tokens: totalTokens,
    cost: record.lifetimeUsage.cost,
    contextPercent: getSessionContextPercent(record.session),
    durationMs: elapsedMs,
    compactions: record.compactionCount,
    modelName: record.invocation?.modelName,
  };

  piInstance.sendMessage(
    {
      customType: "subagent-result",
      content: `[Subagent "${record.type}" completed]\n\n${record.result ?? ""}`,
      details,
      display: true,
    },
    {
      deliverAs: "steer",
      triggerTurn: true,
    },
  );
}

// ============================================================================
// Tool execute handlers
// ============================================================================

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  const type = (params.agent as string) || "general-purpose";
  let resolvedType = resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session
    await discoverNewAgents();
    resolvedType = resolveType(type);
  }
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = params.description as string;
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns = params.max_turns as number | undefined ?? getAgentConfig(resolvedType)?.maxTurns;
  const modelStr = params.model as string | undefined;
  const model = findModelInRegistry(modelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (only when different from parent)
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const modelName = (modelKey && modelKey !== parentModelId)
    ? parseModelKey(modelKey)?.modelId
    : undefined;

  // Resolve thinking: explicit param > agent config (frontmatter) > undefined (inherit)
  const thinkingLevel = parseThinkingLevel(params.thinking as string | undefined)
    ?? getAgentConfig(resolvedType)?.thinking;

  const spawnOptions: AgentManagerSpawnOptions = {
    description,
    model,
    maxTurns,
    thinkingLevel,
    modelKey,
    invocation: modelName ? { modelName } : undefined,
    graceTurns: __config.agent.graceTurns,
  };

  if (runInBackground || __config.agent.forceBackground) {
    return executeSpawnBackground(resolvedType, prompt, ctx, spawnOptions);
  }

  return executeSpawnForeground(resolvedType, prompt, ctx, spawnOptions);
}

async function executeSpawnBackground(
  resolvedType: string,
  prompt: string,
  ctx: ExtensionContext,
  spawnOptions: AgentManagerSpawnOptions,
): Promise<any> {
  const { state, callbacks } = createActivityTracker(
    spawnOptions.maxTurns,
  );

  const agentId = manager.spawn(piInstance, ctx, resolvedType, prompt, {
    ...spawnOptions,
    isBackground: true,
    ...callbacks,
  });
  backgroundAgentIds.add(agentId);
  agentActivity.set(agentId, state);
  widget?.ensureTimer();
  widget?.update();

  const record = manager.getRecord(agentId)!;
  const details: Record<string, unknown> = { type: resolvedType, description: spawnOptions.description };
  const suffix = `A notification will arrive when done - User asks you not to poll or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
  const label = record.status === "queued" ? "Agent queued" : "Agent running";

  return successResult(`[${label}] ${suffix}`, details);
}

async function executeSpawnForeground(
  resolvedType: string,
  prompt: string,
  ctx: ExtensionContext,
  spawnOptions: AgentManagerSpawnOptions,
): Promise<any> {
  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
    spawnOptions.maxTurns,
  );

  const fgId = manager.spawn(piInstance, ctx, resolvedType, prompt, {
    ...spawnOptions,
    ...fgCallbacks,
    isBackground: false,
  });
  agentActivity.set(fgId, fgState);
  widget?.ensureTimer();

  const record = manager.getRecord(fgId)!;
  await record.promise;

  agentActivity.delete(fgId);
  widget?.markFinished(fgId);
  widget?.update();

  const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const stats: Record<string, unknown> = {
    type: resolvedType,
    turnCount: fgState.turnCount,
    maxTurns: fgState.maxTurns,
    toolUses: record.toolUses,
    tokens: totalTokens,
    contextPercent: getSessionContextPercent(fgState.session),
    durationMs: elapsedMs,
    description: spawnOptions.description,
    compactions: record.compactionCount,
    modelName: record.invocation?.modelName,
  };

  if (record.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, stats);
  }

  return successResult(record.result ?? "", stats);
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// ============================================================================

export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const subagentType = input.agent as string | undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  const effectiveModel = resolveModel({
    subagentType: subagentType ?? "general-purpose",
    agentConfig,
    config: __config,
    parentModelId,
    sessionOverrides,
  });

  if (effectiveModel) {
    input.model = effectiveModel;
    // Inject _modelOverride for renderCall when model differs from parent
    if (effectiveModel !== parentModelId) {
      const parsed = parseModelKey(effectiveModel);
      if (parsed) {
        input._modelOverride = parsed.modelId;
      }
    }
  }

  // Inject thinking from agent config if not explicitly passed
  if (input.thinking === undefined && agentConfig?.thinking !== undefined) {
    input.thinking = agentConfig.thinking;
  }
}
