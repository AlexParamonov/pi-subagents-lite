/**
 * workflow-client.test.ts — The WorkflowClient: one endpoint's HTTP protocol.
 *
 * Everything enters at the client and leaves through a real loopback socket serving the recorded
 * bytes (`recorded/`, see `fixtures.ts`), so a pass means the request the endpoint documents
 * arrived and the bytes it answered became the caller's result. `recorded/PROVENANCE.md` names the
 * one body there that is contract-derived rather than captured. Only the timing tests replace the
 * socket, because they run on fake timers.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  beforeEnd,
  CHUNK_MULTILINE,
  CONTROL_FRAMES,
  COMPLETED_RUN,
  createRequests,
  crlf,
  declaredOutputRead,
  deferred,
  DEFAULT_RESULT,
  DISPATCH,
  endpoint,
  errorBody,
  FAILED_RUN,
  frameOf,
  framesOf,
  PING,
  FAKED_URL,
  fakeWorkflowFetch,
  jsonResponse,
  lifecycle,
  mintEndpoint,
  progressFrame,
  readRequests,
  readState,
  recorded,
  recordedRead,
  recordedResponse,
  RECORDED,
  RECONNECT,
  REMOTE_ID,
  REPLAY_COMPLETED_STREAM,
  REPLAY_FAILED_STREAM,
  stopRequests,
  streamRequests,
  TERMINAL,
  textFrame,
  THINKING_MULTILINE,
  type EndpointOptions,
  type TestEndpoint,
} from "./fixtures.js";
import type { WorkflowCreate, WorkflowOutcome, WorkflowView } from "../../src/workflows/workflow-client.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";

let servers: TestEndpoint[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function remote(options: EndpointOptions = {}): Promise<TestEndpoint> {
  const server = await endpoint(options);
  servers.push(server);
  return server;
}

async function client(url: string, apiKey?: string, fetchImpl?: typeof fetch) {
  const { createWorkflowClient } = await import("../../src/workflows/workflow-client.js");
  return createWorkflowClient(mintEndpoint(url, apiKey), fetchImpl ? { fetch: fetchImpl } : {});
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

function createBody(server: TestEndpoint): Record<string, unknown> {
  const [create] = createRequests(server);
  expect(create, "the endpoint must receive the create request").toBeDefined();
  return JSON.parse(create!.body) as Record<string, unknown>;
}

function error(run: WorkflowCreate): string {
  if (run.ok) throw new Error(`expected the create to fail, got ${JSON.stringify(run)}`);
  return run.error;
}

// Every route is the one validated base plus its own path: joining an absolute path against a base
// re-roots at the host, which would send an authenticated request where no config named it.
describe("request routes", () => {
  it("builds all four routes under the base's path prefix", async () => {
    const socket = fakeWorkflowFetch({
      stream: (_frame, close) => close(),
      read: () => jsonResponse(200, readState()),
    });
    const run = await client("http://release.invalid:4001/gateway/workflows-v1/", undefined, socket.fetch);

    await run.create(request());
    await expect(run.monitor(REMOTE_ID, watcher().view)).resolves.toEqual({ status: "completed", result: null });
    await run.stop(REMOTE_ID);

    const base = "http://release.invalid:4001/gateway/workflows-v1";
    expect(socket.requests().map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${base}/api/workflows`,
      `GET ${base}/api/workflows/${REMOTE_ID}/stream`,
      `GET ${base}/api/workflows/${REMOTE_ID}`,
      `POST ${base}/api/workflows/${REMOTE_ID}/stop`,
    ]);
  });
});

// A fault names the URL the run's own record carries - the display URL - never the request base:
// a base's path prefix can hold the effective credential, and once the parser percent-escaped it the
// redaction needle cannot match what it shows (US-35, US-21).
describe("the URL a fault names", () => {
  for (const [key, shown] of [
    ["example-private-key", "/[redacted]/v1"],
    ["k<7>", ""],
  ] as const) {
    it(`names ${JSON.stringify(shown)} for the prefix that carries ${JSON.stringify(key)}`, async () => {
      const server = await remote({ prefix: `/${encodeURIComponent(key)}/v1` });
      await server.close();

      const run = await (await client(`${server.url}/${key}/v1`, key)).create(request());

      expect(error(run)).toContain(`(${server.url}${shown})`);
      expect(error(run)).not.toContain(key);
      expect(error(run)).not.toContain(encodeURIComponent(key));
    });
  }
});

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

  it("refuses a successful create response that does not identify its run", async () => {
    const url = "http://workflow.example:4001";
    const transport: typeof fetch = async () => new Response("{}", { status: 201 });

    const run = await (await client(url, undefined, transport)).create(request());

    expect(error(run)).toContain(url);
    expect(error(run)).toContain("created a run it did not identify");
    expect(error(run)).toContain("the response carried no workflow id");
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

  it("caps reported server text, so a proxy's page cannot fill the row", async () => {
    const filler = "The upstream endpoint is unavailable. ";
    const server = await remote({ rejection: { status: 502, body: `<html>${filler.repeat(12)}TAIL</html>` } });

    const run = await (await client(server.url)).create(request());

    expect(error(run)).toContain(`HTTP 502: <html>${filler.repeat(7)}`);
    expect(error(run)).not.toContain("TAIL");
    expect(error(run).endsWith("\u2026")).toBe(true);
  });

  it("keeps a key the reported text would cut in half from surviving as a fragment", async () => {
    const key = "example-private-key";
    const server = await remote({ rejection: { status: 502, body: errorBody(`${"x".repeat(290)}${key}`) } });

    const run = await (await client(server.url, key)).create(request());

    expect(error(run)).toContain("[redacted]");
    expect(error(run)).not.toContain("example-pr");
  });

  it("reports server text of exactly the cap whole, with no ellipsis", async () => {
    const page = `<html>${"x".repeat(294)}`;
    const server = await remote({ rejection: { status: 502, body: page } });

    const run = await (await client(server.url)).create(request());

    expect(error(run)).toContain(page);
    expect(error(run)).not.toContain("\u2026");
  });

  it("keeps the transport's own words publish-safe when nothing answers", async () => {
    // What the transport echoes about the exchange crosses the same rule as what the endpoint says:
    // a header it names must not carry the credential, and no escape sequence reaches the row.
    const key = "example-private-key";
    const transport = (async () => {
      throw new Error(`fetch failed with header "authorization: Bearer ${key}"\u001B[31m`);
    }) as unknown as typeof fetch;

    const run = await (await client(FAKED_URL, key, transport)).create(request());

    expect(error(run)).toContain('authorization: Bearer [redacted]"');
    expect(error(run)).not.toContain(key);
    expect(error(run)).not.toContain("\u001B");
  });

  it("reports a create whose response never arrived as an unknown outcome, sent once", async () => {
    const server = await remote({ loseCreateResponse: true });

    const run = await (await client(server.url)).create(request());

    expect(error(run)).toContain(server.url);
    expect(error(run)).toMatch(/unknown outcome/i);
    expect(error(run)).toMatch(/may still be running/i);
    expect(createRequests(server)).toHaveLength(1);
  });

  it("names the endpoint, its URL and every configured key when nothing answers", async () => {
    const server = await remote();
    await server.close();
    const { createWorkflowClient } = await import("../../src/workflows/workflow-client.js");

    const run = await createWorkflowClient(mintEndpoint(server.url), {
      endpointNames: ["local", "release"],
    }).create(request());

    expect(error(run)).toContain(server.url);
    expect(error(run)).toContain("local");
    expect(error(run)).toMatch(/configured endpoints/i);
    expect(error(run)).toContain("release");
  });

  it("leaves a rejection the server's own words, without the key list", async () => {
    const server = await remote({ rejection: { status: 422, body: errorBody("Remote validation failed") } });
    const { createWorkflowClient } = await import("../../src/workflows/workflow-client.js");

    const run = await createWorkflowClient(mintEndpoint(server.url), {
      endpointNames: ["local", "release"],
    }).create(request());

    expect(error(run)).toContain("Remote validation failed");
    expect(error(run)).not.toMatch(/configured endpoints/i);
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

    const run = await createWorkflowClient(mintEndpoint(server.url), {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ workflow_id: COMPLETED_RUN, task_id: COMPLETED_RUN }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    }).create(request());

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

function texts(snapshots: WorkflowDisplayItem[][]): string[] {
  return snapshots.flatMap((snapshot) => snapshot.flatMap((item) => (item.type === "text" ? [item.text] : [])));
}

/** The streamed-text lines one snapshot shows, in the order it lists them. */
function textLines(snapshot: readonly WorkflowDisplayItem[]): string[] {
  return snapshot.flatMap((item) => (item.type === "text" ? [item.text] : []));
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

  it("shows the turn that follows a node's tool turn", async () => {
    // `SessionExecutor` closes a tool-invoking turn with one `assistant_turn` frame carrying its
    // text, and the turn after it streams on the same node: the boundary ends one turn's text.
    const secondTurn = "Three findings, one of them the parser";
    const frames =
      DISPATCH +
      textFrame(RECORDED.internalText) +
      progressFrame("assistant-turn") +
      progressFrame("tool-call") +
      progressFrame("text-delta", secondTurn);
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => textLines(s).length === 2, settled, "both turns of the node are on screen");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: RECORDED.toolName },
      { type: "text", node: "analysis", text: RECORDED.internalText },
      { type: "text", node: "analysis", text: secondTurn },
    ]);
  });

  it("shows text that arrives after a turn's full text", async () => {
    const frames =
      DISPATCH + progressFrame("full-turn", "Reading the diff") + textFrame("The repository has three findings.");
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => textLines(s).length === 2, settled, "the text after the full turn is on screen");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Reading the diff" },
      { type: "text", node: "analysis", text: "The repository has three findings." },
    ]);
  });

  it("replaces only the turn a full-turn frame closes", async () => {
    const closedTurn = "Reading the changed files, then three findings.";
    const nextTurn = "Writing the report.";
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH + textFrame("Reading the diff "));
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    const watch = watcher();
    const settled = run.monitor(REMOTE_ID, watch.view);
    await vi.waitFor(() => expect(textLines(watch.snapshots.at(-1)!)).toEqual(["Reading the diff "]));

    push(textFrame("then the tests "));
    await vi.waitFor(() => expect(texts(watch.snapshots)).toContain("Reading the diff then the tests "));

    push(progressFrame("assistant-turn", closedTurn));
    push(progressFrame("text-delta", nextTurn));
    push(TERMINAL);
    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });

    // The boundary rewrote the turn its chunks belonged to, and left the turn after it its own text.
    expect(textLines(watch.snapshots.at(-1)!)).toEqual([closedTurn, nextTurn]);
  });

  it("shows both turns when a buffered run delivers the same text twice", async () => {
    // A buffered run emits no chunks at all (`SessionExecutor`'s doc: "a buffered run emits no chunk
    // events and stays silent"), so its turns arrive as consecutive full-turn frames, and two turns
    // can say the same thing. The producer's per-turn order: llm_completed, assistant_turn, tool_call,
    // tool_result.
    const turn = "Checking the parser";
    const frames =
      DISPATCH +
      progressFrame("spend") +
      progressFrame("assistant-turn", turn) +
      progressFrame("tool-call") +
      progressFrame("tool-result") +
      progressFrame("spend") +
      progressFrame("assistant-turn", turn);
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => textLines(s).length === 2, settled, "both delivered turns are on screen");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: RECORDED.toolName },
      { type: "text", node: "analysis", text: turn },
      { type: "text", node: "analysis", text: turn },
    ]);
  });

  it("counts the turn a full-turn frame delivers even with nothing delivered between", async () => {
    // What closes a turn is the boundary frame itself, not the activity around it: a tool turn's
    // `assistant_turn` and the final turn's `llm_response` can arrive back to back on a buffered run.
    const turn = "Checking the parser";
    const frames =
      DISPATCH +
      progressFrame("spend") +
      progressFrame("assistant-turn", turn) +
      progressFrame("spend") +
      progressFrame("full-turn", turn);
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => textLines(s).length === 2, settled, "the back-to-back turns are both on screen");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: turn },
      { type: "text", node: "analysis", text: turn },
    ]);
  });

  it("shows nothing new for a full turn that only repeats the turn's chunks", async () => {
    const turn = "Reading the diff, then three findings.";
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    const watch = watcher();
    const settled = run.monitor(REMOTE_ID, watch.view);
    push(DISPATCH + textFrame(turn));
    await vi.waitFor(() => expect(textLines(watch.snapshots.at(-1)!)).toEqual([turn]));

    // The boundary frame carries the text this turn's chunks already delivered: it replaces that
    // turn's contribution, so it is neither a new line nor the same line twice.
    push(progressFrame("full-turn", turn));
    push(progressFrame("tool-call"));
    await vi.waitFor(() =>
      expect(
        watch.snapshots.at(-1)!.some((item) => item.type === "activity"),
        "the tool line arrived",
      ).toBe(true),
    );
    expect(watch.snapshots).toHaveLength(2);

    push(lifecycle("node_complete", "analysis"));
    await vi.waitFor(() =>
      expect(
        watch.snapshots.at(-1)!.some((item) => item.type === "node-status" && item.status === "completed"),
        "the completion arrived",
      ).toBe(true),
    );
    expect(watch.snapshots).toHaveLength(3);

    push(TERMINAL);
    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(textLines(watch.snapshots.at(-1)!)).toEqual([turn]);
  });

  it("starts a node's text over when the endpoint dispatches it again", async () => {
    // A second dispatch is a new attempt: what the previous one streamed is not this attempt's
    // prefix, and the two attempts' chunks must not fuse into one turn.
    const frames = DISPATCH + textFrame("Reading the ") + DISPATCH + textFrame("Reading the release notes ");
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until((s) => textLines(s).includes("Reading the release notes "), settled, "the new attempt streams");
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Reading the release notes " },
    ]);
  });

  it("keeps each node's turns with the node the frame names", async () => {
    const secondTurn = "Three findings stand";
    const frames =
      DISPATCH +
      textFrame("Reading the diff") +
      progressFrame("assistant-turn") +
      lifecycle("node_dispatched", "report") +
      textFrame("Drafting the summary") +
      progressFrame("text-delta", secondTurn, "analysis");
    const server = await remote({ streams: [frames], holdStream: true });
    const run = await client(server.url);

    const { snapshots, settled, until } = follow(run, server);
    await until(
      (s) => textLines(s).includes(secondTurn) && textLines(s).includes("Drafting the summary"),
      settled,
      "each node shows its own turns",
    );
    server.releaseStream();
    await settled;

    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: RECORDED.internalText },
      { type: "text", node: "analysis", text: secondTurn },
      { type: "node-status", node: "report", status: "dispatched" },
      { type: "text", node: "report", text: "Drafting the summary" },
    ]);
  });

  it("reads the captured progress frames as the turns the producer emitted", async () => {
    // The captured steps in the recorder's own order (recorded/PROVENANCE.md): the batched delta the
    // spend step follows, the `assistant_turn` that closes that turn, the tool steps, then the next
    // turn's chunk and its full text. Thinking, spend and steering steps show nothing.
    const server = await remote({ streams: [recorded("node-progress-frames.sse")] });
    const run = await client(server.url);

    const { snapshots, settled } = follow(run, server);
    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });

    expect(snapshots.at(-1)).toEqual([
      { type: "activity", node: "analysis", activity: RECORDED.toolName },
      { type: "text", node: "analysis", text: RECORDED.internalText },
      { type: "text", node: "analysis", text: RECORDED.fullTurnText },
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
    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "new-only text" },
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("never-seen");
    expect(streamRequests(server)).toHaveLength(2);
    expect(streamRequests(server).map((entry) => entry.lastEventId)).toEqual([undefined, undefined]);
  });
});

