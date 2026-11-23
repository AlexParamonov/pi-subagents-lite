/**
 * fixtures.ts — the Workflow endpoint the acceptance tests drive: the real HTTP protocol
 * (create, SSE follow, GET reconcile, stop) on a loopback socket, plus the file and config
 * workspace the extension scans.
 *
 * Defaults come from the anagen-x API captures in `recorded/` and the contract-derived output in
 * `recorded/PROVENANCE.md`. Scripted responses keep the captured shapes; deliberately unknown SSE
 * names exercise forward compatibility and are not recordings. `lifecycle` and `progressFrame`
 * adapt recorded frames. The progress frames come from a hand-driven broadcast over the real
 * writer, not from a run. `textFrame` and `crlf` build single-line chunks and intermediary framing.
 *
 * The hold/release handles let a test advance when the endpoint reaches a milestone. GET uses the
 * captured key set, so an empty result slot is `result: null` here exactly as it is on the wire.
 * `fakeWorkflowFetch` also serves that contract without a socket; `clockedLoopback` keeps the real
 * HTTP exchange when the test needs to control only the application's clock.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { vi } from "vite-plus/test";
import { resolveWorkflowEndpoint } from "../../src/workflows/endpoints.js";
import type { WorkflowEndpoint } from "../../src/workflows/endpoints.js";

interface EndpointRequest {
  method: string;
  path: string;
  body: string;
  contentType: string | undefined;
  authorization: string | undefined;
  lastEventId: string | undefined;
  receivedAt: number;
}

/** One `GET /api/workflows/:id` body: the fixed key set the endpoint answers for every run state. */
export interface ReadState {
  status: "running" | "completed" | "failed" | "interrupted";
  result: unknown;
  error: string | null;
  events: unknown[];
}

/** A captured response: status code plus the exact bytes the server answered with. */
export interface RecordedResponse {
  status: number;
  body: string;
}

/**
 * The run the captured live stream, progress frames and declared-output GET belong to. The other
 * captures carry their own run id (`COMPLETED_RUN`, `FAILED_RUN`).
 */
export const REMOTE_ID = "wf-capture-declared";
export const COMPLETED_RUN = "wf-capture-completed";
export const FAILED_RUN = "wf-capture-failed";

/** Endpoint URL for runs whose traffic `fakeWorkflowFetch` serves instead of a socket. */
export const FAKED_URL = "http://127.0.0.1:43199";

const capturedDir = fileURLToPath(new URL("./recorded/", import.meta.url));
const capturedStatuses: Record<string, number> = JSON.parse(
  readFileSync(join(capturedDir, "responses.json"), "utf8"),
) as Record<string, number>;

/** `recorded/PROVENANCE.md` names these as contract-derived payload, not bytes a server wrote. */
const CONTRACT_DERIVED_FILES = ["read-completed-declared.body", "replay-declared.sse"];

/** The recorded bytes of one SSE stream or frame sequence. */
export function recorded(name: string): string {
  return readFileSync(join(capturedDir, name), "utf8");
}

/** The recorded status and body of one HTTP response. */
export function recordedResponse(name: string): RecordedResponse {
  if (CONTRACT_DERIVED_FILES.includes(`${name}.body`)) {
    throw new Error(`${name} is contract-derived, not captured: use declaredOutputRead() (recorded/PROVENANCE.md)`);
  }
  return recordedStatusAndBody(name);
}

/**
 * The `GET /api/workflows/:id` answer carrying a declared output. `read-completed-declared.body` is
 * contract-derived, so a test built on it pins how the client handles the ratified shape and never
 * that a server delivered one.
 */
export function declaredOutputRead(): RecordedResponse {
  return recordedStatusAndBody("read-completed-declared");
}

function recordedStatusAndBody(name: string): RecordedResponse {
  const status = capturedStatuses[name];
  if (status === undefined) throw new Error(`responses.json records no status for ${name}`);
  return { status, body: recorded(`${name}.body`) };
}

