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
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, getAgentConfig, discoverNewAgents, resolveAgentCatalog, resolveTypeInCatalog } from "./agent-types.js";
import { getSessionUsageSnapshot } from "./usage.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "../utils.js";
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
    const liveSnapshot = getSessionUsageSnapshot(record.execution.session);
    const terminalSnapshot = {
      contextPercent: record.stats.contextPercent,
      contextWindow: record.stats.contextWindow,
      autoCompactionEnabled: record.stats.autoCompactionEnabled,
      usingSubscription: record.stats.usingSubscription,
    };
    const usageSnapshot = record.lifecycle.completedAt != null
      && (terminalSnapshot.contextPercent != null || terminalSnapshot.contextWindow != null)
      ? terminalSnapshot
      : (liveSnapshot ?? terminalSnapshot);

    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.cacheRead = record.stats.cacheRead;
    details.cacheWrite = record.stats.lifetimeUsage.cacheWrite;
    details.latestCacheHitRate = record.stats.latestCacheHitRate;
    details.contextPercent = usageSnapshot.contextPercent ?? null;
    details.contextWindow = usageSnapshot.contextWindow;
    details.autoCompactionEnabled = usageSnapshot.autoCompactionEnabled;
    details.usingSubscription = usageSnapshot.usingSubscription;
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.display.invocation?.modelName;
    details.thinkingLevel = record.display.invocation?.thinkingLevel;
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

  const type = (params.agent as string) || "general-purpose";
  const trustedWorktreeDir = validatedWorktreePath && (ctx.isProjectTrusted?.() ?? false)
    ? `${validatedWorktreePath}/.pi/agents`
    : undefined;

  // Worktree catalogs are local to this tool call. Never use the shared
  // registry for a worktree name: it may be an override of a parent type.
  let resolvedType: string | undefined;
  let agentConfig;
  if (trustedWorktreeDir) {
    const catalog = await resolveAgentCatalog(trustedWorktreeDir, {
      disableDefaultAgents: getStore().agent.disableDefaultAgents,
    });
    resolvedType = resolveTypeInCatalog(catalog, type);
    agentConfig = resolvedType ? catalog.get(resolvedType) : undefined;
  } else {
    resolvedType = resolveType(type);
    if (!resolvedType) {
      await discoverNewAgents({ disableDefaultAgents: getStore().agent.disableDefaultAgents });
      resolvedType = resolveType(type);
    }
    agentConfig = resolvedType ? getAgentConfig(resolvedType) : undefined;
  }
  if (!resolvedType || !agentConfig) return errorResult(`Unknown agent type: ${type}`);

  const prompt = params.prompt as string;
  const description = (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns = params.max_turns as number | undefined ?? agentConfig.maxTurns;

  // The listener intentionally leaves worktree calls alone. Resolve all
  // precedence here, after the trusted worktree definition is known.
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const modelStr = params.model as string | undefined
    ?? getStore().modelFor(resolvedType, parentModelId, agentConfig);
  const model = findModelInRegistry(modelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;
  const modelName = model?.id;
  const thinkingLevel = parseThinkingLevel(params.thinking as string | undefined)
    ?? agentConfig.thinkingLevel;

  // Use SpawnCoordinator for unified spawn path
  const coordinator = getCoordinator()!;
  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    agentConfig,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    invocation: { modelName, thinkingLevel },
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
  // A worktree may override a global type. Its config is resolved only after
  // validation in executeAgentTool, not from the parent registry here.
  if (typeof input.worktree_path === "string" && input.worktree_path.trim() !== "") return;
  const subagentType = input.agent as string | undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  const effectiveModel = getStore().modelFor(
    subagentType ?? "general-purpose",
    parentModelId,
    agentConfig,
  );

  if (effectiveModel) {
    input.model = effectiveModel;
    // Always inject _modelOverride for renderCall
    const parsed = parseModelKey(effectiveModel);
    if (parsed) {
      input._modelOverride = parsed.modelId;
    }
  }

  // Inject thinking from agent config if not explicitly passed
  if (input.thinking === undefined && agentConfig?.thinkingLevel !== undefined) {
    input.thinking = agentConfig.thinkingLevel;
  }
}
