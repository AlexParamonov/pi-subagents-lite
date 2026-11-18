/**
 * workflow-client.test.ts — The WorkflowClient: one endpoint's HTTP protocol.
 *
 * Everything enters at the client and leaves through a real loopback socket serving the captured
 * bytes (`recorded/`, see `fixtures.ts`), so a pass means the request the endpoint documents
 * arrived and the bytes it answered became the caller's result. Only the timing tests replace the
 * socket, because they run on fake timers.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CHUNK_MULTILINE,
  CONTROL_FRAMES,
  COMPLETED_RUN,
  crlf,
  DEFAULT_RESULT,
  DISPATCH,
  endpoint,
  errorBody,
  FAILED_RUN,
  PING,
  FAKED_URL,
  fakeWorkflowFetch,
  jsonResponse,
  lifecycle,
  progressFrame,
  readState,
  recordedResponse,
  RECORDED,
  REMOTE_ID,
  REPLAY_COMPLETED_STREAM,
  REPLAY_FAILED_STREAM,
  TERMINAL,
  textFrame,
  THINKING_MULTILINE,
  type EndpointOptions,
  type TestEndpoint,
} from "./fixtures.js";
import type {
  WorkflowCreate,
  WorkflowOutcome,
  WorkflowDisplayItem,
  WorkflowEndpoint,
  WorkflowView,
} from "../../src/workflows/workflow-client.js";

let servers: TestEndpoint[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
  vi.unstubAllGlobals();
});

async function remote(options: EndpointOptions = {}): Promise<TestEndpoint> {
  const server = await endpoint(options);
  servers.push(server);
  return server;
}

async function client(url: string, apiKey?: string, fetchImpl?: typeof fetch) {
  const { createWorkflowClient } = await import("../../src/workflows/workflow-client.js");
  const endpoint: WorkflowEndpoint = { name: "local", url, ...(apiKey ? { apiKey } : {}) };
  return createWorkflowClient(endpoint, fetchImpl ? { fetch: fetchImpl } : {});
}

/** The parsed Workflow file, as discovery hands it over: graph keys plus the client-owned one. */
const DEFINITION = {
  name: "audit",
  description: "Inspect a repository",
  nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
  edges: [],
  entry_node: "analysis",
  endpoint: "release",
};

function request(prompt = "Review the repository", workingDir = "/srv/checkout") {
  return { prompt, definition: DEFINITION, workingDir };
}

function createRequests(server: TestEndpoint) {
  return server.requests.filter((entry) => entry.method === "POST" && entry.path === "/api/workflows");
}

function streamRequests(server: TestEndpoint) {
  return server.requests.filter((entry) => entry.method === "GET" && entry.path.endsWith("/stream"));
}

function readRequests(server: TestEndpoint) {
  return server.requests.filter((entry) => entry.method === "GET" && entry.path === `/api/workflows/${server.run}`);
}

function createBody(server: TestEndpoint): Record<string, unknown> {
  const [create] = createRequests(server);
  expect(create, "the endpoint must receive the create request").toBeDefined();
  return JSON.parse(create!.body) as Record<string, unknown>;
}

function error(run: WorkflowCreate): string {
  if (run.ok) throw new Error(`expected the create to fail, got ${JSON.stringify(run)}`);
  return run.error;
}