/** Answer `GET /api/workflows/:id` with a captured body and its captured status code. */
export function recordedRead(name: string): Response {
  const { status, body } = recordedResponse(name);
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * Split a captured stream into its frames. Each entry keeps the blank line that terminates it:
 * tests concatenate these to build a stream, and a frame without its terminator fuses into the
 * next frame's `data:` line instead of arriving as the bytes the server sent.
 */
export function framesOf(stream: string): string[] {
  return stream
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => `${frame}\n\n`);
}

/** The first frame of `stream` carrying `event: <event>`. */
export function frameOf(stream: string, event: string): string {
  const frame = framesOf(stream).find((entry) => entry.includes(`event: ${event}\n`));
  if (!frame) throw new Error(`the captured stream has no ${event} frame`);
  return frame;
}

const LIVE = recorded("live-stream.sse");
const PROGRESS = recorded("node-progress-frames.sse");
const REPLAY_COMPLETED = recorded("replay-completed.sse");
const REPLAY_FAILED = recorded("replay-failed.sse");
const REPLAY_DECLARED = recorded("replay-declared.sse");

/**
 * The values the recorded payloads carry, so a test asserts on what the endpoint really sent.
 * `answer` is the contract-derived one, pinned to that origin by the guard below.
 */
export const RECORDED = {
  chunkText: "Inspecting the repository",
  chunkTail: "Reporting three findings after a blank line",
  thinkingText: "Hidden reasoning",
  thinkingTail: "spanning two lines",
  batchedThinking: "Hidden batched reasoning",
  relayedChunk: "Inspecting the re",
  fullTurnText: "Inspecting the repository and reporting three findings.",
  deltaText: "Inspecting the repository and reporting thr",
  toolName: "read_file",
  /** Text a tool-activity or spend step carries: agent-internal, never the run's answer. */
  internalText: "Let me read the file",
  spendModel: "producer-model",
  steeringReason: "repeated_tool_call",
  nodeResult: "Inspected 12 files",
  /** The ratified declared-output answer (contract-derived, `recorded/PROVENANCE.md`). */
  answer: "The declared output",
  failureLine: "validator rejected the diff",
  failureTail: "second line of the failure",
} as const;

// Nothing may be asserted that the recorded bytes do not carry, and a value only a contract-derived
// file carries has to be declared below so no test reads it as captured server output. A capture of a
// real declared output lands it in a captured file, which fails this pin: update it and
// `recorded/PROVENANCE.md` together.
const CONTRACT_ONLY_VALUES = ["answer"];

function bytesOf(files: string[]): string {
  return files.map((file) => readFileSync(join(capturedDir, file), "utf8")).join("\n");
}

const recordedFiles = readdirSync(capturedDir).filter((file) => file.endsWith(".sse") || file.endsWith(".body"));
const capturedBytes = bytesOf(recordedFiles.filter((file) => !CONTRACT_DERIVED_FILES.includes(file)));
const contractBytes = bytesOf(CONTRACT_DERIVED_FILES);

for (const [name, value] of Object.entries(RECORDED)) {
  const origin = capturedBytes.includes(value)
    ? "captured bytes"
    : contractBytes.includes(value)
      ? "contract-derived bytes"
      : "no recorded file";
  const expected = CONTRACT_ONLY_VALUES.includes(name) ? "contract-derived bytes" : "captured bytes";
  if (origin !== expected) throw new Error(`RECORDED.${name} came from ${origin}, expected ${expected}`);
}

