/**
 * workflow-client.ts: The HTTP client for one Workflow run.
 *
 * `create` pushes a run, `monitor` follows it (SSE for display, GET for state), `stop` asks for a
 * kill. Run state comes from GET alone (ADR-0013); the stream is display-only and its event ids are
 * never read. The observation state - backoff, failure budget, last known state - is the client's,
 * and one client is one run's: a hand-back continues the cadence instead of restarting it. Every
 * failure comes back as a domain result, never as an HTTP or transport exception.
 */

import { errorMessage } from "../utils.ts";
import { displayUrl } from "./endpoints.ts";
import { createPublicText } from "./public-text.ts";
import { field, parseRecord, record } from "./payload.ts";
import { SseParser } from "./sse.ts";
import { StreamView } from "./stream-view.ts";
import type { WorkflowDisplayItem } from "./stream-view.ts";
import type { WorkflowEndpoint } from "./endpoints.ts";

/** What a run needs: the prompt, the parsed Workflow file, and the working directory to inject. */
export interface WorkflowRunRequest {
  prompt: string;
  /** Parsed Workflow file. Its top-level `endpoint` key selects the endpoint and is never sent. */
  definition: Record<string, unknown>;
  workingDir: string;
}

export type WorkflowCreate = { ok: true; workflowId: string; taskId: string } | { ok: false; error: string };

/** UTF-8 byte cap the endpoint enforces with a 422; checked before anything is sent. */
const PROMPT_MAX_BYTES = 10_000;
/** Deadline for one create, read or stop request. */
const REQUEST_DEADLINE_MS = 10_000;
/** Longest wait between two lifecycle events before reading GET to confirm the run. */
const LIFECYCLE_SILENCE_MS = 90_000;
/** Pause before reopening a connection GET says is still live. */
const RECONNECT_DELAY_MS = 1_000;
/** Read-failure backoff: it grows, is capped, and never gives up on its own. */
const READ_BACKOFF_START_MS = 2_000;
const READ_BACKOFF_CAP_MS = 30_000;
/** Failed reads after which a foreground wait is handed back as degraded. */
const FAILED_READS_BEFORE_DEGRADED = 5;

export interface WorkflowClientOptions {
  fetch?: typeof fetch;
  /** Every endpoint key the configuration offers, named when this endpoint never answers (US-21). */
  endpointNames?: string[];
}

/** How a caller follows a run: display snapshots for the caller to paint, and a cancel signal. */
export interface WorkflowView {
  /** Complete display state for the current connection; a new connection replaces the last. */
  onUpdate(items: readonly WorkflowDisplayItem[]): void;
  /** Called when an authoritative read answers `running`, never for any other state. */
  onRead?: (state: "running") => void;
  signal?: AbortSignal;
}

/**
 * What one monitor wait returns. `completed`, `failed` and `interrupted` come from GET; `error`
 * rejects the retired completion marker. `aborted` is local cancellation, not a server state.
 * `degraded` hands back an unknown-state note without settling the run; re-entering `monitor`
 * carries the retry delay. Stop acknowledgements are reported separately.
 */
export type WorkflowOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed" | "interrupted"; error: string | null }
  | { status: "aborted" }
  | { status: "degraded"; error: string }
  | { status: "error"; error: string };

/** The three answers the endpoint gives to a stop request. */
const STOP_STATUSES = ["stopped", "already_finished", "interrupted"] as const;

type StopStatus = (typeof STOP_STATUSES)[number];

/** The endpoint's three-way stop acknowledgement, or the reason it did not acknowledge. */
export type WorkflowStop = { ok: true; status: StopStatus } | { ok: false; error: string };

export interface WorkflowClient {
  create(request: WorkflowRunRequest): Promise<WorkflowCreate>;
  monitor(workflowId: string, view: WorkflowView): Promise<WorkflowOutcome>;
  /** `signal` cancels the local wait for the acknowledgement; it retracts nothing already sent. */
  stop(workflowId: string, signal?: AbortSignal): Promise<WorkflowStop>;
}

