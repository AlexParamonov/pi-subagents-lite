/**
 * fixtures.ts — the Workflow endpoint the acceptance tests drive: the real HTTP protocol
 * (create, SSE follow, GET reconcile, stop) on a loopback socket, plus the file and config
 * workspace the extension scans.
 *
 * `holdStream`/`holdCreate` and the release handles replace sleeping: a test waits on the
 * milestone it needs. GET answers the fixed key set for every run state, so an empty result
 * slot is `result: null` here exactly as it is on the wire. `fakeWorkflowFetch` serves the same
 * contract without a socket, for the tests that run on fake timers.
 */

import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

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

/** The id this test endpoint mints for every created run. */
export const REMOTE_ID = "remote-42";

/** Endpoint URL for runs whose traffic `fakeWorkflowFetch` serves instead of a socket. */
export const FAKED_URL = "http://127.0.0.1:43199";

export function readState(overrides: Partial<ReadState> = {}): ReadState {
  return { status: "completed", result: null, error: null, events: [], ...overrides };
}

export interface EndpointOptions {
  result?: unknown;
  states?: ReadState[];
  streams?: string[];
  holdStream?: boolean;
  holdCreate?: boolean;
  rejection?: { status: number; message: string };
  stopRejection?: { status: number; message: string };
  redirect?: string;
  loseCreateResponse?: boolean;
}

export interface TestEndpoint {
  url: string;
  requests: Request[];
  streamOpened: Promise<void>;
  createReceived: Promise<void>;
  stopReceived: Promise<void>;
  releaseStream(): void;
  releaseCreate(): void;
  close(): Promise<void>;
}

const DEFAULT_RESULT = {
  text: "The declared output",
  usage: { input_tokens: 31 },
  termination_reason: "final_answer",
};
export const DISPATCH = `id: 1\nevent: node_dispatched\ndata: {"node_id":"analysis","workflow_id":"${REMOTE_ID}","task_id":"${REMOTE_ID}","ts":1700000000000}\n\n`;
export const DEFAULT_STREAM =
  DISPATCH + "event: thinking_delta\ndata: private chain of thought\n\n" + "data: Inspecting the repository\n\n";
export const TERMINAL = `id: 2\nevent: workflow_engine_finished\ndata: {"workflow_id":"${REMOTE_ID}","ts":1700000001000}\n\n`;

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

export async function endpoint(options: EndpointOptions = {}): Promise<TestEndpoint> {
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
        json(res, options.rejection.status, { error: options.rejection.message });
      } else {
        json(res, 201, { workflow_id: REMOTE_ID, task_id: REMOTE_ID });
      }
    } else if (req.method === "GET" && path === `/api/workflows/${REMOTE_ID}/stream`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(options.streams?.[streamIndex++] ?? DEFAULT_STREAM);
      streamOpened.resolve();
      if (options.holdStream) await releaseStream.promise;
      res.end(
        options.streams
          ? undefined
          : stopped
            ? `id: 2\nevent: workflow_failed\ndata: {"workflow_id":"${REMOTE_ID}","error":"terminated","ts":1700000001000}\n\n`
            : TERMINAL,
      );
    } else if (req.method === "GET" && path === `/api/workflows/${REMOTE_ID}`) {
      const state = stopped
        ? readState({ status: "failed", error: "terminated" })
        : !streamReleased
          ? readState({ status: "running" })
          : states[Math.min(stateIndex++, states.length - 1)]!;
      json(res, 200, { workflow_id: REMOTE_ID, task_id: REMOTE_ID, ...state });
    } else if (req.method === "POST" && path === `/api/workflows/${REMOTE_ID}/stop`) {
      if (options.stopRejection) {
        json(res, options.stopRejection.status, { error: options.stopRejection.message });
      } else {
        stopped = true;
        json(res, 200, { status: "stopped" });
        finishStream();
      }
      stopReceived.resolve();
    } else {
      json(res, 404, { error: "unknown test route" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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
  /** How many `GET /api/workflows/:id` reads have been served. */
  reads(): number;
}

export interface FetchFakeOptions {
  /** Serve the SSE connection: push its frames, then close it when it ends. */
  stream(push: (frame: string) => void, close: () => void): void;
  /** Answer `GET /api/workflows/:id`; called with the 1-based read number. */
  read(reads: number): Response;
}

export function fakeWorkflowFetch(options: FetchFakeOptions): FetchFake {
  const encoder = new TextEncoder();
  let reads = 0;
  const fetchFake: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "POST" && url.endsWith("/api/workflows")) {
      return jsonResponse(201, { workflow_id: REMOTE_ID, task_id: REMOTE_ID });
    }
    if (method === "GET" && url.endsWith(`/api/workflows/${REMOTE_ID}/stream`)) {
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
    if (method === "GET" && url.endsWith(`/api/workflows/${REMOTE_ID}`)) {
      reads += 1;
      return options.read(reads);
    }
    throw new Error(`Unexpected workflow test request: ${method} ${url}`);
  };
  return { fetch: fetchFake, reads: () => reads };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
