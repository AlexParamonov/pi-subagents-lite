/**
 * fixtures.ts — the Workflow endpoint the acceptance tests drive: the real HTTP protocol
 * (create, SSE follow, GET reconcile, stop) on a loopback socket, plus the file and config
 * workspace the extension scans.
 *
 * Every protocol body and SSE frame comes out of `recorded/`: bytes captured from the anagen-x
 * workflow API (see `recorded/PROVENANCE.md`). `lifecycle` and `progressFrame` select a captured
 * frame and rename only the node it names; `textFrame` and `crlf` build the two framings a
 * capture cannot give on demand (an arbitrary single line, and CRLF, which the server itself
 * normalizes to LF but an intermediary may send). A test that needs a value the capture does not
 * contain adds a capture, it does not invent a frame.
 *
 * `holdStream`/`holdCreate` and the release handles replace sleeping: a test waits on the
 * milestone it needs. GET answers the captured fixed key set for every run state, so an empty
 * result slot is `result: null` here exactly as it is on the wire. `fakeWorkflowFetch` serves the
 * same contract without a socket, for tests that push frames one at a time or run on fake timers.
 */

import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

interface Request {
  method: string;
  path: string;
  body: string;
  contentType: string | undefined;
  authorization: string | undefined;
  lastEventId: string | undefined;
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

/** The captured bytes of one SSE stream or frame sequence. */
export function recorded(name: string): string {
  return readFileSync(join(capturedDir, name), "utf8");
}

/** The captured status and body of one HTTP response. */
export function recordedResponse(name: string): RecordedResponse {
  const status = capturedStatuses[name];
  if (status === undefined) throw new Error(`responses.json records no status for ${name}`);
  return { status, body: recorded(`${name}.body`) };
}

/** Answer `GET /api/workflows/:id` with a captured body and its captured status code. */
export function recordedRead(name: string): Response {
  const { status, body } = recordedResponse(name);
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** Split a captured stream into its frames: SSE frames are separated by a blank line. */
export function framesOf(stream: string): string[] {
  return stream.split("\n\n").filter((frame) => frame !== "");
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

/** The values the captured payloads carry, so a test asserts on what the server really sent. */
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
  steeringReason: "cap_reached",
  nodeResult: "Inspected 12 files",
  /** The declared output the captured completed run delivers, and the failure it can carry. */
  answer: "The declared output",
  failureLine: "validator rejected the diff",
  failureTail: "second line of the failure",
} as const;

// Nothing may be asserted that the server never sent: every value above has to appear in the
// captured bytes, or a test would be checking a string this API does not produce.
const corpus = readdirSync(capturedDir)
  .filter((file) => file.endsWith(".sse") || file.endsWith(".body"))
  .map((file) => readFileSync(join(capturedDir, file), "utf8"))
  .join("\n");

for (const [name, value] of Object.entries(RECORDED)) {
  if (!corpus.includes(value)) throw new Error(`RECORDED.${name} is not present in the captured bytes`);
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
/** The captured journal replay of a run that delivers its declared output. */
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

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** A rejection body in the shape every captured rejection uses. */
export function errorBody(message: string): string {
  return JSON.stringify({ error: message });
}

export interface EndpointOptions {
  /** Run id this endpoint mints for a created run; the captures decide which one a test needs. */
  run?: string;
  result?: unknown;
  states?: ReadState[];
  /** Captured `GET /api/workflows/:id` answers, served in order, the last one repeating. */
  reads?: RecordedResponse[];
  streams?: string[];
  holdStream?: boolean;
  holdCreate?: boolean;
  /** Create rejection: captured status and body. */
  rejection?: RecordedResponse;
  /** Stop rejection: captured status and body. */
  stopRejection?: RecordedResponse;
  /**
   * Honest stop acknowledgement. `already_finished` (the default is `stopped`) means the log
   * already holds a terminal event, so the run keeps its own terminal state from GET instead of
   * the killed-run footprint a `stopped` ack leaves behind.
   */
  stopOutcome?: "stopped" | "already_finished";
  redirect?: string;
  loseCreateResponse?: boolean;
}

export interface TestEndpoint {
  url: string;
  /** The run id this endpoint hands out for a created run. */
  run: string;
  requests: Request[];
  streamOpened: Promise<void>;
  createReceived: Promise<void>;
  stopReceived: Promise<void>;
  releaseStream(): void;
  releaseCreate(): void;
  close(): Promise<void>;
}

/** The declared output the test endpoint returns for a completed run unless told otherwise. */
export const DEFAULT_RESULT = {
  text: RECORDED.answer,
  usage: { input_tokens: 31 },
  termination_reason: "final_answer",
};

export async function endpoint(options: EndpointOptions = {}): Promise<TestEndpoint> {
  const run = options.run ?? REMOTE_ID;
  const requests: Request[] = [];
  const streamOpened = deferred<void>();
  const createReceived = deferred<void>();
  const stopReceived = deferred<void>();
  const releaseStream = deferred<void>();
  const releaseCreate = deferred<void>();
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
  const finishStream = () => {
    streamReleased = true;
    releaseStream.resolve();
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = req.url ?? "";
    requests.push({
      method: req.method ?? "",
      path,
      body: Buffer.concat(chunks).toString("utf8"),
      contentType: req.headers["content-type"],
      authorization: req.headers.authorization,
      lastEventId: req.headers["last-event-id"] as string | undefined,
    });

    if (req.method === "POST" && path === "/api/workflows") {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        json(res, 415, { error: "Expected a JSON request body" });
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
        res.writeHead(options.rejection.status, { "content-type": "application/json" });
        res.end(options.rejection.body);
      } else {
        json(res, 201, { workflow_id: run, task_id: run });
      }
    } else if (req.method === "GET" && path === `/api/workflows/${run}/stream`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(options.streams?.[streamIndex++] ?? DEFAULT_STREAM);
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
    } else if (req.method === "GET" && path === `/api/workflows/${run}`) {
      if (options.reads) {
        const read = options.reads[Math.min(readIndex++, options.reads.length - 1)]!;
        res.writeHead(read.status, { "content-type": "application/json" });
        res.end(read.body);
        return;
      }
      const state = stopped
        ? readState({ status: "failed", error: "terminated" })
        : !streamReleased
          ? readState({ status: "running" })
          : states[Math.min(stateIndex++, states.length - 1)]!;
      json(res, 200, { workflow_id: run, task_id: run, ...state });
    } else if (req.method === "POST" && path === `/api/workflows/${run}/stop`) {
      if (options.stopRejection) {
        res.writeHead(options.stopRejection.status, { "content-type": "application/json" });
        res.end(options.stopRejection.body);
      } else {
        const ack = options.stopOutcome ?? "stopped";
        // Only a live kill leaves the terminated footprint; an already-finished run's own
        // terminal state is whatever GET derives from the log.
        if (ack === "stopped") stopped = true;
        json(res, 200, stopAck(ack, run));
        finishStream();
      }
      stopReceived.resolve();
    } else {
      json(res, 404, { error: "Workflow not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    run,
    requests,
    streamOpened: streamOpened.promise,
    createReceived: createReceived.promise,
    stopReceived: stopReceived.promise,
    releaseStream: finishStream,
    releaseCreate: () => releaseCreate.resolve(),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseCreate.resolve();
      finishStream();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/**
 * A `fetch` fake for the timing tests, where fake timers must not govern the
 * transport's own timers: the client code under test stays real, only the
 * socket is replaced.
 */
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
}

export function fakeWorkflowFetch(options: FetchFakeOptions): FetchFake {
  const encoder = new TextEncoder();
  const run = options.run ?? REMOTE_ID;
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  let reads = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ method, url, authorization: headerValue(init?.headers, "authorization") });
    if (method === "POST" && url.endsWith("/api/workflows")) {
      return jsonResponse(201, { workflow_id: run, task_id: run });
    }
    if (method === "GET" && url.endsWith(`/api/workflows/${run}/stream`)) {
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
    if (method === "GET" && url.endsWith(`/api/workflows/${run}`)) {
      reads += 1;
      return options.read(reads);
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

/** The stop acknowledgement: the captured ack answers with the run id next to the status. */
function stopAck(status: string, run: string): Record<string, unknown> {
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
  const built = name.startsWith("stop-") ? stopAck("stopped", "x") : { workflow_id: "", task_id: "", ...readState() };
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
