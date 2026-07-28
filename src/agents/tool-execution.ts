import { getStatusNote } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import type { AgentConfig } from "./types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, getAgentConfig, discoverNewAgents, resolveWorktreeAgent } from "./agent-types.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "../utils.js";
import { normalizeThinkingLevel } from "../models/thinking.js";
import {
  getPiInstance,
  getSessionCtx,
  getStore,
  getCoordinator,
  getManager,
} from "../shell.js";

// ============================================================================
// Tool result helpers
// ============================================================================

/** Shortcut for a successful tool result. */
function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/** Shortcut for an error tool result. */
function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

// ============================================================================
// Activity tracking
// ============================================================================

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
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.contextPercent = getSessionContextPercent(record.execution.session);
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  return (record.result ?? "") + getStatusNote(record.lifecycle);
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
      const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
      const warnings: string[] = [];
      const onWarning = (msg: string) => { warnings.push(msg); };
      const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
      if (!validation.ok) {
        for (const msg of warnings) {
          if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
        }
        return errorResult(validation.error);
      }
      validatedWorktreePath = validation.resolvedPath;
      worktreeLabel = validation.label;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`worktree_path validation failed: ${msg}`);
    }
  }

  const rawType = params.agent;
  if (typeof rawType !== "string" || rawType.trim() === "") {
    return errorResult("Agent type is required");
  }
  const type = rawType.trim();
  // A worktree definition is a local overlay over a fresh parent merge. Never
  // install it in the parent registry: concurrent worktree calls must retain
  // their own resolved config all the way to the coordinator snapshot.
  let resolvedType: string | undefined;
  let agentConfig: AgentConfig | undefined;
  const discoveryOptions = {
    disableDefaultAgents: getStore().agent.disableDefaultAgents,
  };
  if (validatedWorktreePath) {
    const local = await resolveWorktreeAgent(
      type,
      `${validatedWorktreePath}/.pi/agents`,
      discoveryOptions,
    );
    resolvedType = local?.type;
    agentConfig = local?.config;
  } else {
    // Non-worktree refreshes still update the global parent registry.
    await discoverNewAgents(discoveryOptions);
    resolvedType = resolveType(type);
    agentConfig = resolvedType ? getAgentConfig(resolvedType) : undefined;
  }
  if (!resolvedType) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns = params.max_turns as number | undefined ?? agentConfig?.maxTurns;
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const explicitModel = params._modelFromSettings === true
    ? undefined
    : typeof params.model === "string" ? params.model : undefined;
  const modelSetting = getStore().modelSettingFor(resolvedType, parentModelId, agentConfig, explicitModel);
  let model: ReturnType<typeof findModelInRegistry>;
  if (explicitModel !== undefined) {
    const parsed = parseModelKey(explicitModel);
    model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (!model) return errorResult(`Model not found: ${explicitModel}`);
  } else {
    model = findModelInRegistry(modelSetting.value, ctx.modelRegistry, ctx.model);
  }
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  const explicitThinking = params._thinkingFromSettings === true
    ? undefined
    : parseThinkingLevel(params.thinking as string | undefined);
  const thinkingSetting = getStore().thinkingSettingFor(
    resolvedType,
    ctx.thinkingLevel,
    agentConfig,
    explicitThinking,
  );
  const thinkingLevel = thinkingSetting.value;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    agentConfig,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    invocation: { modelName },
    runInBackground: runInBackground || getStore().agent.forceBackground,
  });

  const { agentId, record } = result;

  if (runInBackground || getStore().agent.forceBackground) {
    // Background: return immediately
    const suffix = `A notification will arrive when done - User asks you not to poll, check status or duplicate the delegated work.\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const details = buildAgentDetails(record);
    return successResult(`[${label}] ${suffix}`, details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
  }

  return successResult(formatResultContent(record), details);
}

// ============================================================================
// Running agents list helper (used by executeStopAgentTool)
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!.listAgents().filter(
    (a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`)
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

  const record = getManager()!.getRecord(agentId);

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
  if (getManager()!.abort(agentId, "agent")) {
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
  // Preserve an explicitly requested model in the invocation display even for
  // worktree calls. Only parent-derived defaults must wait for local discovery.
  if (typeof input.model === "string") {
    const parsed = parseModelKey(input.model);
    if (parsed) input._modelOverride = parsed.modelId;
  }
  // Local worktree config is resolved asynchronously by executeAgentTool.
  // Do not prefill this call from the parent registry/model: those values
  // would be shown in the tool invocation but ignored by the local overlay.
  if (typeof input.worktree_path === "string" && input.worktree_path.trim() !== "") return;

  const requestedType = input.agent as string | undefined;
  const subagentType = requestedType ? resolveType(requestedType) : undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  if (subagentType && input.model === undefined) {
    const effectiveModel = getStore().modelFor(subagentType, parentModelId, agentConfig);
    if (effectiveModel) {
      input.model = effectiveModel;
      input._modelFromSettings = true;
    }
  }
  if (typeof input.model === "string") {
    const parsed = parseModelKey(input.model);
    if (parsed) input._modelOverride = parsed.modelId;
  }

  if (subagentType && input.thinking === undefined) {
    const setting = getStore().thinkingSettingFor(subagentType, ctx.thinkingLevel, agentConfig);
    input.thinking = setting.value;
    input._thinkingFromSettings = true;
  }

  // Keep the tool invocation display aligned with the normalized runtime
  // value. executeAgentTool and the coordinator normalize again defensively.
  const invocationModel = findModelInRegistry(
    typeof input.model === "string" ? input.model : undefined,
    ctx.modelRegistry,
    ctx.model,
  );
  const requestedThinking = parseThinkingLevel(input.thinking as string | undefined);
  const normalizedThinking = normalizeThinkingLevel(invocationModel, requestedThinking ?? ctx.thinkingLevel);
  if (normalizedThinking !== undefined) input.thinking = normalizedThinking;
}
