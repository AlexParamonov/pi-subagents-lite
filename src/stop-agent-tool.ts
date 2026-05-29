/**
 * stop-agent-tool.ts — StopAgent tool execute handler.
 *
 * Registered in index.ts alongside the Agent tool.
 * Uses manager.abort(id) to stop running or queued agents.
 *
 * Response formats:
 *   - Success: "Stopped agent <short_id>"
 *   - Not found: "Agent <id> not found. Running agents: <type>·<short_id>, ..."
 *   - Already terminal: "Agent <id> is already <status>. Running agents: ..."
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { successResult, errorResult } from "./tool-execution.js";
import { manager } from "./index.js";
import { SHORT_ID_LENGTH } from "./agent-manager.js";

// ============================================================================
// Running agents list helper
// ============================================================================

/**
 * Build a compact list of running (or queued) agents.
 * Format: "type·short_id, type·short_id" — one line, easy for LLM to parse.
 */
function formatRunningAgents(): string {
  const agents = manager.listAgents().filter(
    (a) => a.status === "running" || a.status === "queued",
  );

  if (agents.length === 0) return "none";

  return agents
    .map((a) => `${a.type}·${a.id.slice(0, SHORT_ID_LENGTH)}`)
    .join(", ");
}

// ============================================================================
// Execute handler
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

  const record = manager.getRecord(agentId);

  if (!record) {
    // Agent not found → return error + list of running agents
    return errorResult(
      `Agent ${agentId} not found. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Check if already in a terminal state (not running or queued)
  if (record.status !== "running" && record.status !== "queued") {
    return successResult(
      `Agent ${agentId} is already ${record.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  // Attempt to stop the running/queued agent
  if (manager.abort(agentId)) {
    return successResult(`Stopped agent ${agentId.slice(0, SHORT_ID_LENGTH)}`);
  }

  return errorResult(`Failed to stop agent ${agentId}`);
}