/** One live connection: multi-line chunk, multi-line thinking, live lifecycle and terminal frames. */
export const DEFAULT_STREAM = LIVE;
/** The captured live `node_dispatched` frame: its `data:` names the event and carries `ts`. */
export const DISPATCH = frameOf(LIVE, "node_dispatched");
/** The captured terminal frame: the SSE copy of the terminal event, which the client never reads. */
export const TERMINAL = frameOf(LIVE, "workflow_engine_finished");
/** A raw text chunk framed one `data:` line per payload line, as the producer frames it. */
export const CHUNK_MULTILINE = framesOf(LIVE)[0]!;
/** A named `thinking_delta` framed one `data:` line per payload line, as the producer frames it. */
export const THINKING_MULTILINE = framesOf(LIVE)[1]!;
// These two are taken by position in the captured connection; if a re-recording reorders them,
// the framing tests below would silently test the wrong frame.
if (!CHUNK_MULTILINE.startsWith("data: ") || !THINKING_MULTILINE.startsWith("event: thinking_delta\n")) {
  throw new Error("the captured live stream no longer starts with the chunk and thinking frames");
}
/** The captured `ping` keepalive and max-duration `reconnect` frames. */
export const CONTROL_FRAMES = recorded("control-frames.sse");
/** The captured keepalive ping: a transport frame that announces nothing about the run. */
export const PING = framesOf(CONTROL_FRAMES)[0]!;
/** The captured reconnect frame the server sends when a connection reaches its maximum age. */
export const RECONNECT = framesOf(CONTROL_FRAMES)[1]!;
/** The captured journal replay of a run whose terminal result is the retired marker. */
export const REPLAY_COMPLETED_STREAM = REPLAY_COMPLETED;
/** Journal replay framing around a seeded declared-output payload: the payload is contract-derived. */
export const REPLAY_DECLARED_STREAM = REPLAY_DECLARED;
/** The captured journal replay of a failed run. */
export const REPLAY_FAILED_STREAM = REPLAY_FAILED;

/**
 * A captured journal frame for one lifecycle event, with only the node it names changed. Journal
 * frames carry the producer's own payload fields (`result`, `error` and `reason`, `attempts`,
 * `duration_ms`) and the run id they were captured under — which the client never reads.
 */
export function lifecycle(event: string, node = "analysis"): string {
  const source = event === "node_failed" ? REPLAY_FAILED : REPLAY_COMPLETED;
  return renameNode(frameOf(source, event), node);
}

/**
 * A captured `node_progress` frame for one producer step, with the node it names and (for the
 * steps a test speaks about) its captured subject replaced. The `detail` key set always stays the
 * producer's: only the value inside it changes.
 *
 * `full-turn`/`relay-chunk` are the two `llm_response` shapes, `text-delta`/`thinking-delta` the
 * two `llm_delta` kinds; `spend`, `assistant-turn` and `steering` are the steps that carry agent
 * text or numbers and are never the run's answer.
 */
export type ProgressStep =
  | "full-turn"
  | "relay-chunk"
  | "text-delta"
  | "thinking-delta"
  | "tool-call"
  | "tool-result"
  | "spend"
  | "assistant-turn"
  | "steering";

const PROGRESS_STEPS: Record<ProgressStep, { step: string; marker: string; subject: string }> = {
  "full-turn": { step: "llm_response", marker: '"usage"', subject: RECORDED.fullTurnText },
  "relay-chunk": { step: "llm_response", marker: '"chunk":true', subject: RECORDED.relayedChunk },
  "text-delta": { step: "llm_delta", marker: '"kind":"text"', subject: RECORDED.deltaText },
  "thinking-delta": { step: "llm_delta", marker: '"kind":"thinking"', subject: RECORDED.batchedThinking },
  "tool-call": { step: "tool_call", marker: '"args"', subject: RECORDED.toolName },
  "tool-result": { step: "tool_result", marker: '"result"', subject: RECORDED.toolName },
  spend: { step: "llm_completed", marker: '"model"', subject: RECORDED.spendModel },
  "assistant-turn": { step: "assistant_turn", marker: '"tool_calls"', subject: RECORDED.internalText },
  steering: { step: "steering_intervention", marker: '"reason"', subject: RECORDED.steeringReason },
};

export function progressFrame(name: ProgressStep, subject?: string, node = "analysis"): string {
  const { step, marker, subject: captured } = PROGRESS_STEPS[name];
  const frame = framesOf(PROGRESS).find((entry) => entry.includes(`"step":"${step}"`) && entry.includes(marker));
  if (!frame) throw new Error(`the captured progress frames have no ${name} frame`);
  if (!subject) return renameNode(frame, node);
  if (!frame.includes(captured)) throw new Error(`the captured ${name} frame does not carry ${captured}`);
  return renameNode(frame.replaceAll(captured, subject), node);
}

