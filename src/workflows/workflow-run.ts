/**
 * workflow-run.ts — One foreground Workflow run, from create to the server's terminal result.
 *
 * The record belongs to AgentManager and the endpoint to `workflow-client.ts`; this module is the
 * loop that decides what a run means: GET's terminal outcome settles it, an acknowledged stop
 * outranks the endpoint's footprint, and a run that cannot be read is handed back rather than
 * guessed at. `docs/adr/0013-get-authoritative-workflow-client.md` is the reasoning behind that.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { WorkflowSettlementStatus } from "../types.ts";
import { plainText } from "../ui/sanitize.ts";
import { formatTerminalResult } from "./terminal-result.ts";
import type { WorkflowEndpoint } from "./endpoints.ts";
import type { WorkflowClient, WorkflowDisplayItem, WorkflowNodeStatus, WorkflowOutcome } from "./workflow-client.ts";

/** What a run needs to be sent, and where its updates go. */
export interface WorkflowRunArgs {
  name: string;
  /** Resolved and frozen before the first request. */
  endpoint: WorkflowEndpoint;
  definition: Record<string, unknown>;
  prompt: string;
  workingDir: string;
  toolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
}

/** The shared record store, and the client bound to the run's endpoint. */
export interface WorkflowRunPorts {
  manager: AgentManager;
  client: WorkflowClient;
}

/** What an acknowledged stop leaves the record: the stop, and no terminal result. */
const STOPPED = "Workflow run stopped: the endpoint acknowledged the stop and sent no terminal result.";

/** US-30: a shutdown ends this session's observation and never touches the remote run. */
const SHUTDOWN =
  "The session shut down, so this run is no longer watched. It was left running remotely and was not stopped.";

export async function runWorkflowForeground(
  args: WorkflowRunArgs,
  ports: WorkflowRunPorts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { manager, client } = ports;

  if (args.signal?.aborted) {
    return failure("The workflow run was cancelled before it was sent; nothing reached the endpoint.");
  }

  const created = await client.create({
    prompt: args.prompt,
    definition: args.definition,
    workingDir: args.workingDir,
  });
  if (!created.ok) return failure(created.error);

  const run = { name: args.name, endpoint: args.endpoint.name, url: args.endpoint.url, remoteId: created.workflowId };
  let settled = false;
  let lines: string[] = [];
  let observation = new AbortController();
  let handBack!: (text: string) => void;
  // A hand-back returns the call while the record stays running; the gate is the settlement.
  const handed = new Promise<string>((resolve) => {
    handBack = resolve;
  });

  const record = manager.registerWorkflowRun({
    workflow: run,
    description: args.endpoint.url,
    toolCallId: args.toolCallId,
    signal: args.signal,
    onEnd: end,
  });

  // An interrupt that landed while the create request was in flight: the run exists remotely by
  // now, so it is stopped rather than left alone.
  if (args.signal?.aborted) end("stop");

  void observe();
  const text = await Promise.race([record.execution.promise!, handed]);
  const details = { agentId: record.id, progress: lines };
  const content = [{ type: "text" as const, text }];
  return record.lifecycle.status === "error" ? { content, details, isError: true } : { content, details };

  async function observe(): Promise<void> {
    while (!settled) {
      const outcome = await client.monitor(run.remoteId, { onUpdate: publishProgress, signal: observation.signal });
      if (settled) return;

      if (observation.signal.aborted) {
        const ack = await client.stop(run.remoteId);
        if (settled) return;
        // US-18: the acknowledged stop outranks whatever footprint the run's own record shows. Any
        // other answer — including a refusal — says nothing about the run, so GET decides it.
        if (ack.ok && ack.status === "stopped") {
          settle("stopped", STOPPED);
          return;
        }
        if (!ack.ok) {
          handBack(plainText(`Stop failed: ${ack.error} The run's state is unknown; it is still remote.`));
        }
        observation = new AbortController();
        continue;
      }

      if (outcome.status === "degraded") {
        handBack(outcome.error);
        continue;
      }
      const [status, settlement] = settlementOf(outcome);
      settle(status, settlement);
      return;
    }
  }

  function end(reason: "stop" | "shutdown"): void {
    if (settled) return;
    observation.abort();
    if (reason === "shutdown") settle("stopped", SHUTDOWN);
  }

  function settle(status: WorkflowSettlementStatus, text: string): void {
    if (settled) return;
    settled = true;
    manager.settleWorkflowRun(record, status, text);
    // The settled view keeps the partial one: what this connection delivered is not undone by the
    // outcome, and the row is repainted through the registered invalidation.
    publish(text);
  }

  /** A snapshot that arrives after this call's own outcome belongs to a wait nobody is reading. */
  function publishProgress(items: readonly WorkflowDisplayItem[]): void {
    if (settled) return;
    lines = progressLines(items);
    publish();
  }

  function publish(outcomeText?: string): void {
    args.onUpdate?.({
      content: outcomeText === undefined ? [] : [{ type: "text", text: outcomeText }],
      details: { agentId: record.id, progress: lines },
    });
  }
}

/** The lines the call's result view shows for one connection's display state. */
export function progressLines(items: readonly WorkflowDisplayItem[]): string[] {
  return items.map((item) => plainText(lineFor(item))).filter((line) => line !== "");
}

const NODE_STATUS: Record<WorkflowNodeStatus, { mark: string; word: string }> = {
  dispatched: { mark: "\u25b6", word: "dispatched" },
  retry: { mark: "\u25b6", word: "retrying" },
  completed: { mark: "\u2713", word: "completed" },
  failed: { mark: "\u2717", word: "failed" },
};

function lineFor(item: WorkflowDisplayItem): string {
  const node = item.node === null ? "" : `${item.node} `;
  if (item.type === "node-status") {
    const status = NODE_STATUS[item.status];
    return `${status.mark} ${node}${status.word}`;
  }
  return item.type === "activity" ? `  ${node}tool ${item.activity}` : `  ${item.text}`;
}

function settlementOf(outcome: Exclude<WorkflowOutcome, { status: "degraded" }>): [WorkflowSettlementStatus, string] {
  switch (outcome.status) {
    case "completed":
      return ["completed", formatTerminalResult(outcome.result)];
    case "failed":
      return ["error", `Workflow run failed: ${reasonOf(outcome.error)}`];
    case "interrupted":
      return ["error", `Workflow run was interrupted: ${reasonOf(outcome.error)}`];
    case "error":
      // Already named: the endpoint, the URL and the behaviour it failed to deliver.
      return ["error", outcome.error];
    case "aborted":
      return ["stopped", STOPPED];
  }
}

function reasonOf(error: string | null): string {
  return error ? plainText(error) : "the endpoint gave no reason";
}

/** A run that never became a record: the endpoint refused it, or the call was already cancelled. */
function failure(text: string): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text: plainText(text) }], details: {}, isError: true };
}