describe("create", () => {
  it("posts the prompt and the file's config with its endpoint key stripped", async () => {
    const server = await remote();

    const run = await (await client(server.url)).create(request());

    expect(run).toEqual({ ok: true, workflowId: server.run, taskId: server.run });
    expect(createBody(server)).toEqual({
      prompt: "Review the repository",
      workflow_config: {
        name: "audit",
        description: "Inspect a repository",
        nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
        edges: [],
        entry_node: "analysis",
        prompt_vars: { working_dir: "/srv/checkout" },
      },
    });
    expect(createRequests(server)[0]!.contentType).toMatch(/^application\/json(?:\s*;|$)/i);
  });

  it("keeps the file's own prompt vars next to the injected working directory", async () => {
    const server = await remote();

    await (
      await client(server.url)
    ).create({
      prompt: "Review release",
      definition: { ...DEFINITION, prompt_vars: { branch: "stable" } },
      workingDir: "/srv/checkout",
    });

    expect(createBody(server).workflow_config).toEqual({
      name: "audit",
      description: "Inspect a repository",
      nodes: [{ id: "analysis", params: { task_description: "{{task_description}}" } }],
      edges: [],
      entry_node: "analysis",
      prompt_vars: { branch: "stable", working_dir: "/srv/checkout" },
    });
  });

  it("sends the bearer key only when the endpoint carries one", async () => {
    const withKey = await remote();
    const withoutKey = await remote();

    await (await client(withKey.url, "example-key")).create(request());
    await (await client(withoutKey.url)).create(request());

    expect(createRequests(withKey)[0]!.authorization).toBe("Bearer example-key");
    expect(createRequests(withoutKey)[0]!.authorization).toBeUndefined();
  });

  it("rejects an empty prompt before contacting the endpoint", async () => {
    const server = await remote();

    const run = await (await client(server.url)).create(request(""));

    expect(error(run)).toMatch(/prompt/i);
    expect(server.requests).toEqual([]);
  });

  it("rejects a prompt over the endpoint's byte cap before contacting it", async () => {
    const server = await remote();

    const run = await (await client(server.url)).create(request("é".repeat(5001)));

    expect(error(run)).toContain("10,000");
    expect(server.requests).toEqual([]);
  });

  it("accepts a prompt of exactly the byte cap", async () => {
    const server = await remote();
    const prompt = "é".repeat(5000);

    const run = await (await client(server.url)).create(request(prompt));

    expect(run.ok).toBe(true);
    expect(createBody(server).prompt).toBe(prompt);
  });

  for (const name of ["create-missing-prompt", "create-config-not-object"] as const) {
    it(`surfaces the captured ${name} rejection with the endpoint that answered it`, async () => {
      const server = await remote({ rejection: recordedResponse(name) });
      const stated = (JSON.parse(recordedResponse(name).body) as { error: string }).error;

      const run = await (await client(server.url)).create(request());

      expect(error(run)).toContain(stated);
      expect(error(run)).toContain(server.url);
    });
  }

  it("keeps an echoed key out of the error it reports", async () => {
    const key = "example-private-key";
    const server = await remote({
      rejection: { status: 422, body: errorBody(`Remote validation failed; credential ${key}`) },
    });

    const run = await (await client(server.url, key)).create(request());

    expect(error(run)).toContain("Remote validation failed");
    expect(error(run)).not.toContain(key);
  });

  it("reports a create whose response never arrived as an unknown outcome, sent once", async () => {
    const server = await remote({ loseCreateResponse: true });

    const run = await (await client(server.url)).create(request());

    expect(error(run)).toContain(server.url);
    expect(error(run)).toMatch(/unknown outcome/i);
    expect(error(run)).toMatch(/may still be running/i);
    expect(createRequests(server)).toHaveLength(1);
  });

  it("names the endpoint and its configured key when nothing answers", async () => {
    const server = await remote();
    await server.close();

    const run = await (await client(server.url)).create(request());

    expect(error(run)).toContain(server.url);
    expect(error(run)).toContain("local");
  });

  it("refuses a cross-origin redirect rather than re-sending the key", async () => {
    const other = await remote();
    const server = await remote({ redirect: `${other.url}/api/workflows` });

    const run = await (await client(server.url, "redirect-key")).create(request());

    expect(error(run)).toContain(server.url);
    expect(other.requests).toEqual([]);
  });

  it("takes its ids from the already_started body as from the created one", async () => {
    const server = await remote();
    const { createWorkflowClient } = await import("../../src/workflows/workflow-client.js");

    const run = await createWorkflowClient(
      { name: "local", url: server.url },
      {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ workflow_id: COMPLETED_RUN, task_id: COMPLETED_RUN }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
      },
    ).create(request());

    expect(run).toEqual({ ok: true, workflowId: COMPLETED_RUN, taskId: COMPLETED_RUN });
  });
});