type Answer =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: "cancelled" | "transport"; reason: string };

/** A route the join can append: an unrooted tail would extend the base's host instead. */
type Route = `/${string}`;

export function createWorkflowClient(endpoint: WorkflowEndpoint, options: WorkflowClientOptions = {}): WorkflowClient {
  const transport = options.fetch ?? fetch;
  const key = endpoint.apiKey;
  const base = endpoint.url;
  // The one URL any published text may name: a base whose path carries percent escapes cannot be
  // shown as the bytes the transport sends.
  const display = displayUrl(base);
  const published = createPublicText(key);
  // Observation state lives here because one client is one run's: a hand-back leaves this where it
  // is and the next `monitor` entry continues from it, so the backoff never restarts at the base.
  let failedReads = 0;
  let lastKnown: "running" | "unknown" = "unknown";
  let bypassNextDelay = false;

  /** One route of the run's validated base - never an absolute path resolved against it. */
  function url(route: Route): string {
    return `${base}${route}`;
  }

  /** A failure named by the endpoint it happened against, in text safe to publish. */
  function fault(what: string, detail: string): string {
    return published.shown(`Workflow endpoint "${endpoint.name}" (${display}) ${what}: ${detail}`).trim();
  }

  /** Why a request or a read task died: the message, plus the cause's when the transport nested one. */
  function failureReason(reason: unknown): string {
    if (!(reason instanceof Error)) return errorMessage(reason);
    const cause = reason.cause;
    return cause instanceof Error ? `${errorMessage(reason)}: ${errorMessage(cause)}` : errorMessage(reason);
  }

  async function answer(method: "GET" | "POST", path: Route, body?: string, signal?: AbortSignal): Promise<Answer> {
    const opened = await open(method, path, body, signal);
    if (!opened.ok) return opened;
    try {
      return { ok: true, status: opened.response.status, body: await opened.response.text() };
    } catch (reason) {
      // A body read that died because the caller went away is a cancellation, not a failure the
      // endpoint owes a read attempt for.
      return { ok: false, kind: signal?.aborted ? "cancelled" : "transport", reason: failureReason(reason) };
    } finally {
      opened.close();
    }
  }

  /**
   * One request with the endpoint's key and no cross-origin redirect, with two handles: `finish()`
   * ends the connect deadline, which a stream outlives; `close()` ends the request, and the caller
   * must call it once it is done with the body, or the endpoint keeps streaming to a socket nobody
   * reads. A stream bounds itself with the silence window instead of the deadline.
   */
  async function open(
    method: "GET" | "POST",
    path: Route,
    body?: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; response: Response; finish: () => void; close: () => void }
    | { ok: false; kind: "cancelled" | "transport"; reason: string }
  > {
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error(`timed out after ${REQUEST_DEADLINE_MS}ms`)),
      REQUEST_DEADLINE_MS,
    );
    const abort = () => controller.abort(new Error("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    let established = false;
    try {
      const response = await transport(url(path), {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      });
      established = true;
      return { ok: true, response, finish, close };
    } catch (reason) {
      return { ok: false, kind: signal?.aborted ? "cancelled" : "transport", reason: failureReason(reason) };
    } finally {
      if (!established) close();
    }

    function finish(): void {
      clearTimeout(deadline);
    }

    function close(): void {
      finish();
      signal?.removeEventListener("abort", abort);
      // A stream the caller walked away from is the one thing that must not stay open remotely.
      controller.abort(new Error("the request is over"));
    }
  }

  /**
   * The endpoint's own reason for refusing something: its `error` field, or nothing. A body that is
   * not a refusal - a run's state, its journal - is never a reason, and quoting it publishes run data
   * as if the endpoint had explained itself.
   */
  function reason(body: string): string | null {
    const stated = parseError(body);
    return stated === null ? null : published.bounded(stated);
  }

  /** What a create or stop rejection answered; a body with no `error` field is quoted as its words. */
  function rejection(body: string): string {
    const stated = reason(body) ?? published.bounded(body);
    return stated === "" ? "no reason given" : stated;
  }

  return {
    async create(request): Promise<WorkflowCreate> {
      const invalid = promptProblem(request.prompt);
      if (invalid) return { ok: false, error: published.shown(`Workflow run was not sent: ${invalid}`) };

      const sent = await answer("POST", "/api/workflows", JSON.stringify(runBody(request)));
      if (!sent.ok) {
        // Nothing answered, so the reader's question is which endpoint to send to. A rejection came
        // from the endpoint the run was sent to, and carries the server's own words alone.
        const names = options.endpointNames ?? [];
        const keys = names.length === 0 ? "" : ` Configured endpoints: ${names.join(", ")}.`;
        return {
          ok: false,
          error: fault(
            "has an unknown outcome",
            `${sent.reason}. The run may still be running remotely; it was not retried.${keys}`,
          ),
        };
      }
      if (sent.status < 200 || sent.status >= 300) {
        return { ok: false, error: fault("rejected the run", `HTTP ${sent.status}: ${rejection(sent.body)}`) };
      }
      const ids = runIds(sent.body);
      if (!ids)
        return { ok: false, error: fault("created a run it did not identify", "the response carried no workflow id") };
      if (!routableSegment(ids.workflowId))
        return {
          ok: false,
          error: fault(
            "has an unknown outcome",
            "the workflow id it answered cannot be used as a path segment. " +
              "The run may still be running remotely; it was not retried.",
          ),
        };
      lastKnown = "running";
      return { ok: true, ...ids };
    },

    async monitor(workflowId, view): Promise<WorkflowOutcome> {
      // The delay a failed read owed is carried, not cancelled: a re-entry after a hand-back waits
      // it out before its first read. Only a non-`stopped` stop acknowledgement skips the delay.
      if (bypassNextDelay) bypassNextDelay = false;
      else if (failedReads > 0) await sleep(readBackoff(failedReads), view.signal);
      while (!view.signal?.aborted) {
        // A stream opens only while the last known state is `running` (a create or a read that
        // answered so); while it is not, the read is the only voice, and no open connection can
        // defer it.
        if (lastKnown === "running") {
          await push(workflowId, view);
          if (view.signal?.aborted) return { status: "aborted" };
        }

        const run = await read(workflowId, view.signal);
        // A read that answered after the wait was cancelled belongs to a caller that is gone: it
        // charges no failure and changes no state.
        if (view.signal?.aborted || run.kind === "cancelled") return { status: "aborted" };
        if (run.kind === "unreachable") {
          failedReads += 1;
          lastKnown = "unknown";
          if (failedReads >= FAILED_READS_BEFORE_DEGRADED) {
            return {
              status: "degraded",
              error: published.shown(
                `${run.error}. The state is unknown after ${failedReads} observations: the run is still remote, ` +
                  "nothing was stopped, and observation was handed back.",
              ),
            };
          }
          await sleep(readBackoff(failedReads), view.signal);
          continue;
        }

        failedReads = 0;
        if (run.kind === "running") {
          lastKnown = "running";
          view.onRead?.("running");
          await sleep(RECONNECT_DELAY_MS, view.signal);
          continue;
        }
        return terminal(run);
      }
      return { status: "aborted" };
    },

    async stop(workflowId, signal): Promise<WorkflowStop> {
      // Any stop request takes the stream away: the run's own state after a stop is whatever the
      // next authoritative read says.
      lastKnown = "unknown";
      const sent = await answer("POST", `/api/workflows/${encodeURIComponent(workflowId)}/stop`, undefined, signal);
      if (!sent.ok) return { ok: false, error: fault("did not answer the stop request", sent.reason) };
      if (sent.status < 200 || sent.status >= 300) {
        return { ok: false, error: fault("refused the stop request", `HTTP ${sent.status}: ${rejection(sent.body)}`) };
      }
      const status = stopStatus(sent.body);
      if (!status) {
        return {
          ok: false,
          error: fault("answered the stop request unreadably", `no stop status in ${published.bounded(sent.body)}`),
        };
      }
      // An acknowledgement that is not `stopped` says the run's own state must be read now: the
      // next entry skips its owed delay for exactly that one authoritative read.
      if (status !== "stopped") bypassNextDelay = true;
      return { ok: true, status };
    },
  };

  /**
   * One SSE connection: display state is rebuilt from scratch, the silence clock is armed by
   * lifecycle frames only, and the connection ends on close, on silence, or on a terminal frame.
   * The wait ends on that trigger alone — a stream that stops yielding must not hold the caller,
   * because only GET can say what the run is (ADR-0013).
   */
  async function push(workflowId: string, view: WorkflowView): Promise<void> {
    const controller = new AbortController();
    const abort = () => reconcile();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done!: () => void;
    const waiting = new Promise<void>((resolve) => {
      done = resolve;
    });
    const reconcile = () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort(new Error("the connection is over"));
      done();
    };
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(reconcile, LIFECYCLE_SILENCE_MS);
    };
    const connection = new StreamView();
    view.signal?.addEventListener("abort", abort, { once: true });
    void readStream(workflowId, view, connection, controller.signal, arm, reconcile).catch((reason) => {
      // A read task that died on its own must neither leave the wait unresolved nor die quietly.
      console.warn(`[pi-subagents-lite] ${fault("stopped following its own connection", failureReason(reason))}`);
      reconcile();
    });
    await waiting;
    if (timer !== undefined) clearTimeout(timer);
    view.signal?.removeEventListener("abort", abort);
  }

  async function readStream(
    workflowId: string,
    view: WorkflowView,
    connection: StreamView,
    signal: AbortSignal,
    arm: () => void,
    reconcile: () => void,
  ): Promise<void> {
    const opened = await open("GET", `/api/workflows/${encodeURIComponent(workflowId)}/stream`, undefined, signal);
    if (!opened.ok) {
      reconcile();
      return;
    }
    try {
      // The connect deadline ends here; from now on the lifecycle silence window bounds the run.
      opened.finish();
      if (opened.response.ok && opened.response.body) {
        arm();
        const parser = new SseParser();
        for await (const text of streamed(opened.response.body)) {
          let changed = false;
          let lifecycle = false;
          let ending = false;
          for (const frame of parser.push(text)) {
            const effect = connection.apply(frame);
            changed ||= effect.changed;
            lifecycle ||= effect.lifecycle;
            if (effect.reconcile) {
              ending = true;
              break;
            }
          }
          if (lifecycle) arm();
          // A wait that has ended belongs to a caller that is gone: nothing more reaches it.
          if (changed && !signal.aborted) view.onUpdate(connection.snapshot());
          if (ending) break;
        }
      }
    } finally {
      // Reconnect or settle, the connection this wait used is over either way.
      opened.close();
      reconcile();
    }
  }

  /**
   * The connection's text, transport only: a read that breaks or is cancelled ends the iteration
   * quietly, because a connection that broke says nothing about the run's state (ADR-0013). The
   * decoder and the caller's renderer run outside here, so their bugs are not mistaken for one.
   */
  async function* streamed(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield decoder.decode(next.value, { stream: true });
      }
    } catch {
      return;
    } finally {
      reader.releaseLock();
    }
  }

  /** GET, read for `status`, `result` and `error` only: its `events` array is not a source. */
  async function read(
    workflowId: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "cancelled" }
    | { kind: "unreachable"; error: string }
    | { kind: "running" }
    | { kind: "terminal"; status: TerminalStatus; result: unknown; error: string | null }
  > {
    const polled = await answer("GET", `/api/workflows/${encodeURIComponent(workflowId)}`, undefined, signal);
    if (!polled.ok) {
      return polled.kind === "cancelled"
        ? { kind: "cancelled" }
        : { kind: "unreachable", error: fault("did not answer the state read", polled.reason) };
    }
    if (polled.status < 200 || polled.status >= 300) {
      // Every non-2xx answer carries no run status: the read failed, and that is the whole message.
      // Its body is the run's envelope whatever the status said, so the endpoint's `error` field is
      // the only remote text quoted here, and a read that gives none gets a local diagnostic.
      const what = polled.status >= 500 ? "did not answer the state read" : "refused the state read";
      return {
        kind: "unreachable",
        error: fault(what, `HTTP ${polled.status}: ${reason(polled.body) ?? "the endpoint answered with no reason"}`),
      };
    }
    const body = parseRecord(polled.body);
    const status = RUN_STATUSES.find((known) => known === body?.status);
    if (!body || !status) {
      const found =
        typeof body?.status === "string"
          ? `its status was ${JSON.stringify(published.bounded(body.status))}`
          : "it carried no status";
      return {
        kind: "unreachable",
        error: fault("answered the state read unreadably", `no run status this client can read: ${found}`),
      };
    }
    if (status === "running") return { kind: "running" };
    return {
      kind: "terminal",
      status,
      result: body.result,
      error: typeof body.error === "string" ? body.error : null,
    };
  }

  /** GET's terminal state, with GET's payload in publishable text. The marker is refused, never answered. */
  function terminal(run: { status: TerminalStatus; result: unknown; error: string | null }): WorkflowOutcome {
    if (run.status !== "completed") {
      return { status: run.status, error: run.error === null ? null : published.shown(run.error) };
    }
    // GET always carries the key (recorded/PROVENANCE.md); a missing one still means "no output",
    // never an undefined reaching the caller.
    const result = run.result === undefined ? null : run.result;
    const marker = record(result);
    if (marker && Object.keys(marker).length === 1 && marker.status === "completed") {
      return {
        status: "error",
        error: fault(
          "delivered no terminal result",
          'a completed run answered with the retired completion marker {"status":"completed"} instead of the ' +
            "workflow's declared output, so this endpoint does not deliver terminal results",
        ),
      };
    }
    return { status: "completed", result };
  }
}

