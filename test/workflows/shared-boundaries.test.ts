/**
 * shared-boundaries.test.ts — Wave 1R acceptance: the seams every Workflow run shares.
 *
 * One validated request base (every route under it, every unusable base refused before any
 * request), one effective credential (the Bearer bytes and the redaction needle are one value, on
 * every published surface), stream event admission before any state change, and a monitor and stop
 * arbiter owned by the session claim rather than the tool call. Every test enters at a
 * caller-visible seam — the registered `Workflow` tool, the `/agents` command's real menu
 * components, or a session listener — against the real loopback endpoint (or `fakeWorkflowFetch`
 * where a fake clock must own time), so a pass means the request reached the endpoint and the
 * endpoint's answer reached the surfaces a user reads. Nothing from `src/` is imported or mocked.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createMockExtensionAPI,
  fakeCtx,
  loadExtension,
  type MockExtensionAPI,
  type RegisteredTool,
} from "../fixtures.js";
import { asCommandContext, asUiCustom } from "../pi-boundaries.js";
import { defaultTheme, defaultUi } from "../mock-utils.js";
import {
  beforeEnd,
  createRequests,
  declaredOutputRead,
  DEFAULT_RESULT,
  DEFAULT_STREAM,
  deferred,
  DISPATCH,
  endpoint,
  FAKED_URL,
  fakeWorkflowFetch,
  jsonResponse,
  lifecycle,
  readRequests,
  readState,
  recordedResponse,
  REMOTE_ID,
  RECONNECT,
  stopAck,
  stopRequests,
  streamRequests,
  textFrame,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";

let ws: Workspace;
let api: MockExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;
let endpoints: TestEndpoint[];

type WorkflowResult = AgentToolResult<Record<string, unknown>>;
type WorkflowUpdate = AgentToolUpdateCallback<Record<string, unknown>>;

interface ExecutableTool extends RegisteredTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: WorkflowUpdate | undefined,
    context: ExtensionContext,
  ): Promise<WorkflowResult>;
}

beforeEach(() => {
  ws = workspace();
  endpoints = [];
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
    getAgentDir: () => ws.agentDir,
  }));
});

afterEach(async () => {
  const shutdown = api?.listeners.find((listener) => listener.event === "session_shutdown");
  if (shutdown && ctx) await shutdown.handler({ type: "session_shutdown", reason: "quit" }, ctx);
  for (const server of endpoints) await server.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  api = undefined;
  ctx = undefined;
  vi.restoreAllMocks();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  rmSync(ws.root, { recursive: true, force: true });
});

async function start(trusted = true, warnings?: string[]): Promise<MockExtensionAPI> {
  api = createMockExtensionAPI();
  if (warnings) {
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  }
  ctx = fakeCtx({
    cwd: ws.project,
    isProjectTrusted: () => trusted,
    ...(warnings && {
      ui: {
        ...defaultUi,
        notify: (message, type) => {
          if (type === "warning") warnings.push(message);
        },
      },
    }),
  });
  await loadExtension(api.api);
  const startListener = api.listeners.find((listener) => listener.event === "session_start");
  expect(startListener, "the extension must handle session start").toBeDefined();
  await startListener!.handler({ type: "session_start", reason: "startup" }, ctx);
  return api;
}

function executable(capture: MockExtensionAPI, name = "Workflow"): ExecutableTool {
  const tool = capture.tools.filter((candidate) => candidate.name === name).at(-1) as ExecutableTool | undefined;
  expect(tool, `the ${name} tool must be registered`).toBeDefined();
  expect(tool?.execute, `the ${name} tool must be executable`).toBeTypeOf("function");
  return tool!;
}

async function server(options?: EndpointOptions): Promise<TestEndpoint> {
  const instance = await endpoint(options);
  endpoints.push(instance);
  return instance;
}

function text(result: WorkflowResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function run(
  tool: ExecutableTool,
  params: Record<string, unknown> = { workflow: "audit", prompt: "Review changes" },
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdate,
): Promise<WorkflowResult> {
  return tool.execute("workflow-call", params, signal, onUpdate, ctx!);
}

async function outcome(
  tool: ExecutableTool,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdate,
) {
  try {
    const result = await run(tool, params, signal, onUpdate);
    return { text: text(result), isError: result.isError ?? false };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { text: error.message, isError: true };
  }
}

/** Advance the fake clock in steps: each step yields, so the loop's own stream and read promises settle between timers. */
async function pump(steps: number, msEach: number): Promise<void> {
  for (let index = 0; index < steps; index += 1) await vi.advanceTimersByTimeAsync(msEach);
}