// ── monitor: what the stream becomes on screen ───────────────────────────

interface Watcher {
  snapshots: WorkflowDisplayItem[][];
  view: WorkflowView;
  /** Resolve once a snapshot satisfying `seen` has been published; fail if the run ends first. */
  until(seen: (snapshot: WorkflowDisplayItem[]) => boolean, settled: Promise<unknown>, what: string): Promise<void>;
}

function watcher(signal?: AbortSignal): Watcher {
  const snapshots: WorkflowDisplayItem[][] = [];
  const view: WorkflowView = {
    onUpdate: (items) => snapshots.push(items.map((item) => ({ ...item }))),
    ...(signal ? { signal } : {}),
  };
  return {
    snapshots,
    view,
    until: (seen, settled, what) =>
      beforeEnd(
        vi.waitFor(() => expect(snapshots.some(seen), `no view where ${what}`).toBe(true)),
        settled,
        `a view where ${what}`,
      ),
  };
}

async function beforeEnd(milestone: Promise<unknown>, settled: Promise<unknown>, what: string): Promise<void> {
  await Promise.race([
    milestone,
    settled.then(() => {
      throw new Error(`the run settled before ${what}`);
    }),
  ]);
}

function texts(snapshots: WorkflowDisplayItem[][]): string[] {
  return snapshots.flatMap((snapshot) => snapshot.flatMap((item) => (item.type === "text" ? [item.text] : [])));
}

/** Run the monitor over a stream the test controls; `settled` carries the outcome. */
function follow(run: Awaited<ReturnType<typeof client>>, server: TestEndpoint, signal?: AbortSignal) {
  const watch = watcher(signal);
  const settled = run.monitor(server.run, watch.view);
  return { ...watch, settled };
}