const RUN_STATUSES = ["running", "completed", "failed", "interrupted"] as const;

type RunStatus = (typeof RUN_STATUSES)[number];

/** The growing, capped pause owed after `failed` consecutive failed reads. */
function readBackoff(failed: number): number {
  return Math.min(READ_BACKOFF_START_MS * 2 ** (failed - 1), READ_BACKOFF_CAP_MS);
}

/** The states GET settles a run in; `running` is never one of them. */
type TerminalStatus = Exclude<RunStatus, "running">;

function stopStatus(body: string): StopStatus | null {
  return STOP_STATUSES.find((known) => known === parseRecord(body)?.status) ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal?.addEventListener("abort", wake, { once: true });
  });
}

function runIds(body: string): { workflowId: string; taskId: string } | null {
  const ids = parseRecord(body);
  const workflowId = field(ids, "workflow_id");
  return workflowId === undefined ? null : { workflowId, taskId: field(ids, "task_id") ?? "" };
}

/**
 * Whether an id the endpoint answered can be routed as one path segment: a dot segment would walk
 * out of the run's own route once Fetch normalizes it, and an unpaired surrogate has no encoding.
 */
function routableSegment(id: string): boolean {
  let encoded: string;
  try {
    encoded = encodeURIComponent(id);
  } catch {
    return false;
  }
  return encoded !== "" && encoded !== "." && encoded !== "..";
}

function parseError(body: string): string | null {
  return field(parseRecord(body), "error") ?? null;
}

function promptProblem(prompt: string): string | null {
  if (prompt.trim() === "") return "a workflow run needs a non-empty prompt";
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > PROMPT_MAX_BYTES) {
    return `the prompt is ${bytes} bytes and this endpoint accepts at most ${PROMPT_MAX_BYTES.toLocaleString("en-US")} of them`;
  }
  return null;
}

function runBody(request: WorkflowRunRequest): { prompt: string; workflow_config: unknown } {
  const { endpoint: _endpoint, ...config } = request.definition;
  const vars = config.prompt_vars;
  return {
    prompt: request.prompt,
    workflow_config: {
      ...config,
      prompt_vars: { ...record(vars), working_dir: request.workingDir },
    },
  };
}