/** The config that sends every run to one named endpoint, with the key exactly as configured. */
function writeConfig(url: string, apiKey?: string): void {
  write(
    join(ws.agentDir, "subagents-lite.json"),
    JSON.stringify({
      workflows: {
        endpoints: { local: { url, ...(apiKey !== undefined ? { apiKey } : {}) } },
        defaultEndpoint: "local",
      },
    }),
  );
}

/** The default workflow file on disk, plus the config that sends a run to this exact base (and key). */
function install(url: string, apiKey?: string): void {
  write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
  writeConfig(url, apiKey);
}

function createRequest(remote: TestEndpoint) {
  const [request] = createRequests(remote);
  expect(request, "the endpoint must receive the selected workflow").toBeDefined();
  return request!;
}

/** Run the extension's session shutdown against the current context. */
async function shutdownSession(capture: MockExtensionAPI): Promise<void> {
  const shutdown = capture.listeners.find((listener) => listener.event === "session_shutdown");
  expect(shutdown, "the extension must handle session shutdown").toBeDefined();
  await shutdown!.handler({ type: "session_shutdown", reason: "quit" }, ctx);
  ctx = undefined;
}

/** Every line the extension writes to the console while the test runs. */
function captureConsole(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  for (const level of ["log", "info", "debug", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(record);
  }
  return lines;
}

/** A menu component as the tests drive it: real pi-tui components, rendered to text. */
interface MenuComponent {
  render(width: number): unknown;
  handleInput?(data: string): void;
}

/**
 * Open the `/agents` command's running-agents list through the real menu components. `ui.custom`
 * is captured, so navigation is real key input on real components: Enter on the main menu opens
 * Running agents (its first entry).
 */
async function openRunningAgents(capture: MockExtensionAPI): Promise<MenuComponent> {
  const command = capture.commands.find((entry) => entry.name === "agents");
  expect(command, "the extension must register the agents menu command").toBeDefined();
  const menus: MenuComponent[] = [];
  const menuCtx = fakeCtx({
    cwd: ws.project,
    ui: {
      ...defaultUi,
      custom: asUiCustom(
        async (factory: unknown) =>
          new Promise<undefined>((resolve) => {
            const build = factory as (
              tui: unknown,
              theme: unknown,
              kb: unknown,
              done: (value: undefined) => void,
            ) => unknown;
            menus.push(build({ terminal: { rows: 24 } }, defaultTheme, {}, resolve) as MenuComponent);
          }),
      ),
    },
  });
  const open = command!.handler("", asCommandContext(menuCtx));
  void open.catch(() => {});

  await vi.waitFor(() => expect(menus, "the agents command must open its main menu").toHaveLength(1));
  menus[0].handleInput?.("\r");
  await vi.waitFor(() =>
    expect(menus, "the main menu's first entry must open the running-agents list").toHaveLength(2),
  );
  expect(rendered(menus[1])).toContain("Running Agents");
  return menus[1];
}

/** The component's rows, without the trailing padding pi-tui pads every rendered line out to. */
function renderedRows(component: unknown): string[] {
  if (typeof component !== "object" || component === null || !("render" in component)) return [];
  if (typeof component.render !== "function") return [];
  const lines: unknown = component.render(240);
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === "string").map((line) => line.trimEnd())
    : [];
}