describe("monitor display", () => {
  it("reports one status line per node lifecycle event", async () => {
    const frames =
      lifecycle("node_dispatched", "analysis") +
      lifecycle("node_complete", "analysis") +
      lifecycle("node_dispatched", "report") +
      lifecycle("node_failed", "report") +
      lifecycle("node_dispatched", "review");
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => s.length >= 3, settled, "each node has a status line");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "completed" },
      { type: "node-status", node: "report", status: "failed" },
      { type: "node-status", node: "review", status: "dispatched" },
    ]);
  });

  it("puts streamed text and tool activity on the node the stream names", async () => {
    const server = await remote({
      streams: [DISPATCH + textFrame("Visible progress") + progressFrame("tool-call")],
      holdStream: true,
    });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => s.some((item) => item.type === "text"), settled, "the chunk is on screen");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: RECORDED.toolName },
      { type: "text", node: "analysis", text: "Visible progress" },
    ]);
  });

  it("suppresses thinking on both the named and the batched path", async () => {
    const server = await remote({
      streams: [
        DISPATCH +
          THINKING_MULTILINE +
          progressFrame("thinking-delta", "hidden batched reasoning") +
          textFrame("Visible progress"),
      ],
      holdStream: true,
    });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => s.some((item) => item.type === "text"), settled, "the text chunk is on screen");
    server.releaseStream();
    await settled;

    expect(texts(snapshots)).toEqual(["Visible progress"]);
  });

  it("keeps one text line for a node whatever channels carried it", async () => {
    const frames =
      DISPATCH +
      textFrame("Visible progress") +
      progressFrame("relay-chunk", "Visible progress") +
      progressFrame("text-delta", "Visible progress") +
      progressFrame("full-turn", "Visible progress");
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => s.some((item) => item.type === "text"), settled, "the text is on screen");
    server.releaseStream();
    await settled;

    expect(texts(snapshots)).toEqual(["Visible progress"]);
  });

  it("accumulates chunks and replaces them with the node's full turn", async () => {
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH + textFrame("Reading the "));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    const watch = watcher();
    const settled = run.monitor(REMOTE_ID, watch.view);
    await vi.waitFor(() => expect(texts(watch.snapshots)).toEqual(["Reading the "]));

    push(textFrame("changed files "));
    await vi.waitFor(() => expect(texts(watch.snapshots)).toContain("Reading the changed files "));

    push(progressFrame("full-turn", "Reading the changed files and reporting three findings."));
    push(TERMINAL);
    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });

    expect(texts(watch.snapshots)).toEqual([
      "Reading the ",
      "Reading the changed files ",
      "Reading the changed files and reporting three findings.",
    ]);
  });

  it("rejoins an event whose data spans multiple lines", async () => {
    const server = await remote({
      streams: [
        DISPATCH +
          CHUNK_MULTILINE +
          THINKING_MULTILINE +
          'event: node_progress\ndata: {"node_id":"analysis","step":"tool_call",\ndata:  "detail":{"tool":"read","args":{"path":"src/index.ts"}}}\n\n',
      ],
    });
    const run = await client(server.url);

    const { snapshots, settled } = follow(run, server);
    const outcome = await settled;

    expect(outcome).toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: "read" },
      {
        type: "text",
        node: "analysis",
        text: "Inspecting the repository\n\nReporting three findings after a blank line",
      },
    ]);
  });

  it("reads a CRLF-framed stream split across chunk boundaries", async () => {
    const chunk = crlf(textFrame("Progress on the run"));
    const cut = chunk.lastIndexOf("\r");
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(crlf(DISPATCH));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    const watch = watcher();
    const settled = run.monitor(REMOTE_ID, watch.view);
    push(chunk.slice(0, cut));
    push(chunk.slice(cut) + crlf(TERMINAL));

    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(texts(watch.snapshots)).toContain("Progress on the run");
  });

  it("rebuilds the view for each connection instead of appending to the last one", async () => {
    const server = await remote({
      streams: [DISPATCH + textFrame("old-only text"), DISPATCH + textFrame("new-only text") + TERMINAL],
      states: [
        readState({ status: "running" }),
        // A journal entry this connection never delivered is not a second source.
        readState({
          result: DEFAULT_RESULT,
          events: [{ event: "node_retry", data: { node_id: "never-seen" } }],
        }),
      ],
    });
    const run = await client(server.url);

    const { snapshots, settled } = follow(run, server);
    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });

    expect(texts(snapshots)).toEqual(["old-only text", "new-only text"]);
    expect(JSON.stringify(snapshots)).not.toContain("never-seen");
    expect(streamRequests(server)).toHaveLength(2);
    expect(streamRequests(server).map((entry) => entry.lastEventId)).toEqual([undefined, undefined]);
  });
});

// ── monitor: GET is the only source of run state ─────────────────────────

