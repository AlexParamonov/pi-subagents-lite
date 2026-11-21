/**
 * workflow-run.ts — Follow a foreground Workflow run under the session's claim.
 *
 * The AgentManager claim owns the run's lifetime from before create. This loop applies GET's
 * terminal outcome or an acknowledged stop, which outranks the endpoint's footprint. Handing the
 * call back leaves observation running; session shutdown ends observation without settling.
 * See `docs/adr/0013-get-authoritative-workflow-client.md`.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { AgentRecord, WorkflowRunInfo, WorkflowSettlementStatus } from "../types.ts";
import { createPublicText } from "./public-text.ts";
import { displayUrl } from "./endpoints.ts";
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

/**
 * US-30: shutdown ends local observation and sends no new stop. A stop may already have been sent,
 * so the note says only that observation ended and the remote outcome is unknown.
 */
const SHUTDOWN = "The session shut down, so this run is no longer watched; its remote outcome is unknown.";

export async function runWorkflowForeground(
  args: WorkflowRunArgs,
  ports: WorkflowRunPorts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { manager, client } = ports;
  // Every string this run publishes - notes, progress lines, settlement text - crosses the one
  // boundary that makes endpoint text safe (US-35).
  const published = createPublicText(args.endpoint.apiKey);
  // The base is transport-only: the record's two URL copies show the display URL, and each crosses
  // this publisher because the surfaces that read them have no publisher of their own (US-35).
  const shownUrl = published.shown(displayUrl(args.endpoint.url));

  if (args.signal?.aborted) {
    return failure("The workflow run was cancelled before it was sent; nothing reached the endpoint.");
  }

  // The session owns the run from before the create request to the end of its observation, which is
  // what makes a shutdown reach a run whose create answer has not arrived yet.
  const ownership = manager.beginWorkflowRun(end);
  let settled = false;
  // Shutdown releases the waiter without settling. Every later observation or stop path is inert.
  let sessionEnded = false;
  let noteKind: "unknown" | "stop-failed" | undefined;
  let lines: string[] = [];
  let record: AgentRecord | undefined;
  let observation = new AbortController();
  // Cancels the local wait for a stop this session will no longer hear the answer to.
  const disposal = new AbortController();
  let handBackNote!: (note: string) => void;
  // A hand-back returns the call while the record stays running; the gate is the settlement.
  const handed = new Promise<string>((resolve) => {
    handBackNote = resolve;
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
    url: shownUrl,
    remoteId: created.workflowId,
  };
  record = ownership.register({
    workflow,
    description: shownUrl,
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
    while (!settled && !sessionEnded) {
      const outcome = await client.monitor(workflow.remoteId, {
        onUpdate: publishProgress,
        onRead: recovered,
        signal: observation.signal,
      });
      if (settled || sessionEnded) return;

      if (observation.signal.aborted) {
        const ack = await client.stop(workflow.remoteId, disposal.signal);
        if (settled || sessionEnded) return;
        // US-18: `stopped` outranks the remote footprint. Other acknowledgements trigger an
        // immediate GET; an unacknowledged stop leaves the normal read pacing in place.
        if (ack.ok && ack.status === "stopped") {
          settle("stopped", STOPPED);
          return;
        }
        if (!ack.ok) {
          handBack(`Stop failed: ${ack.error} The run's state is unknown; it is still remote.`, "stop-failed");
        }
        observation = new AbortController();
        continue;
      }

      if (outcome.status === "degraded") {
        handBack(outcome.error, "unknown");
        continue;
      }
      const [status, settlement] = settlementOf(outcome);
      settle(status, settlement);
      return;
    }
  }

  function end(reason: "stop" | "shutdown"): void {
    if (settled || sessionEnded) return;
    observation.abort();
    if (reason === "stop") return;
    // US-30: shutdown is a release, not a settlement. Nothing is written to the record, no gate
    // opens, nothing is notified or painted, and the local wait for a stop already on the wire is
    // cancelled through the request machinery - which sends nothing new and retracts nothing sent.
    sessionEnded = true;
    disposal.abort();
    if (record) release(published.shown(SHUTDOWN));
  }

  function settle(status: WorkflowSettlementStatus, text: string): void {
    if (settled || sessionEnded) return;
    settled = true;
    if (!record) return;
    // A running-state note says nothing true of a settled run.
    noteKind = undefined;
    delete workflow.note;
    const outcome = published.shown(text);
    manager.settleWorkflowRun(record, status, outcome);
    // The settled view keeps the partial one: what this connection delivered is not undone by the
    // outcome, and the row is repainted through the registered invalidation.
    publish(outcome);
  }

  /**
   * Record the latest health note and give the call back. Observation continues without forwarding
   * the parent's interrupt, so any later stop is an explicit new request (US-19, US-30).
   */
  function handBack(note: string, kind: "unknown" | "stop-failed"): void {
    noteKind = kind;
    workflow.note = published.shown(note);
    release(workflow.note);
  }

  /** End the call with a note and no outcome: the record keeps whatever state it had. */
  function release(note: string): void {
    manager.detachParentInterrupt(agentId);
    handBackNote(note);
  }

  /** An authoritative `running` says whatever the failed read could not: the unknown note is over. */
  function recovered(): void {
    if (noteKind !== "unknown") return;
    noteKind = undefined;
    delete workflow.note;
  }

  /** Keep the record's snapshot current until settlement or shutdown, even after the call returns. */
  function publishProgress(items: readonly WorkflowDisplayItem[]): void {
    if (settled || sessionEnded) return;
    lines = progressLines(items).map((line) => published.shown(line));
    workflow.progress = lines;
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
