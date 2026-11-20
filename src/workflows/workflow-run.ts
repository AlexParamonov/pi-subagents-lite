/**
 * workflow-run.ts — One foreground Workflow run, from create to the server's terminal result.
 *
 * The record and the run's lifetime belong to AgentManager (claimed before the create request) and
 * the endpoint to `workflow-client.ts`; this module is the
 * loop that decides what a run means: GET's terminal outcome settles it, an acknowledged stop
 * outranks the endpoint's footprint, and a run that cannot be read is handed back rather than
 * guessed at. `docs/adr/0013-get-authoritative-workflow-client.md` is the reasoning behind that.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { AgentRecord, WorkflowRunInfo, WorkflowSettlementStatus } from "../types.ts";
import { createPublicText } from "./public-text.ts";
import { formatTerminalResult } from "./terminal-result.ts";
import { progressLines } from "./stream-view.ts";
import type { WorkflowDisplayItem } from "./stream-view.ts";
import type { WorkflowEndpoint } from "./endpoints.ts";
import type { WorkflowClient, WorkflowOutcome } from "./workflow-client.ts";

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
  // Every string this run publishes - notes, progress lines, settlement text - crosses the one
  // boundary that makes endpoint text safe (US-35).
  const published = createPublicText(args.endpoint.apiKey);

  if (args.signal?.aborted) {
    return failure("The workflow run was cancelled before it was sent; nothing reached the endpoint.");
  }

  // The session owns the run from before the create request to the end of its observation, which is
  // what makes a shutdown reach a run whose create answer has not arrived yet.
  const ownership = manager.beginWorkflowRun(end);
  let settled = false;
  let lines: string[] = [];
  let record: AgentRecord | undefined;
  let observation = new AbortController();
  let handBack!: (text: string) => void;
  // A hand-back returns the call while the record stays running; the gate is the settlement.
  const handed = new Promise<string>((resolve) => {
    handBack = (note) => resolve(published.shown(note));
  });

  const created = await client.create({
    prompt: args.prompt,
    definition: args.definition,
    workingDir: args.workingDir,
  });
  if (!created.ok) {
    ownership.abandon();
    return failure(created.error);
  }

  const workflow: WorkflowRunInfo = {
    name: args.name,
    endpoint: args.endpoint.name,
    url: args.endpoint.url,
    remoteId: created.workflowId,
  };
  record = ownership.register({
    workflow,
    description: args.endpoint.url,
    toolCallId: args.toolCallId,
    signal: args.signal,
  });
  // US-30: the session ended while the create request was in flight. The run keeps whatever the
  // endpoint makes of it: no record, no observation, no stop, no publication into a gone session.
  if (!record) return unwatched();
  const agentId = record.id;

  // An interrupt that landed while the create request was in flight: the run exists remotely by
  // now, so it is stopped rather than left alone.
  if (args.signal?.aborted) end("stop");

  void observe();
  const text = await Promise.race([record.execution.promise!, handed]);
  const details = { agentId, progress: lines };
  const content = [{ type: "text" as const, text }];
  return record.lifecycle.status === "error" ? { content, details, isError: true } : { content, details };

  async function observe(): Promise<void> {
    while (!settled) {
      const outcome = await client.monitor(workflow.remoteId, {
        onUpdate: publishProgress,
        signal: observation.signal,
      });
      if (settled) return;

      if (observation.signal.aborted) {
        const ack = await client.stop(workflow.remoteId);
        if (settled) return;
        // US-18: the acknowledged stop outranks whatever footprint the run's own record shows. Any
        // other answer — including a refusal — says nothing about the run, so GET decides it.
        if (ack.ok && ack.status === "stopped") {
          settle("stopped", STOPPED);
          return;
        }
        if (!ack.ok) {
          handBack(`Stop failed: ${ack.error} The run's state is unknown; it is still remote.`);
        }
        observation = new AbortController();
        continue;
      }

      if (outcome.status === "degraded") {
        // The caller has the note and stopped waiting: a later parent interrupt belongs to another
        // decision and must not stop a run this call already handed back (US-19, US-30).
        manager.detachParentInterrupt(agentId);
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
    if (!record) return;
    const outcome = published.shown(text);
    manager.settleWorkflowRun(record, status, outcome);
    // The settled view keeps the partial one: what this connection delivered is not undone by the
    // outcome, and the row is repainted through the registered invalidation.
    publish(outcome);
  }

  /** A snapshot that arrives after this call's own outcome belongs to a wait nobody is reading. */
  function publishProgress(items: readonly WorkflowDisplayItem[]): void {
    if (settled) return;
    lines = progressLines(items).map((line) => published.shown(line));
    publish();
  }

  function publish(outcomeText?: string): void {
    args.onUpdate?.({
      content: outcomeText === undefined ? [] : [{ type: "text", text: outcomeText }],
      details: { agentId, progress: lines },
    });
  }

  /** A run that never became a record: the endpoint refused it, or the call was already cancelled. */
  function failure(text: string): AgentToolResult<Record<string, unknown>> {
    return { content: [{ type: "text", text: published.shown(text) }], details: {}, isError: true };
  }
}

/** A run the session lost before it had a record: the endpoint still has it, nobody here does. */
function unwatched(): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      {
        type: "text",
        text:
          "The session shut down while the run was being created. It may be running remotely: " +
          "nothing was stopped, and this session reports no outcome for it.",
      },
    ],
    details: {},
  };
}

/** What a followed outcome leaves the record: the status it settles in and the one text it answers with. */
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
  return error ?? "the endpoint gave no reason";
}