// ── monitor: GET is the only source of run state ─────────────────────────

describe("monitor reconcile", () => {
  it("takes its answer from GET rather than the terminal frame's copy", async () => {
    // The captured live connection ends with a terminal frame whose `result` is the retired marker;
    // the GET answer is the ratified declared-output shape, which no server delivers yet.
    const server = await remote({
      streams: [DISPATCH + TERMINAL],
      reads: [declaredOutputRead()],
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

  it("settles once and shows one status line per node however often the frames are delivered", async () => {
    // One journal, delivered twice: the terminal frame arrives live on the first connection, GET
    // answers `running`, and the next connection replays the whole journal, terminal included.
    const journal = DISPATCH + textFrame("Visible progress") + TERMINAL;
    const server = await remote({
      streams: [journal, journal],
      states: [readState({ status: "running" }), readState({ result: DEFAULT_RESULT })],
    });
    const run = await client(server.url);

    const { snapshots, settled } = follow(run, server);

    await expect(settled).resolves.toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(streamRequests(server)).toHaveLength(2);
    expect(readRequests(server)).toHaveLength(2);
    // A replayed frame rebuilds the lines of its own connection; none of them is a second one.
    for (const snapshot of snapshots) {
      expect(snapshot.filter((item) => item.type === "node-status")).toEqual([
        { type: "node-status", node: "analysis", status: "dispatched" },
      ]);
    }
    expect(snapshots.at(-1)).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Visible progress" },
    ]);
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

  it("reads GET when the endpoint ages the connection out", async () => {
    // No close and no further frames: the connection stays open, so only the `reconnect` frame
    // itself can send the client to GET - neither EOF nor the silence window is in play.
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
    const w = watcher();

    const settled = run.monitor(REMOTE_ID, w.view);
    await vi.waitFor(() => expect(w.snapshots.length).toBeGreaterThan(0));
    expect(socket.reads()).toBe(0);

    push(RECONNECT);

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

  it("hands a refused read back as an unknown state, naming the endpoint and never the key", async () => {
    // A refused read carries no run status, so it is an observation failure like a 5xx: it ends the
    // wait as unknown rather than settling anything (ADR-0013).
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const key = "example-private-key";
    const socket = fakeWorkflowFetch({
      stream: (_push, close) => close(),
      read: () => recordedRead("read-unauthorized"),
    });
    const run = await client(FAKED_URL, key, socket.fetch);

    const waiting = run.monitor(REMOTE_ID, watcher().view);
    await vi.advanceTimersByTimeAsync(90_000);
    const outcome = await waiting;

    expect(outcome).toEqual({ status: "degraded", error: expect.stringContaining("Unauthorized") });
    expect((outcome as { error: string }).error).toContain(FAKED_URL);
    expect((outcome as { error: string }).error).not.toContain(key);
  });

  it("takes a failed run's message from GET, never the frame's reason", async () => {
    // The captured journal ends in a `workflow_failed` frame whose text is `reason`, not `error`;
    // only what GET answers for `error` reaches the caller. This endpoint closes the connection as
    // soon as it has answered, so the read below may come from that close: the frame as a trigger
    // is the test after this one.
    const server = await remote({
      run: FAILED_RUN,
      streams: [REPLAY_FAILED_STREAM],
      states: [readState({ status: "failed", error: "Runner lost its lease" })],
    });
    const run = await client(server.url);

    const outcome = await run.monitor(FAILED_RUN, watcher().view);

    expect(outcome).toEqual({ status: "failed", error: "Runner lost its lease" });
  });

  it("reads GET on the workflow_failed frame while the connection is still open", async () => {
    // This fake never closes the connection, so EOF never happens: the frame itself is what sends
    // the client to GET. The captured frame carries `reason`; the answer is a string no captured
    // frame carries, so the outcome also says which field was used.
    const failed = frameOf(REPLAY_FAILED_STREAM, "workflow_failed");
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      run: FAILED_RUN,
      stream: (send) => {
        push = send;
        send(
          framesOf(REPLAY_FAILED_STREAM)
            .filter((frame) => frame !== failed)
            .join(""),
        );
      },
      read: () => jsonResponse(200, readState({ status: "failed", error: "Runner lost its lease" })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);
    const w = watcher();

    const settled = run.monitor(FAILED_RUN, w.view);
    await vi.waitFor(() => expect(w.snapshots.length).toBeGreaterThan(0));
    expect(socket.reads()).toBe(0);

    push(failed);

    await vi.waitFor(() => expect(socket.reads()).toBe(1));
    await expect(settled).resolves.toEqual({ status: "failed", error: "Runner lost its lease" });
    expect(socket.reads()).toBe(1);
  });

  it("keeps an echoed key out of the failure reason GET carries", async () => {
    // GET's own `error` is server text too: the run settled remotely, and what it said must not
    // reach the caller carrying the credential the endpoint authenticates with (US-35).
    const key = "example-private-key";
    const server = await remote({
      run: FAILED_RUN,
      streams: [CONTROL_FRAMES],
      states: [readState({ status: "failed", error: `Node died holding ${key}` })],
    });
    const run = await client(server.url, key);

    const outcome = await run.monitor(FAILED_RUN, watcher().view);

    expect(outcome).toEqual({ status: "failed", error: "Node died holding [redacted]" });
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

  it("closes the connection the endpoint is still pushing to when the caller cancels", async () => {
    // Only the server can see this: a client that stops reading may keep the socket open, and the
    // endpoint goes on streaming a run nobody is watching.
    const server = await remote({ streams: [DISPATCH], holdStream: true });
    const run = await client(server.url);
    const abort = new AbortController();
    const w = watcher(abort.signal);

    const settled = run.monitor(server.run, w.view);
    await server.streamOpened;
    await w.until(() => w.snapshots.length > 0, settled, "the dispatch reaches the display");
    expect(server.streamSocketsOpen()).toBe(1);

    abort.abort();

    await expect(settled).resolves.toEqual({ status: "aborted" });
    // Event-driven, not polled: the endpoint's own close notification is the witness.
    await server.streamSocketClosed();
  });

  it("aborts a connection it replaces, and the one it settles on", async () => {
    const connecting: AbortSignal[] = [];
    const socket = fakeWorkflowFetch({
      // Never closed: every connection the endpoint is given stays open on its side.
      stream: (send) => {
        send(DISPATCH + TERMINAL);
      },
      read: (reads) => jsonResponse(200, readState(reads === 1 ? { status: "running" } : { result: DEFAULT_RESULT })),
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/stream") && init?.signal) connecting.push(init.signal);
      return socket.fetch(input as string, init);
    });
    const run = await client(FAKED_URL);

    await expect(run.monitor(REMOTE_ID, watcher().view)).resolves.toEqual({
      status: "completed",
      result: DEFAULT_RESULT,
    });

    expect(connecting).toHaveLength(2);
    expect(connecting.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  it("publishes nothing to a caller that already has its outcome", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    let push: (frame: string) => void = () => {
      throw new Error("the stream did not open");
    };
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        send(DISPATCH);
      },
      read: () => jsonResponse(200, readState()),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);
    const abort = new AbortController();
    const w = watcher(abort.signal);

    const settled = run.monitor(REMOTE_ID, w.view);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.snapshots.length).toBeGreaterThan(0);

    abort.abort();
    await expect(settled).resolves.toEqual({ status: "aborted" });

    // The endpoint has not noticed the cancel yet, and keeps pushing.
    push(textFrame("text that arrives after the caller cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.snapshots).toHaveLength(1);
  });

  it("sends no Last-Event-Id on any request it makes", async () => {
    // Every connection replays the whole journal: an id from a live connection is not a journal
    // position, so resuming would re-deliver seen frames and skip missed ones (ADR-0013).
    const server = await remote({ holdStream: true });
    const run = await client(server.url);

    await run.create(request());
    const watching = run.monitor(server.run, watcher().view);
    await server.streamOpened;
    await run.stop(server.run);
    await watching;

    expect(new Set(server.requests.map((entry) => entry.path))).toEqual(
      new Set([
        "/api/workflows",
        `/api/workflows/${server.run}/stream`,
        `/api/workflows/${server.run}`,
        `/api/workflows/${server.run}/stop`,
      ]),
    );
    expect(server.requests.map((entry) => entry.lastEventId)).toEqual(server.requests.map(() => undefined));
  });

  it("keeps following the run when the display wiring dies, and says so once", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = fakeWorkflowFetch({
      stream: (send) => {
        send(DISPATCH);
        send(RECONNECT);
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    const run = await client(FAKED_URL, undefined, socket.fetch);

    const outcome = await run.monitor(REMOTE_ID, {
      onUpdate: () => {
        throw new Error("the renderer died");
      },
    });

    expect(outcome).toEqual({ status: "completed", result: DEFAULT_RESULT });
    expect(warnings.mock.calls).toHaveLength(1);
    expect(warnings.mock.calls.flat().join(" ")).toContain('"local"');
    warnings.mockRestore();
  });

  it("does not read a stream whose caller cancelled while it was opening", async () => {
    const opening = deferred<void>();
    const connecting: AbortSignal[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/stream")) return jsonResponse(404, { error: "Workflow not found" });
      if (init?.signal) connecting.push(init.signal);
      await opening.promise;
      return new Response(lifecycle("workflow_started", "analysis"), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const abort = new AbortController();
    const w = watcher(abort.signal);

    const settled = (await client(FAKED_URL)).monitor(REMOTE_ID, w.view);
    await vi.waitFor(() => expect(connecting).toHaveLength(1));
    abort.abort();
    opening.resolve();

    await expect(settled).resolves.toEqual({ status: "aborted" });
    expect(w.snapshots).toEqual([]);
    expect(connecting[0]?.aborted).toBe(true);
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

  // `status` is a key a producer node may legitimately store: only the bare single-key marker is
  // the retired completion marker, so a declared output carrying it must still be delivered.
  for (const value of [
    0,
    false,
    { nested: null, values: [1, false] },
    { status: "completed", text: "Declared output" },
  ] as const) {
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
    const [request] = stopRequests(server);
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
