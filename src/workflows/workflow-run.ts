/**
 * workflow-run.ts — Follow a Workflow run under the session's claim, waited for or detached.
 *
 * The AgentManager claim owns the run beyond the tool waiter's lifetime. Progress and observation
 * health stay on the record; the per-run client retains retry pacing. A background launch and a
 * foreground hand-back leave the same detached watch behind, enrolled for one settlement
 * notification. Session shutdown releases the waiter without settling the run.
 * See `docs/adr/0013-get-authoritative-workflow-client.md`.
 */

import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.ts";
import { SHORT_ID_LENGTH, type WorkflowRunInfo, type WorkflowSettlementStatus } from "../types.ts";
import { createPublicText } from "./public-text.ts";
import { formatTerminalResult } from "./terminal-result.ts";
import { progressLines } from "./stream-view.ts";
import type { WorkflowDisplayItem } from "./stream-view.ts";
import type { WorkflowEndpoint } from "./endpoints.ts";
import type { WorkflowClient, WorkflowOutcome, WorkflowStop } from "./workflow-client.ts";

/** What a run needs to be sent, and where its updates go. */
export interface WorkflowRunArgs {
  name: string;
  /** Resolved and frozen before the first request. */
  endpoint: WorkflowEndpoint;
  definition: Record<string, unknown>;
  prompt: string;
  workingDir: string;
  toolCallId?: string;
  /** Return as soon as the endpoint admits the run; its outcome arrives as a notification. */
  runInBackground?: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>;
  /** The calling tool's context, kept on the record so a later notification has somewhere to go. */
  ctx?: ExtensionContext;
}

/** What a run's outcome can still be delivered to. The delivery owner decides what it sends. */
export interface NudgeEnrollment {
  enrollForNudge(agentId: string): void;
}

/** The shared record store, the client bound to the run's endpoint, and the delivery owner. */
export interface WorkflowRunPorts {
  manager: AgentManager;
  client: WorkflowClient;
  nudges: NudgeEnrollment;
}

/** What an acknowledged stop leaves the record: the stop, and no terminal result. */
const STOPPED = "Workflow run stopped: the endpoint acknowledged the stop and sent no terminal result.";

/**
 * US-30: shutdown ends local observation and sends no new stop. A stop may already have been sent,
 * so the note says only that observation ended and the remote outcome is unknown.
 */
const SHUTDOWN = "The session shut down, so this run is no longer watched; its remote outcome is unknown.";

/**
 * The running-state notes a record can carry. A standing kind (`stop-failed`, `interrupted`) is
 * cleared by nothing but settlement; `unknown` also falls to an authoritative `running` read. A
 * write of a lesser kind is dropped, so an outage cannot bury a refused stop.
 */
type NoteKind = "unknown" | "interrupted" | "stop-failed";

const NOTE_RANK: Record<NoteKind, number> = { unknown: 1, interrupted: 2, "stop-failed": 3 };