describe("monitor reconcile", () => {
  it("takes its answer from GET rather than the terminal frame's copy", async () => {
    // The captured live connection ends with a terminal frame whose `result` is the retired
    // marker; GET answers the declared output.
    const server = await remote({
      streams: [DISPATCH + TERMINAL],
      reads: [recordedResponse("read-completed-declared")],
    });
    const run = await client(server.url);

    const outcome = (await run.monitor(server.run, watcher().view)) as { status: string; result: unknown };

    expect(outcome).toEqual({
      status: "completed",
      result: {
        text: "The declared output",
        usage: { input_tokens: 31, output_tokens: 7 },
        thinking: "private chain of thought",
        termination_reason: "final_answer",
      },
    });
    expect(readRequests(server)).toHaveLength(1);
  });

  it("settles once however often the terminal frame is delivered", async () => {
    const server = await remote({
      streams: [TERMINAL, TERMINAL],
      states: [readState({ status: "running" }), readState({ result: DEFAULT_RESULT })],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(server.run, watcher().view);

    expect(outcome).toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(streamRequests(server)).toHaveLength(2);
    expect(readRequests(server)).toHaveLength(2);
  });

  it("reads GET after the lifecycle silence window, whatever else arrived", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH);
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    // The window counts lifecycle events only: reaching it with pings and text in between is
    // what makes a ping or a chunk resetting it observable.
    const settled = run.monitor(REMOTE_ID, watcher().view);
    await vi.advanceTimersByTimeAsync(30_000);
    push(`${PING}${textFrame("first text chunk")}`);
    await vi.advanceTimersByTimeAsync(30_000);
    push(`${PING}${textFrame("second text chunk")}`);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(socket.reads()).toBe(1);
  });

  it("hands the wait back as unknown while the endpoint cannot be read, and keeps reading", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const socket = fakeWorkflowFetch({
      stream: (_push, close) => close(),
      read: () => jsonResponse(503, { error: "Temporarily unavailable" }),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);
    const abort = new AbortController();

    const waiting = run.monitor(REMOTE_ID, watcher(abort.signal).view);
    await vi.advanceTimersByTimeAsync(90_000);
    const degraded = await waiting;
    const readsAtReturn = socket.reads();

    expect(degraded).toEqual({ status: "degraded", error: expect.stringContaining("unknown") });
    expect(readsAtReturn).toBeGreaterThanOrEqual(2);

    const resumed = run.monitor(REMOTE_ID, watcher(abort.signal).view);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.reads()).toBeGreaterThan(readsAtReturn);

    abort.abort();
    await expect(resumed).resolves.toEqual({ status: "aborted" });
  });

  it("names the endpoint for a read it refuses, without the key", async () => {
    const key = "example-private-key";
    const server = await remote({ reads: [recordedResponse("read-unauthorized")] });
    const run = await client(server.url, key);

    const outcome = await run.monitor(server.run, watcher().view);

    expect(outcome).toEqual({ status: "error", error: expect.stringContaining("Unauthorized") });
    expect((outcome as { error: string }).error).toContain(server.url);
    expect((outcome as { error: string }).error).not.toContain(key);
  });

  it("takes a failed run's message from GET, never the frame's reason", async () => {
    // The captured journal ends in a `workflow_failed` frame whose text is `reason`, not `error`;
    // only what GET answers for `error` reaches the caller.
    const server = await remote({
      run: FAILED_RUN,
      streams: [REPLAY_FAILED_STREAM],
      states: [readState({ status: "failed", error: "Runner lost its lease" })],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(FAILED_RUN, watcher().view);

    expect(outcome).toEqual({ status: "failed", error: "Runner lost its lease" });
  });

  it("reports the failed run across every line of the reason the endpoint recorded", async () => {
    const server = await remote({
      run: FAILED_RUN,
      streams: [REPLAY_FAILED_STREAM],
      reads: [recordedResponse("read-failed")],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(FAILED_RUN, watcher().view);

    expect(outcome).toEqual({
      status: "failed",
      error: "node analysis failed: validator rejected the diff\nsecond line of the failure",
    });
  });

  it("reports the interrupted run GET describes, including the journal-less one", async () => {
    for (const name of ["read-interrupted", "read-known-no-log"] as const) {
      const server = await remote({ streams: [CONTROL_FRAMES], reads: [recordedResponse(name)] });
      const run = await client(server.url);

      const outcome = await run.monitor(server.run, watcher().view);

      expect(outcome).toEqual({ status: "interrupted", error: null });
    }
  });

  it("carries the caller's cancellation into the open connection", async () => {
    // A monitor that stops watching must not leave the endpoint streaming to a socket nobody reads.
    let connecting: AbortSignal | null | undefined;
    const socket = fakeWorkflowFetch({
      stream: () => {},
      read: () => jsonResponse(200, readState()),
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      connecting = init?.signal;
      return socket.fetch(input as string, init);
    });
    const run = await client(FAKED_URL);
    const abort = new AbortController();

    const settled = run.monitor(REMOTE_ID, watcher(abort.signal).view);
    await vi.waitFor(() => expect(connecting).toBeTruthy());
    abort.abort();

    await expect(settled).resolves.toEqual({ status: "aborted" });
    expect(connecting?.aborted).toBe(true);
  });

  it("stops watching and asks for nothing when the caller cancels", async () => {
    const server = await remote({ holdStream: true });
    const run = await client(server.url);
    const abort = new AbortController();

    const settled = run.monitor(server.run, watcher(abort.signal).view);
    await server.streamOpened;
    abort.abort();

    await expect(settled).resolves.toEqual({ status: "aborted" });
    expect(server.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(readRequests(server)).toEqual([]);
  });
});

// ── terminal result: GET's value, untouched ──────────────────────────────

describe("terminal result", () => {
  async function outcomeFor(result: unknown): Promise<WorkflowOutcome> {
    const server = await remote({ result });
    const run = await client(server.url);
    return run.monitor(server.run, watcher().view);
  }

  it("hands a completed run's result over untouched", async () => {
    const value = {
      text: "Visible answer",
      usage: { input_tokens: 341 },
      thinking: "private reasoning",
      termination_reason: "max_iterations",
    };

    const outcome = await outcomeFor(value);

    expect(outcome).toEqual({ status: "completed", result: value });
  });

  for (const value of [0, false, { nested: null, values: [1, false] }] as const) {
    it(`treats ${JSON.stringify(value)} as a delivered result`, async () => {
      expect(await outcomeFor(value)).toEqual({ status: "completed", result: value });
    });
  }

  it("reports an empty result slot as a completed run with no result", async () => {
    const server = await remote({
      run: COMPLETED_RUN,
      streams: [REPLAY_COMPLETED_STREAM],
      reads: [recordedResponse("read-completed-empty-result")],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(COMPLETED_RUN, watcher().view);

    expect(outcome).toEqual({ status: "completed", result: null });
  });

  it("refuses the retired marker and names the endpoint and what it failed to deliver", async () => {
    const server = await remote({
      run: COMPLETED_RUN,
      streams: [REPLAY_COMPLETED_STREAM],
      reads: [recordedResponse("read-completed-marker")],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(COMPLETED_RUN, watcher().view);

    expect(outcome.status).toBe("error");
    expect((outcome as { error: string }).error).toContain(server.url);
    expect((outcome as { error: string }).error).toMatch(/result|output/i);
    expect((outcome as { error: string }).error).not.toContain(RECORDED.nodeResult);
  });
});

// ── stop ────────────────────────────────────────────────────────────────

describe("stop", () => {
  it("reports the acknowledged kill and the read it came from", async () => {
    const server = await remote({ holdStream: true });
    const run = await client(server.url, "example-key");

    const stop = await run.stop(server.run);

    expect(stop).toEqual({ ok: true, status: "stopped" });
    const [request] = server.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/stop"));
    expect(request?.authorization).toBe("Bearer example-key");
  });

  for (const status of ["stopped", "already_finished", "interrupted"] as const) {
    it(`maps the ${status} acknowledgement to the caller`, async () => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
        String(input instanceof Request ? input.url : input).endsWith("/stop")
          ? jsonResponse(200, { status, workflow_id: REMOTE_ID })
          : jsonResponse(404, {}),
      );
      const run = await client(FAKED_URL);

      expect(await run.stop(REMOTE_ID)).toEqual({ ok: true, status });
    });
  }

  it("reports a stop the endpoint refused, with its reason", async () => {
    const server = await remote({ stopRejection: recordedResponse("stop-unknown") });
    const run = await client(server.url);

    const stop = await run.stop(server.run);

    expect(stop).toEqual({ ok: false, error: expect.stringContaining("Workflow not found") });
    expect((stop as { error: string }).error).toContain(server.url);
  });
});
