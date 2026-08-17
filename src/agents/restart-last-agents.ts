/**
 * restart-last-agents.ts — Find and replay Agent tool calls from session history.
 *
 * Reads the current session's entry list, locates the most recent assistant
 * message containing Agent tool calls, and replays them via the coordinator.
 * Running agents are skipped.
 */

import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UICtx } from "../ui/agent-widget.js";
import type { ToolCall } from "@earendil-works/pi-ai";
import { getCoordinator, getManager, getPiInstance, getStore, getWidget } from "../shell.js";
import { parseThinkingLevel, findModelInRegistry } from "../utils.js";
import { resolveTypeOrDiscover, getAgentConfig } from "./agent-types.js";

/** Extracted parameters from a historical Agent tool call. */
export interface AgentCallParams {
  prompt: string;
  description?: string;
  agent?: string;
  worktree_path?: string;
  model?: string;
  thinking?: string;
  run_in_background?: boolean;
  max_turns?: number;
}

/** Result of a restart attempt. */
export interface RestartResult {
  restarted: string[];
  skipped: string[];
}

/**
 * Find Agent tool calls from the most recent assistant message in session entries.
 *
 * Returns the arguments of every `Agent` tool call found in the latest assistant
 * message that contains at least one. Returns an empty array if none exist.
 */
export function findLastAgentCallsFromEntries(entries: SessionEntry[]): AgentCallParams[] {
  // Walk backwards to find the most recent assistant message with Agent tool calls.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;

    const agentCalls: AgentCallParams[] = [];
    for (const block of msg.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as ToolCall).type === "toolCall" &&
        (block as ToolCall).name === "Agent"
      ) {
        agentCalls.push((block as ToolCall).arguments as AgentCallParams);
      }
    }

    if (agentCalls.length > 0) return agentCalls;
  }
  return [];
}

/**
 * Restart agents from the most recent Agent tool calls in session history.
 *
 * Skips agents whose type + description match a currently running agent.
 * Returns what was restarted and what was skipped.
 */
export async function handleRestartLastAgents(ctx: ExtensionCommandContext): Promise<RestartResult> {
  const entries = ctx.sessionManager.getEntries();
  const calls = findLastAgentCallsFromEntries(entries);

  if (calls.length === 0) {
    return { restarted: [], skipped: [] };
  }

  const manager = getManager();
  const coordinator = getCoordinator();
  const pi = getPiInstance();

  if (!manager || !coordinator || !pi) {
    return { restarted: [], skipped: [] };
  }

  // Build a set of running agent "keys" (type + description) to skip.
  const running = new Set(
    manager
      .listAgents()
      .filter((a) => a.lifecycle.status === "running" || a.lifecycle.status === "queued")
      .map((a) => `${a.display.type}::${a.display.description}`),
  );

  const restarted: string[] = [];
  const skipped: string[] = [];

  for (const call of calls) {
    const type = call.agent || "general-purpose";
    const description = call.description || call.prompt.split("\n")[0].slice(0, 80) || call.prompt.slice(0, 80);
    const key = `${type}::${description}`;

    if (running.has(key)) {
      skipped.push(`${type}: ${description} (already running)`);
      continue;
    }

    // Resolve type (with discovery for worktree-local agents)
    const targetAgentsDir =
      call.worktree_path && getStore().agent.loadExtensionsImplicitly !== false
        ? `${call.worktree_path}/.pi/agents`
        : undefined;
    const resolution = await resolveTypeOrDiscover(type, targetAgentsDir);
    if (resolution.kind === "not-found" || resolution.kind === "ambiguous") {
      skipped.push(`${type}: ${description} (unknown type)`);
      continue;
    }

    const resolvedType = resolution.key;
    const agentConfig = getAgentConfig(resolvedType);
    const maxTurns = call.max_turns ?? agentConfig?.maxTurns ?? getStore().agent.defaultMaxTurns;

    // Resolve model: use current config (modelFor) not historical call.model
    const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const effectiveModelStr = getStore().modelFor(resolvedType, parentModelId, agentConfig);
    const model = effectiveModelStr ? findModelInRegistry(effectiveModelStr, ctx.modelRegistry, ctx.model) : undefined;
    const modelKey = model ? `${model.provider}/${model.id}` : undefined;

    // Inject thinking: explicit > agent config > store default
    const thinkingLevel =
      parseThinkingLevel(call.thinking) ?? agentConfig?.thinkingLevel ?? getStore().agent.defaultThinking;

    // Ensure widget is set up so spawned agents appear in the UI
    const widget = getWidget();
    if (widget) {
      widget.setUICtx(ctx.ui as unknown as UICtx);
      widget.ensureTimer();
    }

    // Always spawn as background so we can send nudges (steer messages).
    // Same approach as the steer settled branch in conversation-viewer.
    try {
      await coordinator.spawn(pi, ctx, {
        type: resolvedType,
        prompt: call.prompt,
        description,
        model,
        modelKey,
        maxTurns,
        thinkingLevel,
        graceTurns: getStore().agent.graceTurns,
        worktreePath: call.worktree_path,
        invocation: {
          modelName: model?.id,
          thinkingLevel,
          maxTurns,
        },
        runInBackground: true,
      });
      restarted.push(`${resolvedType}: ${description}`);
    } catch (err) {
      skipped.push(`${resolvedType}: ${description} (spawn failed: ${String(err).slice(0, 80)})`);
    }
  }

  return { restarted, skipped };
}