function renameNode(frame: string, node: string): string {
  if (!frame.includes('"node_id":"analysis"')) throw new Error("the captured frame names no node to rename");
  return frame.replaceAll('"node_id":"analysis"', `"node_id":"${node}"`);
}

/**
 * A raw text chunk on the unnamed channel: no event name, no id, never persisted. This is the
 * captured single-line shape; a multi-line payload arrives as `CHUNK_MULTILINE`.
 */
export function textFrame(text: string): string {
  if (text.includes("\n")) throw new Error("a multi-line chunk must come from the capture (CHUNK_MULTILINE)");
  return `data: ${text}\n\n`;
}

/**
 * Reframe a built frame with CRLF line endings. The producer normalizes CR and CRLF to LF
 * (`SSE.Format.format_chunk/1`), so this stands for intermediary framing, not for what the
 * workflow API sends.
 */
export function crlf(frame: string): string {
  return frame.replaceAll("\n", "\r\n");
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** In echo mode, substitute what the endpoint actually received on the route sending these bytes. */
export const AUTH_ECHO = "$received-authorization";
/** In echo mode, substitute the request target the endpoint received, exactly as it arrived. */
export const TARGET_ECHO = "$received-request-target";

/** A rejection body in the shape every captured rejection uses. */
export function errorBody(message: string): string {
  return JSON.stringify({ error: message });
}

export interface EndpointOptions {
  /** Serve every route under this path prefix: a base URL's valid path prefix, kept verbatim. */
  prefix?: string;
  /** Run id this endpoint mints for a created run; the captures decide which one a test needs. */
  run?: string;
  result?: unknown;
  states?: ReadState[];
  /** Expand AUTH_ECHO in response bodies and stream frames to the received Authorization header. */
  echoAuth?: boolean;
  /** Expand TARGET_ECHO in served bytes to the request target this endpoint received. */
  echoTarget?: boolean;
  /** Recorded `GET /api/workflows/:id` answers, served in order, the last one repeating. */
  reads?: RecordedResponse[];
  streams?: string[];
  holdStream?: boolean;
  holdCreate?: boolean;
  /** Hold the supplied read body after its headers are sent. */
  holdRead?: boolean;
  /** Hold the stop acknowledgement after the endpoint receives the request. */
  holdStop?: boolean;
  /** Create rejection: captured status and body. */
  rejection?: RecordedResponse;
  /** Stop refusal: a persistent response or a sequence consumed before accepting Stop again. */
  stopRejection?: RecordedResponse | RecordedResponse[];
  /**
   * Honest stop acknowledgement: `stopped` (the default), `already_finished` (the log already
   * holds a terminal event, so the run keeps its own terminal state from GET), or `interrupted`
   * (a terminal-less dead runner).
   */
  stopOutcome?: "stopped" | "already_finished" | "interrupted";
  redirect?: string;
  loseCreateResponse?: boolean;
}

export interface TestEndpoint {
  url: string;
  /** The path prefix every route is served under ("" when the base has none). */
  prefix: string;
  /** The run id this endpoint hands out for a created run. */
  run: string;
  /** The run id as it appears in the run's routes: encoded once, the way the client encodes it. */
  segment: string;
  requests: EndpointRequest[];
  /** Wait for a request by its zero-based position in the wire log. */
  requestAt(index: number): Promise<EndpointRequest>;
  /** How many SSE responses this endpoint is holding open, excluding idle HTTP keep-alive sockets. */
  streamSocketsOpen(): number;
  /** Resolves when this endpoint sees the first open SSE response end or get cancelled. */
  streamSocketClosed(): Promise<void>;
  streamOpened: Promise<void>;
  createReceived: Promise<void>;
  stopReceived: Promise<void>;
  sendStream(frames: string): void;
  releaseStream(): void;
  releaseCreate(): void;
  releaseRead(): void;
  releaseStop(): void;
  close(): Promise<void>;
}

/** The declared output the test endpoint returns for a completed run unless told otherwise. */
export const DEFAULT_RESULT = {
  text: RECORDED.answer,
  usage: { input_tokens: 31 },
  termination_reason: "final_answer",
};

/** The id as it appears in a route, or a stand-in for an id that has no encoding at all. */
function safeSegment(id: string): string {
  try {
    return encodeURIComponent(id);
  } catch {
    return "id-without-encoding";
  }
}

export async function endpoint(options: EndpointOptions = {}): Promise<TestEndpoint> {
  const run = options.run ?? REMOTE_ID;
  // The client puts the id it was answered into a path segment, so the run's routes live under that
  // encoding and not under the raw id. An id with no encoding (an unpaired surrogate) is refused by
  // the client's create gate, so this endpoint serves no route for it and its segment says nothing.
  const segment = safeSegment(run);
  const prefix = options.prefix ?? "";
  const requests: EndpointRequest[] = [];
  const arrivals = new Map<number, ReturnType<typeof deferred<EndpointRequest>>>();
  const streamOpened = deferred<void>();
  const createReceived = deferred<void>();
  const stopReceived = deferred<void>();
  const releaseStream = deferred<void>();
  const releaseCreate = deferred<void>();
  const releaseRead = deferred<void>();
  const releaseStop = deferred<void>();
  const refusals = options.stopRejection;
  let stopIndex = 0;
  let sendFrames: ((frames: string) => void) | undefined;
  // `??` would turn an explicit empty result slot (null) into a delivered answer.
  const states = options.states ?? [
    readState({ result: options.result === undefined ? DEFAULT_RESULT : options.result }),
  ];
  let stateIndex = 0;
  let readIndex = 0;
  let streamIndex = 0;
  let stopped = false;
  let streamReleased = !options.holdStream;
  let closed = false;
  // "One connection at a time" and "a walked-away connection is closed" are only testable from the
  // server's side: the client can keep a socket it will never read again.
  const openStreams = new Set<ServerResponse>();
  const socketClosed = deferred<void>();
  const finishStream = () => {
    streamReleased = true;
    releaseStream.resolve();
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = req.url ?? "";
    const request = {
      method: req.method ?? "",
      path,
      body: Buffer.concat(chunks).toString("utf8"),
      contentType: req.headers["content-type"],
      authorization: req.headers.authorization,
      lastEventId: req.headers["last-event-id"] as string | undefined,
      receivedAt: Date.now(),
    };
    const index = requests.push(request) - 1;
    arrivals.get(index)?.resolve(request);
    arrivals.delete(index);

    function echo(body: string, received: string, target: string): string {
      // A body carries these as JSON string data; a stream frame carries them as the bytes they
      // arrived in.
      const authorized = options.echoAuth ? body.replaceAll(AUTH_ECHO, () => received) : body;
      return options.echoTarget ? authorized.replaceAll(TARGET_ECHO, () => target) : authorized;
    }
    const authorization = req.headers.authorization ?? "no authorization header";
    const jsonAuthorization = JSON.stringify(authorization).slice(1, -1);
    const jsonTarget = JSON.stringify(path).slice(1, -1);
    function answer({ status, body }: RecordedResponse): void {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(echo(body, jsonAuthorization, jsonTarget));
    }
    function json(status: number, value: unknown): void {
      answer({ status, body: JSON.stringify(value) });
    }

    if (req.method === "POST" && path === `${prefix}/api/workflows`) {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        json(415, { error: "Expected a JSON request body" });
        return;
      }
      createReceived.resolve();
      if (options.holdCreate) await releaseCreate.promise;
      if (options.loseCreateResponse) {
        res.destroy();
      } else if (options.redirect) {
        res.writeHead(307, { location: options.redirect });
        res.end();
      } else if (options.rejection) {
        answer(options.rejection);
      } else {
        json(201, { workflow_id: run, task_id: run });
      }
    } else if (req.method === "GET" && path === `${prefix}/api/workflows/${segment}/stream`) {
      openStreams.add(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (frames: string): void => {
        res.write(echo(frames, authorization, path));
      };
      sendFrames = send;
      res.on("close", () => {
        if (sendFrames === send) sendFrames = undefined;
        openStreams.delete(res);
        socketClosed.resolve();
      });
      send(options.streams?.[streamIndex++] ?? DEFAULT_STREAM);
      streamOpened.resolve();
      if (options.holdStream) await releaseStream.promise;
      // The terminal frames the journal really holds: `workflow_failed` carries `reason`.
      res.end(
        options.streams
          ? undefined
          : stopped
            ? frameOf(REPLAY_FAILED, "workflow_failed")
            : frameOf(REPLAY_DECLARED, "workflow_engine_finished"),
      );
    } else if (req.method === "GET" && path === `${prefix}/api/workflows/${segment}`) {
      if (options.reads) {
        const read = options.reads[Math.min(readIndex++, options.reads.length - 1)]!;
        if (options.holdRead) {
          res.writeHead(read.status, { "content-type": "application/json" });
          res.flushHeaders();
          await releaseRead.promise;
          res.end(echo(read.body, jsonAuthorization, jsonTarget));
        } else {
          answer(read);
        }
        return;
      }
      const state = stopped
        ? readState({ status: "failed", error: "terminated" })
        : !streamReleased
          ? readState({ status: "running" })
          : states[Math.min(stateIndex++, states.length - 1)]!;
      json(200, readBody(run, state));
    } else if (req.method === "POST" && path === `${prefix}/api/workflows/${segment}/stop`) {
      stopReceived.resolve();
      if (options.holdStop) await releaseStop.promise;
      const rejection = Array.isArray(refusals) ? refusals[stopIndex++] : refusals;
      if (rejection) {
        answer(rejection);
      } else {
        const ack = options.stopOutcome ?? "stopped";
        // Only a live kill leaves the terminated footprint; an already-finished run's own
        // terminal state is whatever GET derives from the log.
        if (ack === "stopped") {
          stopped = true;
          finishStream();
        }
        json(200, stopAck(ack, run));
      }
    } else {
      json(404, { error: "Workflow not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint: TestEndpoint = {
    url: `http://127.0.0.1:${port}`,
    prefix,
    run,
    segment,
    requests,
    requestAt(index) {
      if (requests[index]) return Promise.resolve(requests[index]);
      const next = arrivals.get(index) ?? deferred<EndpointRequest>();
      arrivals.set(index, next);
      return next.promise;
    },
    streamSocketsOpen: () => openStreams.size,
    streamSocketClosed: () => socketClosed.promise,
    streamOpened: streamOpened.promise,
    createReceived: createReceived.promise,
    stopReceived: stopReceived.promise,
    sendStream(frames) {
      if (!sendFrames) throw new Error("No open stream to send frames to");
      sendFrames(frames);
    },
    releaseStream: finishStream,
    releaseCreate: () => releaseCreate.resolve(),
    releaseRead: () => releaseRead.resolve(),
    releaseStop: () => releaseStop.resolve(),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseCreate.resolve();
      releaseRead.resolve();
      releaseStop.resolve();
      finishStream();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
  return endpoint;
}

/** The only way a test gets an endpoint: resolution mints the request base, nothing casts it. */
export function mintEndpoint(url: string, apiKey?: string): WorkflowEndpoint {
  const resolution = resolveWorkflowEndpoint(
    { endpoints: { local: { url, ...(apiKey ? { apiKey } : {}) } }, defaultEndpoint: "local" },
    "local",
  );
  if (!resolution.ok) throw new Error(`the fixture endpoint ${JSON.stringify(url)} must resolve: ${resolution.error}`);
  return resolution.endpoint;
}

/** The requests this endpoint served for one of the client's four operations, under its prefix. */
export function createRequests(server: TestEndpoint): TestEndpoint["requests"] {
  return server.requests.filter((entry) => entry.method === "POST" && entry.path === `${server.prefix}/api/workflows`);
}

export function readRequests(server: TestEndpoint): TestEndpoint["requests"] {
  return server.requests.filter(
    (entry) => entry.method === "GET" && entry.path === `${server.prefix}/api/workflows/${server.segment}`,
  );
}

export function streamRequests(server: TestEndpoint): TestEndpoint["requests"] {
  return server.requests.filter((entry) => entry.method === "GET" && entry.path.endsWith("/stream"));
}

export function stopRequests(server: TestEndpoint): TestEndpoint["requests"] {
  return server.requests.filter(
    (entry) => entry.method === "POST" && entry.path === `${server.prefix}/api/workflows/${server.segment}/stop`,
  );
}

/**
 * Await a remote milestone, but fail with a named reason if the run ends first: without this a
 * broken settle path shows up as a bare test timeout.
 */
export async function beforeEnd(milestone: Promise<unknown>, ended: Promise<unknown>, what: string): Promise<void> {
  await Promise.race([
    milestone,
    ended.then(() => {
      throw new Error(`the run ended before ${what}`);
    }),
  ]);
}

/** Run real loopback HTTP with a virtual application clock. Restore globals before restoring timers. */
export function clockedLoopback() {
  // Undici also schedules socket timers. Keep those real, so a pending clock job means the
  // extension left work behind, not that the HTTP connection pool is still alive.
  const network = new AsyncLocalStorage<true>();
  const nativeSet = setTimeout;
  const nativeClear = clearTimeout;
  const nativeFetch = fetch;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const virtualSet = setTimeout;
  const virtualClear = clearTimeout;
  const virtualHandles = new WeakSet<NodeJS.Timeout>();
  vi.stubGlobal("setTimeout", (...args: Parameters<typeof setTimeout>) => {
    if (network.getStore()) return nativeSet(...args);
    const handle = virtualSet(...args);
    virtualHandles.add(handle);
    return handle;
  });
  vi.stubGlobal("clearTimeout", (handle: Parameters<typeof clearTimeout>[0]) => {
    if (typeof handle === "object" && virtualHandles.has(handle)) virtualClear(handle);
    else nativeClear(handle);
  });

  // Synchronize virtual clock steps to real I/O without replacing Fetch or presuming how the
  // application reads JSON. Only the small, finite JSON replies are observed to their end.
  const exchanges: Array<{ path: string; method: string; at: number; opened: Promise<void>; bodyRead: Promise<void> }> =
    [];
  vi.stubGlobal("fetch", (async (input, init) => {
    const opened = deferred<void>();
    const bodyRead = deferred<void>();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    exchanges.push({
      path: new URL(url).pathname,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      at: Date.now(),
      opened: opened.promise,
      bodyRead: bodyRead.promise,
    });
    try {
      return await network.run(true, async () => {
        const response = await nativeFetch(input, init);
        if (response.headers.get("content-type")?.startsWith("application/json")) {
          const received = () => bodyRead.resolve();
          void response.clone().arrayBuffer().then(received, received);
        }
        return response;
      });
    } catch (error) {
      bodyRead.resolve();
      throw error;
    } finally {
      opened.resolve();
    }
  }) satisfies typeof fetch);
  return exchanges;
}

/** An in-memory Fetch substitute for tests that do not need an HTTP socket. */
export interface FetchFake {
  fetch: typeof fetch;
  /** Every request the client made, in order, with the full URL it targeted. */
  requests(): Array<{ method: string; url: string; authorization: string | undefined }>;
  /** How many `GET /api/workflows/:id` reads have been served. */
  reads(): number;
}

export interface FetchFakeOptions {
  /** Run id the create answer hands out; captures other than the default need their own. */
  run?: string;
  /** Serve the SSE connection: push its frames, then close it when it ends. */
  stream(push: (frame: string) => void, close: () => void): void;
  /** Answer `GET /api/workflows/:id`; called with the 1-based read number. */
  read(reads: number): Response;
  /** Answer `POST /api/workflows/:id/stop`; the acknowledged stop unless the test says otherwise.
   * Receives the request's abort signal, so a held stop can honour an abort the way a real
   * transport would. */
  stop?(signal?: AbortSignal): Response | Promise<Response>;
}

export function fakeWorkflowFetch(options: FetchFakeOptions): FetchFake {
  const encoder = new TextEncoder();
  const run = options.run ?? REMOTE_ID;
  const segment = encodeURIComponent(run);
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  let reads = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ method, url, authorization: headerValue(init?.headers, "authorization") });
    if (method === "POST" && url.endsWith("/api/workflows")) {
      return jsonResponse(201, { workflow_id: run, task_id: run });
    }
    if (method === "GET" && url.endsWith(`/api/workflows/${segment}/stream`)) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(control) {
            options.stream(
              (frame) => control.enqueue(encoder.encode(frame)),
              () => control.close(),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (method === "GET" && url.endsWith(`/api/workflows/${segment}`)) {
      reads += 1;
      return options.read(reads);
    }
    if (method === "POST" && url.endsWith(`/api/workflows/${segment}/stop`)) {
      return options.stop?.(init?.signal ?? undefined) ?? jsonResponse(200, stopAck("stopped", run));
    }
    throw new Error(`Unexpected workflow test request: ${method} ${url}`);
  };
  return { fetch: fetchFake, requests: () => [...requests], reads: () => reads };
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()];
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function readState(overrides: Partial<ReadState> = {}): ReadState {
  return { status: "completed", result: null, error: null, events: [], ...overrides };
}

function readBody(run: string, state: ReadState) {
  return { workflow_id: run, task_id: run, ...state };
}

/** A scripted read with the exact keys the endpoint answers for every known run. */
export function stateReply(overrides: Partial<ReadState>): RecordedResponse {
  return { status: 200, body: JSON.stringify(readBody(REMOTE_ID, readState(overrides))) };
}

/** The stop acknowledgement: the captured ack answers with the run id next to the status. */
export function stopAck(status: string, run: string): Record<string, unknown> {
  return { status, workflow_id: run };
}

// The double must not drift from the captured contract: the bodies it constructs for a run state
// and for a stop carry the key set the server really answers with, so a synthetic answer cannot
// pass a test the captured bytes would fail.
const capturedKeySets = Object.entries(capturedStatuses)
  .filter(([name, status]) => status === 200 && (name.startsWith("read-") || name.startsWith("stop-")))
  .map(
    ([name]) =>
      [
        name,
        Object.keys(JSON.parse(recorded(`${name}.body`)) as object)
          .sort()
          .join(","),
      ] as const,
  );

for (const [name, keys] of capturedKeySets) {
  const built = name.startsWith("stop-") ? stopAck("stopped", "x") : readBody("x", readState());
  const builtKeys = Object.keys(built).sort().join(",");
  if (builtKeys !== keys) {
    throw new Error(`the test endpoint's ${builtKeys} keys are not the captured ${name} keys ${keys}`);
  }
}

export interface Workspace {
  root: string;
  agentDir: string;
  project: string;
}

export function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "workflow-acceptance-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, agentDir, project };
}

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function workflow(name = "audit", description = "Inspect a repository", node = "analysis"): string {
  return `name: ${name}\ndescription: ${description}\nnodes:\n  - id: ${node}\n    params:\n      task_description: "{{task_description}}"\nedges: []\nentry_node: ${node}\n`;
}

export function configure(ws: Workspace, url: string, apiKey?: string): void {
  write(
    join(ws.agentDir, "subagents-lite.json"),
    JSON.stringify({
      workflows: { endpoints: { local: { url, ...(apiKey ? { apiKey } : {}) } }, defaultEndpoint: "local" },
    }),
  );
}

/**
 * The workflow file and endpoint config one single-workflow session needs: the `audit` workflow, and
 * `remote` as the endpoint its default route resolves to. Install it before the session starts.
 */
export function installWorkflow(ws: Workspace, remote: TestEndpoint): void {
  write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
  configure(ws, remote.url);
}
