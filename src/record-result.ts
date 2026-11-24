import type { AgentRecord } from "./types.ts";
import { getSessionContextPercent } from "./agents/usage.ts";
import { formatStopReason, getStatusNote } from "./status-note.ts";
import { workflowDisplayName } from "./ui/format.ts";

/**
 * Build a details record from an AgentRecord. Always includes type, description
 * and the reply's opening line for the collapsed result rows; includeStatus adds
 * status/outputFile/stopReason, includeStats adds turn/token/cost/context/compaction/model fields.
 * A Workflow run's snapshot also carries displayName, the name agent-registry surfaces cannot
 * derive from the type.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  // A workflow name is not a registered agent type, so the surfaces that resolve names through the
  // agent registry need the run's own name on the snapshot to avoid calling every run "Agent".
  if (record.workflow) details.displayName = workflowDisplayName(record.workflow);

  const openingLine = record.result?.split("\n").find((line) => line.trim());
  if (openingLine) {
    details.replyPreview = openingLine.trim();
  }

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

/** The record's answer as used by the tool and the settlement notification. */
export function formatResultContent(record: AgentRecord): string {
  // The Workflow publisher already supplied the whole outcome, including any reason.
  if (record.workflow) return record.error ?? record.result ?? "";
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}