export async function runWorkflow(
  args: WorkflowRunArgs,
  ports: WorkflowRunPorts,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const { manager, client, nudges } = ports;
  const background = args.runInBackground === true;
  // Every string this run publishes - notes, progress lines, settlement text - crosses the one
  // boundary that makes endpoint text safe (US-35).
  const published = createPublicText(args.endpoint.apiKey);
  // The record's two URL copies cross this publisher because the surfaces that read them have no
  // publisher of their own (US-35).
  const shownUrl = published.shown(args.endpoint.url);

  if (args.signal?.aborted) {
    return failure("The workflow run was cancelled before it was sent; nothing reached the endpoint.");
  }

  // The session owns the run from before the create request to the end of its observation, which is
  // what makes a shutdown reach a run whose create answer has not arrived yet.
  const ownership = manager.beginWorkflowRun(end);
  let settled = false;
  // Shutdown releases the waiter without settling. Every later observation or stop path is inert.
  let sessionEnded = false;
  // The call answers as soon as it has returned: a background launch at the launch, a foreground
  // call at a hand-back. Pi accepts no tool update after that, and the record owns the repaint.
  let waiting = !background;
  // Whether this run asked the endpoint to stop: a note may deny a stop, never claim one.
  let stopRequested = false;
  let noteKind: NoteKind | undefined;
  let lines: string[] = [];
  // Whether the run has a record: a shutdown that overtakes the create request has none to release.
  let hasRecord = false;
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
  // A detached run is never bound to an interrupt: the turn that launched it is over, and that
  // turn's Esc belongs to the runs it is still answering for (US-30). The binding is the one
  // expression both the record and the create-window check read.
  const boundSignal = background ? undefined : args.signal;
  const runRecord = ownership.register({
    workflow,
    description: shownUrl,
    toolCallId: args.toolCallId,
    signal: boundSignal,
    runInBackground: background,
    spawnCtx: args.ctx,
  });
  // US-30: the session ended while the create request was in flight. The run keeps whatever the
  // endpoint makes of it: no record, no observation, no stop, no publication into a gone session.
  if (!runRecord) return unwatched();
  hasRecord = true;
  const record = runRecord;
  const agentId = record.id;
  const shortId = agentId.slice(0, SHORT_ID_LENGTH);

  // Enrollment precedes observation, so a run that settles before its caller looked away is still
  // reported. A run the caller waits for is never enrolled: its settlement is that call's result.
  if (background) nudges.enrollForNudge(agentId);
  // An interrupt that landed while the create request was in flight: the run exists remotely by
  // now, so it is stopped rather than left alone.
  if (boundSignal?.aborted) end("stop");

  void observe();
  if (background) return launched();

  const text = await Promise.race([record.execution.promise!, handed]);
  waiting = false;
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
        if (!ack.ok) handBack(stopFailed(ack), "stop-failed");
        observation = new AbortController();
        continue;
      }

      if (outcome.status === "degraded") {
        handBack(readBudget(outcome.observations), "unknown");
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
    if (reason === "stop") {
      stopRequested = true;
      return;
    }
    // US-30: shutdown is a release, not a settlement. Nothing is written to the record, no gate
    // opens, nothing is notified or painted, and the local wait for a stop already on the wire is
    // cancelled through the request machinery - which sends nothing new and retracts nothing sent.
    sessionEnded = true;
    disposal.abort();
    if (hasRecord) release(published.shown(SHUTDOWN));
  }

  function settle(status: WorkflowSettlementStatus, text: string): void {
    if (settled || sessionEnded) return;
    settled = true;
    // A running-state note says nothing true of a settled run.
    noteKind = undefined;
    delete workflow.note;
    const outcome = published.shown(text);
    manager.settleWorkflowRun(record, status, outcome);
    // The settled view keeps the partial one: what this connection delivered is not undone by the
    // outcome. A call that already returned is repainted by the settlement's own notification.
    if (waiting) publish(outcome);
  }

  /**
   * Record the note, enrol for the outcome this call will not deliver, and give the call back.
   * Observation continues without forwarding the parent's interrupt, so any later stop is an
   * explicit new request, and the settlement reaches the session as one notification (US-19, US-30).
   */
  function handBack(note: string, kind: NoteKind): void {
    writeNote(kind, published.shown(note));
    nudges.enrollForNudge(agentId);
    release(workflow.note ?? "");
  }

  /** End the call with a note and no outcome: the record keeps whatever state it had. */
  function release(note: string): void {
    waiting = false;
    manager.detachParentInterrupt(agentId);
    handBackNote(note);
  }

  /**
   * An authoritative `running` says two things: whatever a failed read could not, the run is live,
   * and a parent interrupt whose stop the endpoint never confirmed cannot be waited on any longer.
   * No stop acknowledgement tells that hand-back apart from a stop the caller asked for by hand -
   * only the parent's own signal does - so the read that decides the run's state decides the wait.
   */
  function recovered(): void {
    if (waiting && args.signal?.aborted) {
      handBack(interrupted(), "interrupted");
      return;
    }
    if (noteKind === "unknown") clearNote();
  }

  /** The note stands unless the new kind outranks it: a standing kind outlives a later write. */
  function writeNote(kind: NoteKind, note: string): void {
    if (noteKind !== undefined && NOTE_RANK[kind] <= NOTE_RANK[noteKind]) return;
    noteKind = kind;
    workflow.note = note;
    repaint();
  }

  /** A note that no longer holds is a visible change, whatever else does or does not follow it. */
  function clearNote(): void {
    noteKind = undefined;
    delete workflow.note;
    repaint();
  }

  /** Keep the record's snapshot current until settlement or shutdown, even after the call returns. */
  function publishProgress(items: readonly WorkflowDisplayItem[]): void {
    if (settled || sessionEnded) return;
    lines = progressLines(items).map((line) => published.shown(line));
    workflow.progress = lines;
    repaint();
  }

  /** The live view changed: the waiter paints it while it holds, the record's owner after that. */
  function repaint(): void {
    if (waiting) publish();
    else manager.notifyRecordTouched(record);
  }

  function publish(outcomeText?: string): void {
    args.onUpdate?.({
      content: outcomeText === undefined ? [] : [{ type: "text", text: outcomeText }],
      details: { agentId, progress: lines },
    });
  }

  /** What the caller reads the moment the endpoint admits a detached run. */
  function launched(): AgentToolResult<Record<string, unknown>> {
    const text = published.shown(
      `[Workflow "${args.name}" ${shortId} running] Started in the background: the result arrives as ` +
        `a notification when the run settles. ${checkLater()} ` +
        `The endpoint holds the run as workflow_id ${workflow.remoteId}, readable by an authorized GET.`,
    );
    return { content: [{ type: "text", text }], details: { agentId, progress: lines } };
  }

  /** How a hand-back sends the caller off: the run's own id, and the surface that reads it back. */
  function checkLater(): string {
    return `Check it later with AgentStatus using id ${shortId}.`;
  }

  /** The read budget spent: these reads told this session nothing, and the watch goes on. */
  function readBudget(observations: number): string {
    // A run that asked for a stop cannot claim nothing was stopped, so only a run that asked for
    // none carries the denial.
    const stopDenial = stopRequested ? "" : "nothing was stopped, and ";
    return (
      `Workflow run ${shortId}: its state is unknown after ${observations} observations; ` +
      `${stopDenial}observation was handed back.\n${checkLater()}`
    );
  }

  /**
   * A stop that did not happen: the client's short reason, and only what this session saw. A
   * refusal's own words may deny that the run exists, so the note claims no remote state.
   */
  function stopFailed(ack: Extract<WorkflowStop, { ok: false }>): string {
    const reason = ack.refusal.replace(/\.$/, "");
    return (
      `Workflow "${args.name}" ${shortId}: stop failed - ${reason}. ` +
      `Nothing was stopped, and this session has not seen the run end.\n${checkLater()}`
    );
  }

  /**
   * A parent interrupt whose stop the endpoint did not confirm. It claims only what happened, and
   * promises the notification only for as long as this session can deliver one (US-30).
   */
  function interrupted(): string {
    return (
      `Workflow "${args.name}" ${shortId}: the request to end the run was not confirmed - nothing was ` +
      `stopped, and the endpoint reports the run still running remotely. Observation continues, and the ` +
      `outcome arrives as a notification while this session stays open.\n${checkLater()}`
    );
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