function rendered(component: unknown): string {
  return renderedRows(component).join("\n");
}

/**
 * The live view of a run, painted the way the tool call paints it. Every snapshot of one run shares
 * `args` and one render state, and the same state serves a later repaint: the row's invalidation
 * re-renders through it, which is how progress observed after the call returned gets checked.
 */
function liveViews(tool: ExecutableTool, args: Record<string, unknown>) {
  const views: string[] = [];
  const state: Record<string, unknown> = {};
  return {
    views,
    state,
    paint(update: WorkflowResult): string {
      const view = resultView(tool, update, args, { state });
      views.push(view);
      return view;
    },
  };
}

function resultView(
  tool: ExecutableTool,
  result: WorkflowResult,
  args: Record<string, unknown>,
  { state = {} }: { state?: Record<string, unknown> } = {},
): string {
  const options = { expanded: true, isPartial: true };
  const context = {
    args,
    toolCallId: "workflow-call",
    state,
    invalidate: () => {},
    cwd: ws.project,
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: true,
    showImages: false,
    isError: false,
  };
  return rendered(tool.renderResult?.(result, options, defaultTheme, context));
}

/** Wait for a rendered snapshot satisfying `seen`, and return it; fails by name if the run ends first. */
async function viewMatching(
  views: string[],
  seen: (view: string) => boolean,
  what: string,
  ended: Promise<unknown>,
): Promise<string> {
  if (!views.some(seen)) {
    try {
      await beforeEnd(
        vi.waitFor(() => expect(views.some(seen), `no view matched: ${what}`).toBe(true), { interval: 1 }),
        ended,
        `a view where ${what}`,
      );
    } catch (error) {
      // The run can end in the same tick the view was recorded, and the recorded views are
      // history: only a view that never rendered is a failure.
      if (!views.some(seen)) throw error;
    }
  }
  return views.find(seen)!;
}

/** A named event the server never declared: an `Object.prototype` member whose data names a node. */
function prototypeFrame(name: string): string {
  return `event: ${name}\ndata: {"node_id":"rogue","marker":"${name}"}\n\n`;
}

/** The run id AgentStatus prints — the handle the main agent passes to StopAgent. */
function listedRunId(status: WorkflowResult): string {
  const id = text(status).match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "AgentStatus must list the workflow run by id").toBeDefined();
  return id!;
}

