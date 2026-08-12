/**
 * agent-status.ts — AgentStatus tool implementation.
 *
 * A lightweight informational tool that lists all agents (running, queued,
 * completed, stopped, error) from the manager and returns a clear message
 * about not polling for status.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { getManager } from "../shell.js";

function formatAgent(record: AgentRecord): string {
  const shortId = record.id.slice(0, SHORT_ID_LENGTH);
  return `${shortId} (${record.display.type}) ${record.lifecycle.status}`;
}

/** List all agents with type, short ID, and status, plus a don't-poll nudge. */
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

  const formatted = agents.map(formatAgent).join(", ");
  return {
    content: [{ type: "text", text: `${formatted}\n\n${nudge}` }],
  };
}
