/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool,
 * plus nudge scheduling and activity tracking helpers.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./types.js";
import { SHORT_ID_LENGTH } from "./types.js";
import type { SpawnOptions as AgentManagerSpawnOptions } from "./agent-manager.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import { resolveType, getAgentConfig, discoverNewAgents } from "./agent-types.js";
import { resolveModel } from "./model-precedence.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "./usage.js";
import { validateWorktreePath } from "./worktree-validator.js";

// Shared state imported from state.ts
import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "./utils.js";
import {
  __config,
  sessionOverrides,
  piInstance,
  agentActivity,
  getManager,
  getWidget,
  sessionCtx,
} from "./state.js";

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
 * Exported for use by the menu spawn flow.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
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
// buildAgentDetails — consolidated stats/details construction
// ============================================================================

interface AgentDetailsOptions {
  /** Include full stats (turns, tokens, context%, compactions, cost). Default: false. */
  includeStats?: boolean;
  /** Include status and outputFile. Default: false. */
  includeStatus?: boolean;
  /** Override the turnCount (e.g. from activity tracker). Default: record.turnCount. */
  turnCount?: number;
}

/**
 * Build a details Record from an AgentRecord, controlled by options.
 *
 * Always includes `type` and `description`. Optional groups:
 * - `includeStatus`: adds `status`, `outputFile`
 * - `includeStats`: adds turn/token/cost/context/compaction/model fields
 *
 * Consolidates the identical field-selection logic previously duplicated
 * across emitIndividualNudge, executeSpawnForeground, and executeSpawnBackground.
 */
export function buildAgentDetails(
  record: AgentRecord,
  options?: AgentDetailsOptions,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (options?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
  }

  if (options?.includeStats) {
    const totalTokens = getLifetimeTotal(record.stats.lifetimeUsage);
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = options.turnCount ?? record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    details.tokens = totalTokens;
    details.contextPercent = getSessionContextPercent(record.execution.session);
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
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
      emitIndividualNudge(id, getManager()?.getRecord(id));
    }
  }, NUDGE_DELAY_MS);
}

function emitIndividualNudge(agentId: string, record?: AgentRecord): void {
  if (!record) return;

  const details = buildAgentDetails(record, {
    includeStats: true,
    includeStatus: true,
    turnCount: record.stats.turnCount ?? agentActivity.get(agentId)?.turnCount,
  });

  piInstance.sendMessage(
    {
      customType: "subagent-result",
      content: `[Subagent "${record.display.type}" ${record.lifecycle.status}]\n\n${record.result ?? ""}`,
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
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  let validatedWorktreePath: string | undefined;
  let worktreeLabel: string | undefined;
  if (rawWorktreePath && rawWorktreePath.trim() !== "") {
    try {
      const parentCwd = sessionCtx?.cwd ?? ctx.cwd;
      const validation = await validateWorktreePath(piInstance, rawWorktreePath, parentCwd);
      if (!validation.ok) {
        return errorResult(validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
      worktreeLabel = validation.label;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`worktree_path validation failed: ${msg}`);
    }
  }

  const type = (params.agent as string) || "general-purpose";
  let resolvedType = resolveType(type);
  if (!resolvedType) {
    // Not found in registry — try scanning filesystem for agents added during the session.
    // When worktree_path is set, also scan the worktree's .pi/agents/ directory.
    const worktreeDir = validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
    await discoverNewAgents(worktreeDir);
    resolvedType = resolveType(type);
  }
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns = params.max_turns as number | undefined ?? getAgentConfig(resolvedType)?.maxTurns;

  const modelStr = params.model as string | undefined;
  const model = findModelInRegistry(modelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: explicit param > agent config (frontmatter) > undefined (inherit)
  const thinkingLevel = parseThinkingLevel(params.thinking as string | undefined)
    ?? getAgentConfig(resolvedType)?.thinking;

  const spawnOptions: AgentManagerSpawnOptions = {
    description,
    model,
    maxTurns,
    thinkingLevel,
    modelKey,
    invocation: { modelName },
    graceTurns: __config.agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
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

  const agentId = getManager().spawn(piInstance, ctx, resolvedType, prompt, {
    ...spawnOptions,
    isBackground: true,
    ...callbacks,
  });
  backgroundAgentIds.add(agentId);
  agentActivity.set(agentId, state);
  getWidget()?.ensureTimer();
  getWidget()?.update();

  const record = getManager().getRecord(agentId)!;
  const details = buildAgentDetails(record);
  const suffix = `A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
  const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";

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

  const fgId = getManager().spawn(piInstance, ctx, resolvedType, prompt, {
    ...spawnOptions,
    ...fgCallbacks,
    isBackground: false,
  });
  agentActivity.set(fgId, fgState);
  getWidget()?.ensureTimer();

  const record = getManager().getRecord(fgId)!;
  await record.execution.promise;

  agentActivity.delete(fgId);
  getWidget()?.markFinished(fgId);
  getWidget()?.update();

  const stats = buildAgentDetails(record, {
    includeStats: true,
    turnCount: fgState.turnCount,
  });

  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, stats);
  }

  return successResult(record.result ?? "", stats);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "type·short_id, type·short_id" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager().listAgents().filter(
    (a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.display.type}·${a.id.slice(0, SHORT_ID_LENGTH)}`)
    .join(", ");
}

// ============================================================================
// StopAgent execute handler
// ============================================================================

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const agentId = params.agent_id as string | undefined;

  if (!agentId) {
    return errorResult("agent_id is required");
  }

  const record = getManager().getRecord(agentId);

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Check if already in a terminal state (not running or queued)
  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Attempt to stop the running/queued agent
  if (getManager().abort(agentId)) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
}

// ============================================================================
// Tool_call listener — inject model into Agent tool calls
// =============================================================================

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
    // Always inject _modelOverride for renderCall
    const parsed = parseModelKey(effectiveModel);
    if (parsed) {
      input._modelOverride = parsed.modelId;
    }
  }

  // Inject thinking from agent config if not explicitly passed
  if (input.thinking === undefined && agentConfig?.thinking !== undefined) {
    input.thinking = agentConfig.thinking;
  }
}