describe("workflow request base", () => {
  it("routes every request under the endpoint's path prefix", async () => {
    // The reconnect frame ends the first connection by the server's own rules; the running read
    // reopens the stream. A trailing slash on the configured base is normalized away, never the prefix.
    const remote = await server({
      prefix: "/graph",
      holdStream: true,
      streams: [DISPATCH + RECONNECT, DISPATCH],
      reads: [recordedResponse("read-running")],
    });
    install(`${remote.url}/graph/`);
    const capture = await start();
    const abort = new AbortController();
    const pending = outcome(executable(capture), undefined, abort.signal);
    await beforeEnd(remote.streamOpened, pending, "the first stream connection");
    await vi.waitFor(() => expect(streamRequests(remote)).toHaveLength(2), { timeout: 3_000 });

    abort.abort();
    await remote.stopReceived;
    const result = await pending;

    expect(result.text).toMatch(/stopp|abort|interrupt|cancel/i);
    // All four routes, in the order the run used them, each under the prefix: a join that re-roots
    // at the host (`new URL(absolutePath, base)`) drops the prefix and fails here.
    expect(remote.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${remote.prefix}/api/workflows`,
      `GET ${remote.prefix}/api/workflows/${REMOTE_ID}/stream`,
      `GET ${remote.prefix}/api/workflows/${REMOTE_ID}`,
      `GET ${remote.prefix}/api/workflows/${REMOTE_ID}/stream`,
      `POST ${remote.prefix}/api/workflows/${REMOTE_ID}/stop`,
    ]);
  });

  it("still routes when the path prefix carries an at-sign", async () => {
    const remote = await server({ prefix: "/te@st" });
    install(`${remote.url}/te@st`);

    const result = await run(executable(await start()));

    expect(text(result)).toContain("The declared output");
    expect(remote.requests.map((request) => request.path)).toEqual([
      `/te@st/api/workflows`,
      `/te@st/api/workflows/${REMOTE_ID}/stream`,
      `/te@st/api/workflows/${REMOTE_ID}`,
    ]);
  });
});

describe("workflow request base refusals", () => {
  // Each unusable base is built against a live loopback socket, so a base that slips through
  // resolution sends a real request and the zero-request assertion catches it. The parser-side
  // traps are the point: a trailing `?` or `#` hides from the `.search`/`.hash` getters, and the
  // userinfo family is stripped by the URL parser itself (measured: `http://@h/p`, `http:/@h/p`,
  // `http:///@h/p` and the TAB/CR/LF forms all parse to a clean base), so a post-parse check
  // cannot see them either.
  const unusable: ReadonlyArray<{ what: string; build: (origin: string) => string; problem: RegExp }> = [
    { what: "a bare query delimiter", build: (origin) => `${origin}/graph?`, problem: /query/i },
    { what: "a bare fragment delimiter", build: (origin) => `${origin}/graph#`, problem: /fragment/i },
    {
      what: "a non-http scheme",
      build: (origin) => `ftp://${origin.slice("http://".length)}/graph`,
      problem: /scheme|protocol/i,
    },
    {
      what: "embedded credentials",
      build: (origin) => `http://user:pass@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "an empty userinfo marker",
      build: (origin) => `http://@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "a single-slash authority carrying an at-sign",
      build: (origin) => `http:/@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "a triple-slash authority carrying an at-sign",
      build: (origin) => `http:///@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "a tab before the authority",
      build: (origin) => `http://\t/@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "a carriage return before the authority",
      build: (origin) => `http://\r/@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
    {
      what: "a line feed before the authority",
      build: (origin) => `http://\n/@${origin.slice("http://".length)}/graph`,
      problem: /credential|userinfo|embedded/i,
    },
  ];

  for (const { what, build, problem } of unusable) {
    it(`refuses a base carrying ${what}, quoting no URL value`, async () => {
      const remote = await server();
      write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
      writeConfig(build(remote.url));
      const logs = captureConsole();

      const result = await outcome(executable(await start()));

      expect(result.isError).toBe(true);
      // The refusal names the endpoint and its url setting, and states the problem.
      expect(result.text).toContain('"local"');
      expect(result.text).toMatch(/url/i);
      expect(result.text).toMatch(problem);
      // A refusal is a published surface and the resolver has no redaction: no URL value is
      // quoted at all — neither host, path, nor the credentials a userinfo base carried.
      expect(result.text).not.toContain(remote.url.slice("http://".length));
      expect(result.text).not.toContain("/graph");
      expect(result.text).not.toContain("user:pass");
      expect(logs.join("\n")).not.toContain("user:pass");
      expect(remote.requests).toEqual([]);
    });
  }
});

describe("workflow credential", () => {
  it("authenticates with the space-padded key's trimmed value and redacts it wherever it is echoed", async () => {
    await runPaddedKeyCase(" ");
  });

  it("authenticates with the tab-padded key's trimmed value and redacts it wherever it is echoed", async () => {
    await runPaddedKeyCase("\t");
  });

  it("shows the key redacted on the run's display copy when the path prefix embeds it", async () => {
    const key = "example-key";
    const remote = await server({ prefix: `/${key}/v1`, holdStream: true });
    install(`${remote.url}/${key}/v1`, key);
    const logs = captureConsole();
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    const rows = rendered(await openRunningAgents(capture));
    remote.releaseStream();
    await pending;

    // The row's description is the record's display copy of the endpoint: the key it embeds is
    // redacted there, present as [redacted] rather than merely gone.
    expect(rows).toContain("audit");
    expect(rows).toContain("[redacted]");
    expect(rows).not.toContain(`${key}/`);
    expect(logs.join("\n")).not.toContain(key);
    expect(createRequest(remote).authorization).toBe(`Bearer ${key}`);
  });

  it("withholds an escaped path prefix instead of displaying it", async () => {
    // A key of `k<7>` used as the prefix leaves the wire: the URL parser percent-encodes it, and
    // the escaped form is not the literal a redaction needle can find. The honest display is the
    // origin alone, on every surface that shows the endpoint.
    const key = "k<7>";
    const remote = await server({ prefix: "/k%3C7%3E/v1", holdStream: true });
    install(`${remote.url}/${key}/v1`, key);
    const capture = await start();
    const pending = outcome(executable(capture));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");

    const rows = rendered(await openRunningAgents(capture));
    remote.releaseStream();
    await pending;

    expect(rows).toContain("audit");
    expect(rows).toContain(remote.url);
    expect(rows).not.toContain(key);
    expect(rows).not.toContain("%3C");
  });

  it("names only the origin in a transport fault when the prefix cannot be shown", async () => {
    const key = "k<7>";
    const dead = await server();
    await dead.close();
    install(`${dead.url}/${key}/v1`, key);
    const logs = captureConsole();

    const result = await outcome(executable(await start()));

    expect(result.isError).toBe(true);
    expect(result.text).toContain(dead.url);
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain("%3C");
    expect(logs.join("\n")).not.toContain(key);
  });

  for (const [label, key] of [
    ["an empty", ""],
    ["a whitespace-only", " \t "],
    ["a json-unstable", 'bad"key'],
    ["a non-ascii", "clé"],
  ] as const) {
    it(`refuses ${label} apiKey instead of sending without it`, async () => {
      const target = await server();
      write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
      writeConfig(target.url, key);
      const logs = captureConsole();

      const result = await outcome(executable(await start()));

      expect(result.isError).toBe(true);
      expect(result.text).toContain('"local"');
      expect(result.text).toMatch(/api\s*key|apikey/i);
      expect(target.requests).toEqual([]);
      if (key.trim() !== "") {
        expect(result.text).not.toContain(key.trim());
        expect(logs.join("\n")).not.toContain(key.trim());
      }
    });
  }
});

describe("workflow stream event admission", () => {
  it("leaves prototype-named events inert and keeps the connection and the text channel intact", async () => {
    const frames =
      DISPATCH +
      prototypeFrame("constructor") +
      prototypeFrame("toString") +
      prototypeFrame("__proto__") +
      prototypeFrame("hasOwnProperty") +
      textFrame("Text that still belongs to analysis");
    const remote = await server({ streams: [frames], holdStream: true });
    install(remote.url);
    const logs = captureConsole();
    const capture = await start();
    const tool = executable(capture);
    const args = { workflow: "audit", prompt: "Review changes" };
    const { views, paint } = liveViews(tool, args);

    const pending = run(tool, args, undefined, paint);
    // The chunk after the unknown frames still renders, attributed where the last recognized
    // frame left the unnamed channel: nothing repainted the source and no node named "rogue" exists.
    const live = await viewMatching(
      views,
      (view) => view.includes("Text that still belongs to analysis"),
      "the chunk after the unknown frames is on screen",
      pending,
    );
    expect(live).toContain("analysis");
    for (const view of views) {
      expect(view).not.toContain("rogue");
      expect(view).not.toContain("constructor");
    }
    // The unknown frames neither threw inside the run nor ended the connection: the endpoint still
    // holds one stream socket, and no read task died on its own.
    expect(logs.join("\n")).not.toContain("stopped following");
    expect(remote.streamSocketsOpen()).toBe(1);

    remote.releaseStream();
    const result = await pending;
    expect(text(result)).toContain("The declared output");
  });

  it("still reads GET when a connection delivers only unknown frames", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    writeConfig(FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const streamReady = deferred<void>();
    let push: (frame: string) => void = () => {
      throw new Error("workflow stream did not open");
    };
    const remote = fakeWorkflowFetch({
      stream: (send) => {
        push = send;
        streamReady.resolve();
      },
      read: () => jsonResponse(200, readState({ result: DEFAULT_RESULT })),
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = outcome(tool);
      await streamReady.promise;

      // Unknown frames at the silence window's midpoint must neither end the connection early nor
      // rearm the window: the authoritative read belongs at the window's expiry, not before.
      push(prototypeFrame("constructor") + prototypeFrame("toString") + prototypeFrame("__proto__"));
      await vi.advanceTimersByTimeAsync(0);
      expect(remote.reads()).toBe(0);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(remote.reads()).toBe(1);
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.text).toContain("The declared output");
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("workflow monitor and stop arbitration", () => {
  it("continues the read backoff 2/4/8/16/30/30 across the hand-back", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    writeConfig(FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    const firstRead = deferred<void>();
    const readTimes: number[] = [];
    let streamOpens = 0;
    const remote = fakeWorkflowFetch({
      stream: (_push, close) => {
        streamOpens += 1;
        close();
      },
      read: () => {
        readTimes.push(Date.now());
        firstRead.resolve();
        return jsonResponse(503, { error: "Temporarily unavailable" });
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = outcome(tool);
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await vi.advanceTimersByTimeAsync(0);

      // Five failed reads land the hand-back at the 30s cumulative mark; the call is released
      // while the run keeps its observation and its accumulated backoff position.
      await pump(4, 10_000);
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/stalled|unknown|degraded/i);

      const readsAtHandBack = remote.reads();
      await pump(12, 10_000);
      // The gaps between consecutive reads continue growing to the cap and hold it across the
      // hand-back: a restart at the base delay shows up as a 2s gap where 30s belongs.
      const gaps = readTimes.slice(1).map((time, index) => time - readTimes[index]!);
      expect(gaps.slice(0, 6)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      expect(remote.reads()).toBeGreaterThan(readsAtHandBack);
      // No stream is opened while the last known state is not running: reads continue on backoff.
      expect(streamOpens).toBe(1);
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("reopens the stream after recovery and keeps painting the row after the call handed back", async () => {
    write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
    writeConfig(FAKED_URL);
    const capture = await start();
    const tool = executable(capture);
    expect(tool.renderResult, "Workflow must render its live result").toBeTypeOf("function");
    const args = { workflow: "audit", prompt: "Review changes" };
    const { state, paint } = liveViews(tool, args);
    const firstRead = deferred<void>();
    let streamOpens = 0;
    const remote = fakeWorkflowFetch({
      stream: (send, close) => {
        streamOpens += 1;
        send(
          streamOpens === 1
            ? DISPATCH + textFrame("Progress before the outage")
            : lifecycle("node_dispatched", "recovered") + textFrame("Progress after recovery"),
        );
        close();
      },
      read: (reads) => {
        if (reads === 1) firstRead.resolve();
        if (reads <= 5) return jsonResponse(503, { error: "Temporarily unavailable" });
        if (reads === 6) return jsonResponse(200, readState({ status: "running" }));
        return jsonResponse(200, readState({ result: DEFAULT_RESULT }));
      },
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", remote.fetch);
    try {
      const pending = run(tool, args, undefined, paint);
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await pump(4, 10_000);
      const handed = await pending;

      expect(handed.isError ?? false).toBe(false);
      expect(text(handed)).toMatch(/stalled|unknown|degraded/i);
      // The progress observed before the outage survives the hand-back on the row.
      expect(resultView(tool, handed, args, { state })).toContain("Progress before the outage");

      // Recovery: a read that answers running reopens the stream exactly once, the new connection
      // rebuilds the display, and the next read settles the run.
      await pump(12, 10_000);
      expect(streamOpens).toBe(2);
      const status = await run(executable(capture, "AgentStatus"), {});
      expect(text(status)).toMatch(/completed/i);

      // The row's repaint after settlement carries the progress observed after the call returned:
      // the record is the source, not the call's returned snapshot.
      const repainted = resultView(tool, handed, args, { state });
      expect(repainted).toContain("Progress after recovery");
      expect(repainted).toContain("The declared output");
    } finally {
      await shutdownSession(capture);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  for (const acknowledgement of ["already_finished", "interrupted"] as const) {
    it(`reconciles a non-stopped acknowledgement (${acknowledgement}) through one immediate read with the stream held`, async () => {
      const remote = await server({
        holdStream: true,
        releaseStreamOn: "stopped",
        stopOutcome: acknowledgement,
        streams: [DEFAULT_STREAM],
        reads: [acknowledgement === "already_finished" ? declaredOutputRead() : recordedResponse("read-interrupted")],
      });
      install(remote.url);
      const capture = await start();
      const abort = new AbortController();
      const pending = outcome(executable(capture), undefined, abort.signal);
      await beforeEnd(remote.streamOpened, pending, "the stream opened");
      const streamsAtStop = streamRequests(remote).length;

      abort.abort();
      await remote.stopReceived;
      // The authoritative read happens on the acknowledgement's own tick: no new SSE connection,
      // no backoff sleep — the ack owes one GET and pays it now.
      await vi.waitFor(() => expect(readRequests(remote)).toHaveLength(1), { timeout: 3_000 });
      const result = await pending;

      expect(streamRequests(remote)).toHaveLength(streamsAtStop);
      expect(stopRequests(remote)).toHaveLength(1);
      const status = await run(executable(capture, "AgentStatus"), {});
      expect(text(status)).toContain("audit");
      if (acknowledgement === "already_finished") {
        expect(result.isError).toBe(false);
        expect(result.text).toContain("The declared output");
        expect(text(status)).toMatch(/completed/i);
      } else {
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/interrupt/i);
        expect(text(status)).toMatch(/error/i);
      }
    });
  }

  it("keeps a settled run's terminal state when a stop arrives after it", async () => {
    // The read-before-stop order at the record boundary: GET's terminal state applied first is the
    // record's state, the later stop is refused without a request, and nothing settles twice.
    const remote = await server();
    install(remote.url);
    const capture = await start();

    const result = await run(executable(capture));
    expect(text(result)).toContain("The declared output");

    const id = listedRunId(await run(executable(capture, "AgentStatus"), {}));
    const stop = await outcome(executable(capture, "StopAgent"), { agent_id: id });

    expect(stop.isError).toBe(false);
    expect(stop.text).toMatch(/already/i);
    expect(stopRequests(remote)).toHaveLength(0);
    const after = await run(executable(capture, "AgentStatus"), {});
    expect(text(after)).toMatch(/completed/i);
    expect(text(after)).not.toMatch(/stopped/i);
  });
});

describe("workflow disposal", () => {
  it("releases the waiter with an honest note and publishes nothing (mid-backoff)", async () => {
    await disposalCase("mid-backoff");
  });

  it("releases the waiter with an honest note and cancels the in-flight stop's deadline (stop in flight)", async () => {
    await disposalCase("stop in flight");
  });

  it("ends observation at shutdown without publishing a completion (stream open)", async () => {
    const remote = await server({ holdStream: true });
    install(remote.url);
    const notices: string[] = [];
    const capture = await start(true, notices);
    const updates: WorkflowResult[] = [];
    const pending = run(executable(capture), undefined, undefined, (update) => updates.push(update));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");
    const updatesAtShutdown = updates.length;
    const requestsAtShutdown = remote.requests.length;

    await shutdownSession(capture);
    await remote.streamSocketClosed();
    const report = text(await pending);

    expectHonestShutdownNote(report, notices);
    // No terminal publication: no update from the disposal path, and the local socket is gone.
    expect(updates).toHaveLength(updatesAtShutdown);
    expect(remote.requests).toHaveLength(requestsAtShutdown);
  });
});

/** The padded-key case as one behavior: the sent value is the trimmed key, the echoed value is redacted. */
async function runPaddedKeyCase(padding: string): Promise<void> {
  const key = `${padding}example-key${padding}`;
  const remote = await server({ echoAuth: true });
  install(remote.url, key);
  const logs = captureConsole();

  const result = await outcome(executable(await start()));

  // The wire strips trailing header whitespace, so the padded form is not what the endpoint sees:
  // the effective value is the trimmed key, on both sides of the boundary.
  expect(createRequest(remote).authorization).toBe("Bearer example-key");
  expect(result.isError).toBe(true);
  expect(result.text).toContain("[redacted]");
  expect(result.text).not.toContain("example-key");
  expect(logs.join("\n")).not.toContain("example-key");
}

/** The one honest shutdown note, on both surfaces it reaches: observation ended, outcome unknown —
 * never a claim about whether a stop was sent, landed, or failed. */
function expectHonestShutdownNote(report: string, notices: string[]): void {
  expect(report).toMatch(/shut ?down|session/i);
  expect(report).toMatch(/unknown/i);
  expect(report).not.toMatch(/(?:was not|nothing was) stopped/i);
  expect(notices.join("\n")).toMatch(/watched|observ/i);
  expect(notices.join("\n")).toMatch(/unknown/i);
  expect(notices.join("\n")).not.toMatch(/nothing was stopped|left running remotely/i);
}

/**
 * The two fake-clock disposal windows share one shape: pending work when the session ends, the
 * waiter released with the honest note, no update, no new request, and no scheduled work left.
 */
async function disposalCase(window: "mid-backoff" | "stop in flight"): Promise<void> {
  write(join(ws.agentDir, "workflows", "audit.yaml"), workflow());
  writeConfig(FAKED_URL);
  const notices: string[] = [];
  const capture = await start(true, notices);
  const tool = executable(capture);
  const updates: WorkflowResult[] = [];
  const firstRead = deferred<void>();
  const streamOpened = deferred<void>();
  const heldStop = deferred<Response>();
  const remote = fakeWorkflowFetch({
    stream: (send, close) => {
      send(DISPATCH);
      streamOpened.resolve();
      close();
    },
    read: () => {
      firstRead.resolve();
      return jsonResponse(503, { error: "Temporarily unavailable" });
    },
    stop: (signal) =>
      new Promise<Response>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("The request was aborted")), { once: true });
        void heldStop.promise.then(resolve, reject);
      }),
  });
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", remote.fetch);
  const stopCount = () => remote.requests().filter((request) => request.url.endsWith("/stop")).length;
  try {
    const abort = new AbortController();
    const pending = run(tool, undefined, abort.signal, (update) => updates.push(update));
    await beforeEnd(streamOpened.promise, pending, "the stream opened");
    if (window === "stop in flight") {
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopCount(), "the stop is on the wire and unanswered").toBe(1);
    } else {
      // Three seconds in: past the first failed read and its 2s retry, inside the growing backoff.
      await beforeEnd(firstRead.promise, pending, "the first state read");
      await pump(1, 3_000);
    }

    const updatesAtShutdown = updates.length;
    const requestsAtShutdown = remote.requests().length;
    await shutdownSession(capture);
    const report = text(await pending);

    expectHonestShutdownNote(report, notices);
    // No terminal publication into the dead session, and no work scheduled for later.
    expect(updates).toHaveLength(updatesAtShutdown);
    expect(vi.getTimerCount()).toBe(0);
    // A stop that was already on the wire keeps its bytes; its late acknowledgement changes nothing.
    heldStop.resolve(jsonResponse(200, stopAck("stopped", REMOTE_ID)));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(remote.requests()).toHaveLength(requestsAtShutdown);
    expect(remote.requests().length).toBe(requestsAtShutdown);
    expect(updates).toHaveLength(updatesAtShutdown);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}
