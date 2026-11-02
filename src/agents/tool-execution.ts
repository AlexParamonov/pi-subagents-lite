import { getStatusNote, formatStopReason } from "../status-note.ts";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentManager } from "./agent-manager.ts";
import type { SubagentAgentManager } from "./subagent-context.ts";
import type { AgentRecord, ThinkingLevel } from "../types.ts";
import { SHORT_ID_LENGTH } from "../types.ts";
import type { AgentConfig } from "./types.ts";
import { getAgentConfig, resolveTypeOrDiscover } from "./agent-types.ts";
import { getSessionContextPercent } from "./usage.ts";
import { computeSpawnTarget, surfaceSpawnTargetWarnings } from "../spawn/spawn-target.ts";

import { parseModelKey, findModelInRegistry, parseThinkingChoice } from "../utils.ts";
import { resolveThinkingLevel } from "../models/thinking-resolution.ts";
import { getPiModelThinkingLevel } from "../pi-settings.ts";
import { getPiInstance, getStore, getCoordinator, getManager } from "../shell.ts";
import { formatAgentStatusList } from "./agent-status.ts";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

/**
 * The thinking a spawn of this call would run with, predicted at call time:
 * frontmatter > pi per-model > defaultThinking. Undefined when nothing is
 * configured — the session is the source of truth once it exists. The
 * per-model term carries the spawn target's trust decision into the settings
 * read: computeSpawnTarget's validation plus trust decision, run silently
 * (execution owns the user-facing warnings). An untrusted target's own project
 * layer is then ignored, so its settings file cannot set the spawn's thinking
 * through the injected value (which wins as the explicit param), while the
 * user's global layer still applies — the scope the child's session is created
 * with.
 */
async function predictSpawnThinking(
  ctx: ExtensionContext,
  rawWorktree: unknown,
  agentConfig: AgentConfig | undefined,
  effectiveModel: string | undefined,
): Promise<ThinkingLevel | undefined> {
  // Non-string values count as omitted — computeSpawnTarget owns that
  // convention (raw arguments are unchecked), so the raw value passes through.
  const target = await computeSpawnTarget(ctx, rawWorktree);
  const modelKey = effectiveModel || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
  const parsed = parseModelKey(modelKey);
  const perModel =
    target.ok && parsed
      ? getPiModelThinkingLevel(target.resolvedPath ?? ctx.cwd, parsed.provider, parsed.modelId, {
          projectTrusted: target.projectTrusted,
        })
      : undefined;
  return resolveThinkingLevel({
    frontmatter: agentConfig?.thinkingLevel,
    perModel,
    defaultThinking: getStore().agent.defaultThinking,
    parentLevel: ctx.thinkingLevel,
  });
}

/**
 * Validate worktree_path and gate cross-repo trust, surfacing warnings via
 * ctx.ui through the shared notify policy. Errors are LLM-facing and
 * self-correctable. The raw value is unchecked — computeSpawnTarget owns the
 * counts-as-omitted convention for non-blank strings.
 */
async function resolveWorktree(
  ctx: ExtensionContext,
  rawWorktreePath: unknown,
): Promise<
  { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean } | { ok: false; error: string }
> {
  const target = await computeSpawnTarget(ctx, rawWorktreePath);
  surfaceSpawnTargetWarnings(ctx.ui, target);
  if (!target.ok) {
    return { ok: false, error: target.error };
  }
  return {
    ok: true,
    resolvedPath: target.resolvedPath,
    worktreeLabel: target.worktreeLabel,
    projectTrusted: target.projectTrusted,
  };
}

