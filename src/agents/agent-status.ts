/**
 * agent-status.ts — AgentStatus tool implementation.
 *
 * A lightweight informational tool that lists agents from the manager and
 * returns a clear message about not polling for status. Output is
 * limit-bounded: every in-progress agent (running, queued) always appears,
 * then settled agents (all other statuses) most-recently-settled first,
 * capped at the configured agentStatusLimit. Hidden settled agents are
 * summarized in one line.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { getManager, getStore } from "../shell.js";

function formatAgent(record: AgentRecord): string {
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  return `${shortId} (${record.display.type}) ${record.lifecycle.status}`;
}

/** In-progress agents are always shown; every other status is settled (issue constraints). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}

/** Most recently settled first. completedAt is stamped on every terminal path
 * (settlement chain, stop, queued failure, dispose) and cleared on continue, so
 * the startedAt fallback is defensive only.
 */
function bySettledDesc(a: AgentRecord, b: AgentRecord): number {
  return (b.lifecycle.completedAt ?? b.lifecycle.startedAt) - (a.lifecycle.completedAt ?? a.lifecycle.startedAt);
}

/**
 * List text for non-empty agents: every in-progress agent in manager order, then
 * at most `limit` settled agents most-recently-settled first, with a summary
 * line when settled agents are hidden.
 */
function formatAgentStatusList(agents: AgentRecord[], limit: number): string {
  const active: AgentRecord[] = [];
  const settled: AgentRecord[] = [];
  for (const record of agents) {
    if (isActive(record)) active.push(record);
    else settled.push(record);
  }

  // Recency is settlement time, never start time (issue constraint).
  settled.sort(bySettledDesc);

  const shownSettled = settled.slice(0, limit);
  const hidden = settled.length - shownSettled.length;

  const lines = [...active, ...shownSettled].map(formatAgent).join(", ");
  return hidden > 0 ? `${lines}\nand ${hidden} more settled agents` : lines;
}

/** List active agents plus at most `limit` settled agents, with a summary line when settled are hidden. */
export async function executeAgentStatusTool(
  _toolCallId: string,
  _params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const manager = getManager()!;
  const agents = manager.listAgents();

  const nudge = "Don't poll — you'll receive notifications when agents complete.";

  if (agents.length === 0) {
    return {
      content: [{ type: "text", text: `No agents running or completed.\n\n${nudge}` }],
    };
  }

  const listText = formatAgentStatusList(agents, getStore().agent.agentStatusLimit);
  return {
    content: [{ type: "text", text: `${listText}\n\n${nudge}` }],
  };
}
