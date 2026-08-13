import { getStatusNote, formatStopReason } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import { getAgentDir, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { resolveType, getAgentConfig, discoverNewAgents, type TypeResolution } from "./agent-types.js";
import { getSessionContextPercent } from "./usage.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";
import { resolveSubagentTrust, createSubagentTrustDeps, untrustedProjectWarning } from "../spawn/project-trust.js";

import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "../utils.js";
import { getPiInstance, getSessionCtx, getStore, getCoordinator, getManager } from "../shell.js";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
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
  // handler intercepts error status earlier and returns an errorResult instead.
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}

// --- Tool execute handlers ---

/**
 * Validate worktree_path and gate cross-repo trust, surfacing warnings via
 * ctx.ui. Errors are LLM-facing and self-correctable.
 */
async function resolveWorktree(
  ctx: ExtensionContext,
  rawWorktreePath: string | undefined,
): Promise<
  { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean } | { ok: false; error: string }
> {
  // Empty/whitespace → omitted: nothing to validate, nothing to gate.
  if (!rawWorktreePath || rawWorktreePath.trim() === "") {
    return { ok: true, projectTrusted: true };
  }
  try {
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    const warnings: string[] = [];
    const onWarning = (msg: string) => {
      warnings.push(msg);
    };
    const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
    if (!validation.ok) {
      for (const msg of warnings) {
        if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
      }
      return { ok: false, error: validation.error };
    }

    const resolvedPath = validation.resolvedPath!; // non-empty paths always resolve

    // Cross-repo targets are gated by pi's trust framework. Same-repo paths
    // are never gated; an untrusted target still spawns but with its project
    // resources ignored and a warning surfaced.
    const projectTrusted = resolveSubagentTrust({
      targetPath: resolvedPath,
      sameRepo: validation.sameRepo === true,
      deps: createSubagentTrustDeps(getAgentDir(), parentCwd),
    });
    if (!projectTrusted && ctx.ui?.notify) {
      ctx.ui.notify(`[pi-subagents-lite] ${untrustedProjectWarning(resolvedPath)}`, "warning");
    }
    return {
      ok: true,
      resolvedPath,
      worktreeLabel: validation.label,
      projectTrusted,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worktree_path validation failed: ${msg}` };
  }
}

/**
 * Resolve a type name, refreshing the registry from the scan dirs when it is not
 * found. Agents added to the filesystem after startup, or to a worktree's
 * .pi/agents/ directory, become resolvable on the retry.
 */
async function resolveTypeWithDiscovery(type: string, worktreeAgentsDir: string | undefined): Promise<TypeResolution> {
  let resolution = resolveType(type);
  if (resolution.kind === "not-found") {
    await discoverNewAgents(worktreeAgentsDir);
    resolution = resolveType(type);
  }
  return resolution;
}

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  const resolved = await resolveWorktree(ctx, rawWorktreePath);
  if (!resolved.ok) return errorResult(resolved.error);
  const validatedWorktreePath = resolved.resolvedPath;
  const worktreeLabel = resolved.worktreeLabel;
  const projectTrusted = resolved.projectTrusted;

  const type = (params.agent as string) || "general-purpose";
  // When worktree_path is set, also scan the target's .pi/agents/ directory, unless
  // the target is an untrusted cross-repo project (its agent types stay hidden).
  const targetAgentsDir = projectTrusted && validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
  const resolution = await resolveTypeWithDiscovery(type, targetAgentsDir);
  if (resolution.kind === "ambiguous") {
    // Two or more registered types differ only by case — never a silent pick.
    return errorResult(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") {
    return errorResult(`Unknown agent type: ${type}`);
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

  // Resolve thinking: explicit param > agent config (frontmatter) > spawn options default > undefined (inherit)
  const thinkingLevel =
    parseThinkingLevel(params.thinking as string | undefined) ??
    getAgentConfig(resolvedType)?.thinkingLevel ??
    getStore().agent.defaultThinking;

  const coordinator = getCoordinator()!;
  // Background spawns (explicit or forceBackground) never bind to the parent
  // run's interrupt signal — only foreground spawns can be interrupted.
  const isBackground = runInBackground || getStore().agent.forceBackground;

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
    invocation: { modelName, thinkingLevel, maxTurns },
    runInBackground: isBackground,
    signal: isBackground ? undefined : signal,
  });

  const { agentId, record } = result;

  if (isBackground) {
    const suffix = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
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

// --- Running agents list helper (used by executeStopAgentTool) ---

/**
 * Build a compact list of running (or queued) agents.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = getManager()!
    .listAgents()
    .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued");

  if (agents.length === 0) return "none";

  return agents.map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`).join(", ");
}

// --- StopAgent execute handler ---

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
    return errorResult(`Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`);
  }

  if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  if (getManager()!.abort(agentId, "agent")) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
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

  // Inject thinking if not explicitly passed: agent frontmatter > spawn options default
  if (input.thinking === undefined) {
    input.thinking = agentConfig?.thinkingLevel ?? getStore().agent.defaultThinking;
  }
}