/**
 * Build a details record from an AgentRecord. Always includes type and
 * description; includeStatus adds status/outputFile/stopReason, includeStats
 * adds turn/token/cost/context/compaction/model fields.
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
    const stopReason = formatStopReason(record.lifecycle);
    if (stopReason) details.stopReason = stopReason;
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
    details.modelName = record.execution.session?.model?.name ?? record.display.invocation?.modelName;
    details.modelId = record.execution.session?.model?.id ?? record.display.invocation?.modelName;
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display. For error status, appends the
 * recorded error message so the nudge explains the failure.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  // Only the nudge path formats error-status records as text: the foreground
  // handler intercepts error status earlier and throws instead.
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}

// --- Tool execute handlers ---

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery.
  // Raw and unchecked: computeSpawnTarget treats non-strings as omitted.
  const resolved = await resolveWorktree(ctx, params.worktree_path);
  if (!resolved.ok) throw new Error(resolved.error);
  const validatedWorktreePath = resolved.resolvedPath;
  const worktreeLabel = resolved.worktreeLabel;
  const projectTrusted = resolved.projectTrusted;

  const type = (params.agent as string) || "general-purpose";
  // When worktree_path is set, also scan the target's .pi/agents/ directory, unless
  // the target is an untrusted cross-repo project (its agent types stay hidden).
  const targetAgentsDir = projectTrusted && validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
  const resolution = await resolveTypeOrDiscover(type, targetAgentsDir);
  if (resolution.kind === "ambiguous") {
    // Two or more registered types differ only by case — never a silent pick.
    throw new Error(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") {
    throw new Error(`Unknown agent type: ${type}`);
  }
  const resolvedType = resolution.key;

  const prompt = params.prompt as string;
  const description =
    (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  const maxTurns =
    (params.max_turns as number | undefined) ??
    getAgentConfig(resolvedType)?.maxTurns ??
    getStore().agent.defaultMaxTurns;

  const modelStr = params.model as string | undefined;
  const model = findModelInRegistry(modelStr, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: explicit param > agent config (frontmatter) > undefined.
  // Per-model and defaultThinking are deliberately NOT resolved here — the
  // spawn runner owns them (its trust-gated settings read keeps per-model
  // above defaultThinking; folding them into this explicit param would shadow
  // per-model). When the listener ran, it already injected the full chain.
  // A `parent` value resolves here because the explicit param and the stored
  // invocation must never carry it; the parent's level needs no trust gate.
  const thinkingLevel = resolveThinkingLevel({
    explicit: parseThinkingChoice(params.thinking as string | undefined),
    frontmatter: getAgentConfig(resolvedType)?.thinkingLevel,
    parentLevel: ctx.thinkingLevel,
  });

  const coordinator = getCoordinator()!;
  // An active MessageAgent in the child loadout also promotes this spawn once
  // the child session has bound its final tool set.
  const startsInBackground = runInBackground || getStore().agent.forceBackground;

  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    projectTrusted,
    invocation: { modelName, thinkingLevel, maxTurns, runInBackground: startsInBackground },
    runInBackground: startsInBackground,
    signal: startsInBackground ? undefined : signal,
  });

  const { agentId, record } = result;
  const isBackground = result.isBackground;

  // Store toolCallId in record for call renderer to find agent
  if (_toolCallId) {
    record.display.toolCallId = _toolCallId;
  }

  if (isBackground) {
    const reason = !startsInBackground ? " MessageAgent is active, so it was started in the background." : "";
    const suffix = `Success! You delegated to an agent.${reason} A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const details = buildAgentDetails(record);
    details.agentId = agentId;
    details.status = record.lifecycle.status;
    return successResult(`[${label}] ${suffix}`, details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    throw new Error(`Agent failed: ${record.error || "unknown error"}`);
  }

  return successResult(formatResultContent(record), details);
}

// --- Agent id resolution and failure lists, shared by the agent tools ---

/** The id form tool output prints and the model quotes back (ADR-0010). */
function shortId(record: AgentRecord): string {
  return record.id.slice(0, SHORT_ID_LENGTH);
}

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!
    .listAgents()
    .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued");

  if (agents.length === 0) return "none";

  return agents.map((a) => `${shortId(a)} (${a.display.type})`).join(", ");
}

/**
 * Resolve tool input to exactly one retained record: exact id, else an unambiguous
 * prefix (ADR-0010). A blank id is a missing id, so resolution never sees a prefix
 * that matches every record; ambiguity names every candidate by full id, the only
 * place full ids are printed. `notFoundDetail` names the agents the calling tool can
 * act on, because stop and message have opposite preconditions.
 */
function resolveAgent(
  agentId: unknown,
  notFoundDetail: () => string,
  managerOverride?: Pick<AgentManager, "matchAgents">,
): AgentRecord {
  const id = (agentId as string | undefined)?.trim() ?? "";
  if (!id) throw new Error("agent_id is required");

  const manager = managerOverride ?? getManager();
  if (!manager) throw new Error("Agent manager is unavailable");
  const matches = manager.matchAgents(id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous agent id ${id}. Matching agents: ${matches.map((m) => m.id).join(", ")}. Use a longer id.`,
    );
  }
  throw new Error(`Agent ${id} not found. ${notFoundDetail()}`);
}

// --- StopAgent execute handler ---

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const manager = getManager()!;
  const record = resolveAgent(params.agent_id, () => `Running agents: ${formatRunningAgents()}`);

  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${shortId(record)} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  if (manager.abort(record.id, "agent")) {
    return successResult(`Stopped agent ${shortId(record)}`);
  }

  throw new Error(`Failed to stop agent ${shortId(record)}`);
}

// --- MessageAgent execute handler ---

/** Bounded list of every retained agent, settled ones included: a message needs a
 * live session, not a run, so the addressable set is wider than StopAgent's.
 */
function formatKnownAgents(manager: Pick<AgentManager, "listAgents">, limit: number): string {
  const agents = manager.listAgents();
  if (agents.length === 0) return "none";
  return formatAgentStatusList(agents, limit);
}

/**
 * Give an existing agent more input through the manager's steer/continue seam: a
 * running target takes the message at its next turn boundary, a settled target with
 * a live session restarts on it. No agent is created and no queue is owned here. The
 * report names what was queued, never a promise that it was read before the run ended.
 */
export async function executeMessageAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
  managerOverride?: SubagentAgentManager,
  agentStatusLimit?: number,
): Promise<any> {
  const text = (params.message as string | undefined)?.trim() ?? "";
  if (!text) throw new Error("message is required");

  const manager = managerOverride ?? getManager();
  if (!manager) throw new Error("Agent manager is unavailable");
  const limit = agentStatusLimit ?? getStore().agent.agentStatusLimit;
  const record = resolveAgent(params.agent_id, () => `Known agents: ${formatKnownAgents(manager, limit)}`, manager);
  const wasRunning = record.lifecycle.status === "running";

  if (!wasRunning && !record.execution.session) {
    return successResult(
      `Agent ${shortId(record)} is ${record.lifecycle.status} with no live session. Message not sent.`,
    );
  }

  if (!(await manager.steer(record.id, text))) {
    throw new Error(
      `Failed to send message to agent ${shortId(record)}. ` +
        `It may still be settling or its concurrency slot is full. Try again.`,
    );
  }

  return successResult(wasRunning ? "Sent (steered)" : "Sent (continued)");
}

// --- Tool_call listener — inject model into Agent tool calls ---

export async function toolCallListener(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const subagentType = input.agent as string | undefined;
  const agentConfig = subagentType ? getAgentConfig(subagentType) : undefined;

  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

  const effectiveModel = getStore().modelFor(subagentType ?? "general-purpose", parentModelId, agentConfig);

  if (effectiveModel) {
    input.model = effectiveModel;
    // Always inject _modelOverride for renderCall
    const parsed = parseModelKey(effectiveModel);
    if (parsed) {
      input._modelOverride = parsed.modelId;
    }
  }

  // Inject the spawn-effective thinking when the call carries none. The
  // injected value becomes the explicit param at execution, so it must mirror
  // the runtime chain — an injection that diverged would change behavior, not
  // just display.
  if (input.thinking === undefined) {
    input.thinking = await predictSpawnThinking(ctx, input.worktree_path, agentConfig, effectiveModel);
  }
}
