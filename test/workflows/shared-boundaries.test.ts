/** Wave 1R acceptance through Pi's registered tools, renderers and lifecycle events over real HTTP. */
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
import { defaultTheme, defaultUi } from "../mock-utils.js";
import { asCommandContext, asTui, asUiCustom } from "../pi-boundaries.js";
import {
  AUTH_ECHO,
  beforeEnd,
  clockedLoopback,
  declaredOutputRead,
  deferred,
  DISPATCH,
  endpoint,
  errorBody,
  lifecycle,
  progressFrame,
  readRequests,
  recordedResponse,
  RECONNECT,
  stateReply,
  stopRequests,
  streamRequests,
  TARGET_ECHO,
  TERMINAL,
  textFrame,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";

const TARGET = "release-gateway";
const KEY = "fixture-api-token";
const ARGS = { workflow: "audit", prompt: "Review changes" };
const ANSWER = "The declared output";
const OUTAGE = { status: 503, body: errorBody("Temporarily unavailable") };

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;
type Exchanges = ReturnType<typeof clockedLoopback>;

interface ExecutableTool extends RegisteredTool {
  execute(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: Update | undefined,
    ctx: ExtensionContext,
  ): Promise<Result>;
}

let ws: Workspace;
let api: MockExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;
let remotes: TestEndpoint[];

beforeEach(() => {
  ws = workspace();
  remotes = [];
  vi.resetModules();
  vi.doMock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
    getAgentDir: () => ws.agentDir,
  }));
});

afterEach(async () => {
  await shutdown();
  for (const remote of remotes) await remote.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  api = undefined;
  rmSync(ws.root, { recursive: true, force: true });
});

async function start(notices: string[] = [], ui: Partial<ExtensionContext["ui"]> = {}): Promise<MockExtensionAPI> {
  api = createMockExtensionAPI();
  ctx = fakeCtx({ cwd: ws.project, ui: { ...defaultUi, notify: (message) => notices.push(message), ...ui } });
  await loadExtension(api.api);
  const handler = api.listeners.find((listener) => listener.event === "session_start")?.handler;
  expect(handler, "Pi must be able to start the extension").toBeTypeOf("function");
  await handler!({ type: "session_start", reason: "startup" }, ctx);
  return api;
}

async function shutdown(): Promise<void> {
  if (!api || !ctx) return;
  const handler = api.listeners.find((listener) => listener.event === "session_shutdown")?.handler;
  expect(handler, "Pi must be able to end the session").toBeTypeOf("function");
  await handler!({ type: "session_shutdown", reason: "quit" }, ctx);
  ctx = undefined;
}

async function server(options?: EndpointOptions): Promise<TestEndpoint> {
  const remote = await endpoint(options);
  remotes.push(remote);
  return remote;
}

function install(url: string, apiKey?: unknown, definition = workflow()): void {
  write(join(ws.agentDir, "workflows", "audit.yaml"), definition);
  write(
    join(ws.agentDir, "subagents-lite.json"),
    JSON.stringify({
      workflows: { endpoints: { [TARGET]: { url, apiKey } }, defaultEndpoint: TARGET },
    }),
  );
}

function overrideProjectUrl(url: string): void {
  write(
    join(ws.project, ".pi", "subagents-lite.json"),
    JSON.stringify({
      workflows: { endpoints: { [TARGET]: { url } } },
    }),
  );
}

function tool(capture: MockExtensionAPI, name = "Workflow"): ExecutableTool {
  const registered = capture.tools.filter((tool) => tool.name === name).at(-1) as ExecutableTool | undefined;
  expect(registered?.execute, `Pi must be able to call ${name}`).toBeTypeOf("function");
  return registered!;
}

function run(capture: MockExtensionAPI, signal?: AbortSignal, onUpdate?: Update): Promise<Result> {
  return tool(capture).execute("workflow-call", ARGS, signal, onUpdate, ctx!);
}

function text(result: Result): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function report(pending: Promise<Result>) {
  try {
    const result = await pending;
    return { isError: result.isError ?? false, text: text(result) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { isError: true, text: error.message };
  }
}

async function status(capture: MockExtensionAPI): Promise<string> {
  return text(await tool(capture, "AgentStatus").execute("status-call", {}, undefined, undefined, ctx!));
}

function runId(listing: string): string {
  const id = listing.match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "AgentStatus must list the run by its short id").toBeTypeOf("string");
  return id!;
}

async function stop(capture: MockExtensionAPI, id: string): Promise<string> {
  return text(await tool(capture, "StopAgent").execute("stop-call", { agent_id: id }, undefined, undefined, ctx!));
}

function rows(component: unknown): string[] {
  if (
    typeof component !== "object" ||
    component === null ||
    !("render" in component) ||
    typeof component.render !== "function"
  )
    return [];
  const lines: unknown = component.render(240);
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string").map((line) => line.trim());
}

/** Drive the real Workflow row, including its registered completion invalidation. */
function resultRow(capture: MockExtensionAPI) {
  const registered = tool(capture);
  const state = {};
  const repaints: string[] = [];
  const invalidated = deferred<string>();
  let snapshot: Result;
  function render(): string {
    const component = registered.renderResult?.(snapshot, { expanded: true }, defaultTheme, {
      args: ARGS,
      state,
      expanded: true,
      isPartial: false,
      toolCallId: "workflow-call",
      invalidate: () => {
        const display = render();
        repaints.push(display);
        invalidated.resolve(display);
      },
      cwd: ws.project,
      executionStarted: true,
      argsComplete: true,
      showImages: false,
      isError: snapshot.isError ?? false,
    });
    return rows(component).join("\n");
  }
  return {
    repaints,
    invalidated: invalidated.promise,
    paint(result: Result) {
      snapshot = result;
      return render();
    },
  };
}

interface MenuComponent {
  handleInput(data: string): void;
}

async function runningMenu(capture: MockExtensionAPI): Promise<string> {
  const command = capture.commands.find(({ name }) => name === "agents");
  expect(command, "Pi must expose the agents menu").toBeDefined();
  const main = deferred<MenuComponent>();
  const running = deferred<MenuComponent>();
  let first = true;
  const menuCtx = fakeCtx({
    cwd: ws.project,
    ui: {
      ...defaultUi,
      custom: asUiCustom(
        async (factory: unknown) =>
          new Promise<undefined>((done) => {
            const build = factory as (tui: unknown, theme: unknown, kb: unknown, close: typeof done) => MenuComponent;
            const menu = build({ terminal: { rows: 24 } }, defaultTheme, {}, done);
            (first ? main : running).resolve(menu);
            first = false;
          }),
      ),
    },
  });
  const closing = command!.handler("", asCommandContext(menuCtx));
  void closing.catch(() => {});
  (await main.promise).handleInput("\r");
  const menu = await running.promise;
  const screen = rows(menu).join("\n");
  menu.handleInput("\x1b");
  (await main.promise).handleInput("\x1b");
  expect(screen).toContain("Running Agents");
  return screen;
}

/** Install the same widget factory Pi receives when the running Workflow registers. */
async function startWithWidget() {
  type Factory = NonNullable<Parameters<ExtensionContext["ui"]["setWidget"]>[1]>;
  let widget: ReturnType<Factory> | undefined;
  const tui = asTui({ terminal: { columns: 240, rows: 24 }, requestRender: () => {} });
  const theme = { ...defaultTheme };
  const capture = await start([], {
    setWidget: (_key: string, content: string[] | Factory | undefined) => {
      widget = typeof content === "function" ? content(tui, Object.assign({}, defaultUi.theme, theme)) : undefined;
    },
  });
  const turn = capture.listeners.find((entry) => entry.event === "turn_start");
  expect(turn, "Pi must be able to attach the widget on its first turn").toBeDefined();
  await turn!.handler({ type: "turn_start" }, ctx);
  return { capture, widgetText: () => rows(widget).join("\n") };
}

function consoleLines(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "info", "debug", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => lines.push(values.map(String).join(" ")));
  }
  return lines;
}

function wire(remote: TestEndpoint): string[] {
  return remote.requests.map(({ method, path }) => `${method} ${path}`);
}

function runPath(remote: TestEndpoint): string {
  return `${remote.prefix}/api/workflows/${remote.segment}`;
}

/** Call only after draining the response on the current virtual tick. */
async function returnedNow(pending: Promise<Result>, reason: string): Promise<Result> {
  const result = await Promise.race([pending, Promise.resolve(undefined)]);
  expect(result, reason).toBeDefined();
  return result!;
}

async function consumed(exchanges: Exchanges, remote: TestEndpoint, index: number): Promise<void> {
  await remote.requestAt(index);
  await exchanges[index].bodyRead;
  await vi.advanceTimersByTimeAsync(0);
}

async function readReply(exchanges: Exchanges, remote: TestEndpoint, ordinal: number): Promise<void> {
  for (let index = 0; ; index++) {
    const request = await remote.requestAt(index);
    if (request.method === "GET" && request.path === runPath(remote) && --ordinal === 0) {
      await consumed(exchanges, remote, index);
      return;
    }
  }
}

function publishes(surface: string, output: string | RegExp, key: string, label: string): void {
  // Assert the exact redaction, without dumping the echoed credential into a failed assertion.
  const matches = typeof output === "string" ? surface.includes(output) : output.test(surface);
  expect.soft(matches, `${label} must show ${String(output)}`).toBe(true);
  expect.soft(surface.includes(key), `${label} must not publish the credential`).toBe(false);
}

function authenticates(remote: TestEndpoint, key: string): void {
  expect.soft(remote.requests.length, "a real HTTP request must have authenticated").toBeGreaterThan(0);
  expect
    .soft(
      remote.requests.every(({ authorization }) => authorization === `Bearer ${key}`),
      "every route must send exactly the effective Bearer value",
    )
    .toBe(true);
}

describe("workflow request base", () => {
  it("routes all four operations under a trusted project's endpoint prefix", async () => {
    const fallback = await server();
    const remote = await server({
      prefix: "/gateway/workflows-v1",
      holdStream: true,
      streams: [DISPATCH, DISPATCH],
      reads: [recordedResponse("read-running")],
    });
    install(fallback.url);
    overrideProjectUrl(`${remote.url}${remote.prefix}/`);
    const capture = await start();
    const esc = new AbortController();
    const pending = run(capture, esc.signal);
    await beforeEnd(remote.streamOpened, pending, "the first prefixed stream opened");
    remote.sendStream(RECONNECT);
    await beforeEnd(remote.requestAt(3), pending, "the running read reopened the prefixed stream");

    esc.abort();

    expect(text(await pending)).toMatch(/\bstopped\b/i);
    const path = runPath(remote);
    expect(wire(remote)).toEqual([
      `POST ${remote.prefix}/api/workflows`,
      `GET ${path}/stream`,
      `GET ${path}`,
      `GET ${path}/stream`,
      `POST ${path}/stop`,
    ]);
    expect(fallback.requests).toEqual([]);
  });

  it("routes an at-sign inside the prefix as ordinary path data", async () => {
    const remote = await server({ prefix: "/team@release/v1" });
    install(`${remote.url}${remote.prefix}`);

    expect(text(await run(await start()))).toBe(ANSWER);

    expect(wire(remote)).toEqual([
      `POST ${remote.prefix}/api/workflows`,
      `GET ${runPath(remote)}/stream`,
      `GET ${runPath(remote)}`,
    ]);
  });

  const authorityCases = [
    ...["/", "//", "///"].flatMap((slashes) =>
      [
        ["no controls", ""],
        ["TAB", "\t"],
        ["CR", "\r"],
        ["LF", "\n"],
      ].map(([label, control]) => ({
        label: `empty userinfo after ${slashes.length} slash(es), ${label}`,
        url: (host: string) => `http:${slashes.slice(0, -1)}${control}/@${host}/graph`,
      })),
    ),
    { label: "empty userinfo after four slashes", url: (host: string) => `http:////@${host}/graph` },
    { label: "userinfo after a backslash", url: (host: string) => `http:/\\@${host}/graph` },
    {
      label: "userinfo with leading spaces and a capitalized scheme",
      url: (host: string) => `  HTTP://@${host}/graph`,
    },
    { label: "nonempty userinfo", url: (host: string) => `http://fixture-user:fixture-password@${host}/graph` },
  ].map((test) => ({ ...test, reason: /user.?info|embedded credential/i }));

  it.for([
    { label: "a bare query delimiter", url: (host: string) => `http://${host}/graph?`, reason: /query/i },
    { label: "a bare fragment delimiter", url: (host: string) => `http://${host}/graph#`, reason: /fragment/i },
    { label: "a non-HTTP scheme", url: (host: string) => `ftp://${host}/graph`, reason: /scheme|protocol|https?/i },
    ...authorityCases,
    {
      label: "an unparseable URL carrying userinfo",
      url: (host: string) => `http://fixture-user:fixture-password@<${host}>/graph`,
      reason: /invalid|parse|usable/i,
    },
  ])("refuses $label without publishing a URL value", async ({ url, reason }) => {
    const remote = await server({ prefix: "/graph" });
    const host = new URL(remote.url).host;
    install(url(host), KEY);
    const logs = consoleLines();

    const refusal = await report(run(await start()));

    expect.soft(remote.requests.length, "the endpoint must receive no requests").toBe(0);
    expect.soft(refusal.isError).toBe(true);
    expect
      .soft(
        refusal.text.includes(`workflows.endpoints[${TARGET}].url`),
        "the refusal must name the endpoint's .url setting",
      )
      .toBe(true);
    expect.soft(reason.test(refusal.text), `the refusal must explain the ${String(reason)} problem`).toBe(true);
    const published = `${refusal.text}\n${logs.join("\n")}`;
    expect
      .soft(
        [host, "/graph", "fixture-user", "fixture-password"].some((part) => published.includes(part)),
        "the refusal and diagnostics must not quote any part of the rejected URL",
      )
      .toBe(false);
  });

  // The run id comes from the endpoint and becomes a route segment here: Fetch normalizes a dot
  // segment, so an id like `..` sent authenticated requests outside the run's own routes.
  it("asks nothing further of a created run whose id is not a usable path segment", async () => {
    const remote = await server({ run: ".." });
    install(remote.url);

    const result = await report(run(await start()));

    expect.soft(result.isError, "an unusable run id leaves the create outcome unknown").toBe(true);
    expect
      .soft(wire(remote), "no follow-up request may be built from an id that walks out of the run's route")
      .toEqual(["POST /api/workflows"]);
  });

  it("refuses an explicit null endpoint selection before contacting the default", async () => {
    const remote = await server();
    install(remote.url, undefined, `${workflow()}endpoint: null\n`);

    const refusal = await report(run(await start()));

    expect(remote.requests).toHaveLength(0);
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toMatch(
      /(?:workflow file|audit\.yaml).*\bendpoint\b|\bendpoint\b.*(?:workflow file|audit\.yaml|\bnull\b)/i,
    );
  });
});

describe("workflow credentials", () => {
  it.for([
    { label: "an unpadded key", padding: "" },
    { label: "a space-padded key", padding: " " },
    { label: "a tab-padded key", padding: "\t" },
  ])("uses one effective credential with $label", async ({ padding }) => {
    const remote = await server({
      echoAuth: true,
      holdStream: true,
      streams: [DISPATCH + textFrame(`Progress received ${AUTH_ECHO}`)],
      reads: [stateReply({ result: { audit: { authorization: AUTH_ECHO } } })],
    });
    install(remote.url, `${padding}${KEY}${padding}`);
    const capture = await start();
    const row = resultRow(capture);
    const live = deferred<{ display: string; update: Result }>();

    const pending = run(capture, undefined, (update) => {
      const display = row.paint(update);
      if (display.includes("Progress received")) live.resolve({ display, update });
    });
    await beforeEnd(live.promise, pending, "the authorization echoed in streamed progress");
    const { display, update } = await live.promise;
    remote.releaseStream();
    const result = await pending;

    authenticates(remote, KEY);
    publishes(display, "Progress received Bearer [redacted]", KEY, "rendered progress");
    publishes(JSON.stringify(update), "Progress received Bearer [redacted]", KEY, "Pi's partial result");
    const redactedJson = /"authorization"\s*:\s*"Bearer \[redacted\]"/;
    publishes(text(result), redactedJson, KEY, "the inline JSON result");
    publishes(row.repaints.join("\n"), redactedJson, KEY, "the record's result on repaint");
    expect(result.isError ?? false).toBe(false);
  });

  it("inherits the effective global credential through a project URL override", async () => {
    const fallback = await server();
    const remote = await server({ echoAuth: true, reads: [stateReply({ result: `Received ${AUTH_ECHO}` })] });
    install(fallback.url, `\t${KEY} `);
    overrideProjectUrl(remote.url);

    const result = await run(await start());

    authenticates(remote, KEY);
    publishes(text(result), "Received Bearer [redacted]", KEY, "the inline result from the project endpoint");
    expect(fallback.requests).toEqual([]);
  });

  it.for([
    {
      name: "create rejection",
      options: { rejection: { status: 422, body: errorBody(`Input refused: ${AUTH_ECHO}`) } },
      label: "Input refused",
    },
    {
      name: "terminal failure",
      options: { reads: [stateReply({ status: "failed", error: `Run failed: ${AUTH_ECHO}` })] },
      label: "Run failed",
    },
    {
      name: "terminal interruption",
      options: { reads: [stateReply({ status: "interrupted", error: `Runner lost: ${AUTH_ECHO}` })] },
      label: "Runner lost",
    },
  ])("redacts the echoed Authorization in a $name", async ({ options, label }) => {
    const remote = await server({ ...options, echoAuth: true });
    install(remote.url, `${KEY} `);
    const logs = consoleLines();
    const capture = await start();
    const row = resultRow(capture);

    const result = await report(run(capture, undefined, (update) => row.paint(update)));

    authenticates(remote, KEY);
    expect(result.isError).toBe(true);
    publishes(result.text, `${label}: Bearer [redacted]`, KEY, "the tool error");
    if (options.reads)
      publishes(row.repaints.join("\n"), `${label}: Bearer [redacted]`, KEY, "the record's error on repaint");
    expect(
      logs.some((line) => line.includes(KEY)),
      "diagnostics must not leak the configured key",
    ).toBe(false);
  });

  it.for([
    { key: "probe123", path: "/probe123/api" },
    { key: "release-key", path: "/customer-release-key/v1" },
    // A base that is the credential and nothing else, with no escape or plus in it.
    { key: "tenant-token", path: "/tenant-token" },
  ])(
    "refuses the endpoint whose request path carries the credential $key before sending anything",
    async ({ key, path }) => {
      const remote = await server({
        prefix: path,
        echoTarget: true,
        rejection: { status: 422, body: errorBody(`Input refused for ${TARGET_ECHO}`) },
      });
      install(`${remote.url}${path}`, key);
      const logs = consoleLines();

      const refusal = await report(run(await start()));

      expect.soft(remote.requests, "a credential-bearing request path is refused before any request").toEqual([]);
      expect.soft(refusal.isError, "the refused run must not report success").toBe(true);
      expect
        .soft(
          refusal.text.includes(
            `"release-gateway" (workflows.endpoints[release-gateway].url and workflows.endpoints[release-gateway].apiKey)`,
          ),
          "the refusal must name both settings it is a problem in",
        )
        .toBe(true);
      for (const value of [key, encodeURIComponent(key)]) {
        expect
          .soft(`${refusal.text}\n${logs.join("\n")}`.includes(value), `the refusal must not quote ${value}`)
          .toBe(false);
      }
    },
  );

  // A percent escape or a plus anywhere in the configured base is refused on the base alone: those are
  // the two characters a hop can rewrite, so a base carrying either cannot promise a literal target.
  it.for([
    { path: "/gateway/double%253C7%253E", key: "double<7>" },
    { path: "/gateway/a+b", key: "a b" },
    { path: "/x/%2Bb/y", key: "release-key" },
    { path: "/k%3C7%3E/v1", key: "k<7>" },
  ])(
    "refuses the base whose path carries an escape or a plus ($path) before sending anything",
    async ({ path, key }) => {
      const remote = await server({
        prefix: path,
        echoTarget: true,
        rejection: { status: 422, body: errorBody(`Input refused for ${TARGET_ECHO}`) },
      });
      install(`${remote.url}${path}`, key);
      const logs = consoleLines();

      const refusal = await report(run(await start()));

      expect.soft(remote.requests, "a base no hop can promise to forward literally is refused first").toEqual([]);
      expect.soft(refusal.isError, "the refused run must not report success").toBe(true);
      expect
        .soft(
          refusal.text.includes(
            `"release-gateway" (workflows.endpoints[release-gateway].url) cannot be written as a URL path without a percent escape or a plus`,
          ),
          "the refusal must name the url setting alone and its problem",
        )
        .toBe(true);
      const published = `${refusal.text}\n${logs.join("\n")}`;
      for (const value of [key, encodeURIComponent(key), path, remote.url, "%", "+"]) {
        expect.soft(published.includes(value), `the refusal must not quote ${value}`).toBe(false);
      }
    },
  );

  it.for([
    // Nothing in this prefix is a credential, so nothing in the echoed target is touched and the
    // endpoint's own words arrive byte for byte.
    { key: "release-key", path: "/gateway/v1" },
  ])("publishes a prefix that carries no credential exactly as the endpoint echoed it", async ({ key, path }) => {
    const remote = await server({
      prefix: path,
      echoTarget: true,
      rejection: { status: 422, body: errorBody(`Input refused for ${TARGET_ECHO}`) },
    });
    install(`${remote.url}${path}`, key);

    const result = await report(run(await start()));

    authenticates(remote, key);
    expect.soft(result.isError, "a reflected target does not make the refused run a success").toBe(true);
    publishes(result.text, `Input refused for ${path}/api/workflows`, key, "the tool error");
    expect(wire(remote)).toEqual([`POST ${path}/api/workflows`]);
  });

  // An id the endpoint answers becomes three request targets, so the create answer is where this
  // client decides what may reach a request, a row, a record or a log line: an id in any spelling a
  // forwarding hop could rewrite is refused, and so is one that spells the run's own credential.
  it.for([
    { why: "a percent sign", id: "wf%3C7%3E", spellings: ["wf%3C7%3E", "wf%253C7%253E"] },
    { why: "a plus", id: "wf+1", spellings: ["wf+1", "wf%2B1"] },
    { why: "a space", id: "wf 1", spellings: ["wf 1", "wf%201"] },
    { why: "a slash", id: "wf/1", spellings: ["wf/1", "wf%2F1"] },
    { why: "a parent segment", id: "..", spellings: [] },
    { why: "a self segment", id: ".", spellings: [] },
    { why: "an unpaired surrogate", id: "wf\ud800", spellings: ["wf\ud800"] },
    { why: "the run's own credential", id: `wf-${KEY}-1`, spellings: [`wf-${KEY}-1`] },
  ])("publishes nothing about a created run identified by $why", async ({ id, spellings }) => {
    const remote = await server({
      prefix: "/gateway/v1",
      run: id,
      echoTarget: true,
      streams: [DISPATCH + textFrame(`Progress on ${TARGET_ECHO}`)],
      reads: [stateReply({ status: "failed", error: `Run failed on ${TARGET_ECHO}` })],
    });
    install(`${remote.url}/gateway/v1`, KEY);
    const logs = consoleLines();
    const capture = await start();
    const row = resultRow(capture);
    const updates: Result[] = [];

    const pending = run(capture, undefined, (update) => {
      updates.push(update);
      row.paint(update);
    });
    const reported = await report(pending);
    const painted = row.paint(await pending);

    expect.soft(reported.isError, "an id this client cannot route leaves the create outcome unknown").toBe(true);
    expect.soft(reported.text).toMatch(/unknown outcome/i);
    expect.soft(reported.text, "one of the two refused causes").toMatch(/path segment|credential/i);
    expect
      .soft(wire(remote), "no follow-up request may be built from an id this client cannot route")
      .toEqual(["POST /gateway/v1/api/workflows"]);
    expect
      .soft(await status(capture), "a run whose routes cannot be built is never registered")
      .not.toContain("audit workflow");
    const surfaces = [
      [reported.text, "the tool error"],
      [painted, "the call's row"],
      [updates.map(text).join("\n"), "what the call published"],
      [logs.join("\n"), "diagnostics"],
    ] as const;
    for (const [surface, name] of surfaces) {
      for (const value of [...spellings, KEY]) {
        expect.soft(surface.includes(value), `${name} must not publish ${JSON.stringify(value)}`).toBe(false);
      }
    }
  });

  // A literal id needs no encoding at all, so the target the endpoint echoes carries the id's own
  // bytes: published text shows them whole, with nothing for a redaction needle to miss.
  it("publishes a literal run id in its target exactly as the endpoint echoed it", async () => {
    const remote = await server({
      prefix: "/gateway/v1",
      run: "wf-7",
      echoTarget: true,
      streams: [DISPATCH + textFrame(`Progress on ${TARGET_ECHO}`)],
      reads: [stateReply({ status: "failed", error: `Run failed on ${TARGET_ECHO}` })],
    });
    install(`${remote.url}/gateway/v1`, KEY);
    const capture = await start();

    const result = await report(run(capture));

    authenticates(remote, KEY);
    expect.soft(result.isError, "a failed run is still an error").toBe(true);
    publishes(result.text, "Run failed on /gateway/v1/api/workflows/wf-7", KEY, "the tool error");
    expect(wire(remote)).toEqual([
      "POST /gateway/v1/api/workflows",
      "GET /gateway/v1/api/workflows/wf-7/stream",
      "GET /gateway/v1/api/workflows/wf-7",
    ]);
  });

  // An endpoint can mint a run id out of the credential it was given. The routes built from that id
  // carry it percent-escaped, which no published text can redact, so the create answer is where this
  // client has to notice - before the id reaches a request, a row, a record or a log line.
  it("publishes nothing about a created run whose id spells the credential in its own routes", async () => {
    const remote = await server({
      prefix: "/gateway/v1",
      run: "wf-minted<7>-suffix",
      echoTarget: true,
      streams: [DISPATCH + textFrame(`Progress on ${TARGET_ECHO}`)],
      reads: [stateReply({ status: "failed", error: `Run failed on ${TARGET_ECHO}` })],
    });
    install(`${remote.url}/gateway/v1`, "minted<7>");
    const logs = consoleLines();
    const capture = await start();
    const row = resultRow(capture);
    const updates: Result[] = [];

    const pending = run(capture, undefined, (update) => {
      updates.push(update);
      row.paint(update);
    });
    const reported = await report(pending);
    const painted = row.paint(await pending);

    expect.soft(reported.isError, "an id this client cannot route leaves the create outcome unknown").toBe(true);
    expect.soft(reported.text).toMatch(/unknown outcome/i);
    expect
      .soft(wire(remote), "no follow-up request may be built from an id that spells the credential")
      .toEqual(["POST /gateway/v1/api/workflows"]);
    expect
      .soft(await status(capture), "a run whose routes cannot be built is never registered")
      .not.toContain("audit workflow");
    const surfaces = [
      [reported.text, "the tool error"],
      [painted, "the call's row"],
      [updates.map(text).join("\n"), "what the call published"],
      [logs.join("\n"), "diagnostics"],
    ] as const;
    for (const [surface, name] of surfaces) {
      for (const spelling of ["minted<7>", "minted%3C7%3E", "minted%253C7%253E", "wf-minted"]) {
        expect.soft(surface.includes(spelling), `${name} must not publish ${spelling}`).toBe(false);
      }
    }
  });

  it.for([{ key: "k<7>" }, { key: "<" }, { key: "key+/part" }])(
    "redacts the credential $key that the endpoint echoes back in its Authorization",
    async ({ key }) => {
      // A path would carry these in percent-escaped form; the Authorization header carries them as
      // the bytes the run authenticated with, which is what the one publisher redacts.
      const remote = await server({
        prefix: "/gateway/v1",
        echoAuth: true,
        reads: [stateReply({ result: `Received ${AUTH_ECHO}` })],
      });
      install(`${remote.url}/gateway/v1`, key);

      const result = await run(await start());

      authenticates(remote, key);
      publishes(text(result), "Received Bearer [redacted]", key, "the inline result");
      expect(text(result)).not.toContain(encodeURIComponent(key));
    },
  );

  it("redacts the transport credential in a stream diagnostic", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH], reads: [declaredOutputRead()] });
    install(remote.url, `${KEY}\t`);
    const logs = consoleLines();
    const capture = await start();
    let first = true;

    const result = await run(capture, undefined, () => {
      if (!first) return;
      first = false;
      // A failure of the Pi callback is reported by the stream's outer diagnostic boundary.
      throw new Error(`Host could not display a response from ${streamRequests(remote)[0]?.authorization}`);
    });

    authenticates(remote, KEY);
    publishes(
      logs.join("\n"),
      "Host could not display a response from Bearer [redacted]",
      KEY,
      "the stream diagnostic",
    );
    expect(text(result)).toBe(ANSWER);
  });

  // The record's two URL copies are what the widget and the running-agents menu print, and neither
  // surface holds this run's publisher: they are written already safe, from the validated base.
  it("shows the run's own base whole on the widget and the running-agents menu", async () => {
    const path = "/gateway/v1";
    const remote = await server({
      prefix: path,
      echoAuth: true,
      holdStream: true,
      streams: [DISPATCH],
      reads: [stateReply({ result: `Answer received ${AUTH_ECHO}` })],
    });
    install(`${remote.url}${path}`, KEY);
    const { capture, widgetText } = await startWithWidget();
    const pending = run(capture);
    await beforeEnd(remote.streamOpened, pending, "the configured prefix reached the wire");

    const menu = await runningMenu(capture);
    const widget = widgetText();
    remote.releaseStream();
    const result = await pending;

    authenticates(remote, KEY);
    publishes(text(result), "Answer received Bearer [redacted]", KEY, "the inline result");
    for (const [surface, name] of [
      [menu, "running-agents menu"],
      [widget, "widget"],
    ]) {
      expect.soft(surface.includes("audit workflow"), `the ${name} must show this run`).toBe(true);
      publishes(surface, `${remote.url}${path}${name === "widget" ? " " : "\n"}`, KEY, name);
    }
  });

  it("names that same base in a transport failure, and no credential", async () => {
    const path = "/gateway/v1";
    const dead = await server();
    await dead.close();
    install(`${dead.url}${path}`, KEY);
    const logs = consoleLines();

    const result = await report(run(await start()));

    expect(result.isError).toBe(true);
    expect.soft(result.text.includes(`(${dead.url}${path})`), "the fault must identify the base").toBe(true);
    const published = `${result.text}\n${logs.join("\n")}`;
    expect.soft(published.includes(KEY), "the fault must not publish the credential").toBe(false);
  });

  it.for([
    { label: "an empty string", key: "" },
    { label: "whitespace only", key: " \t " },
    { label: "a quote", key: 'fixture"token' },
    { label: "a backslash", key: "fixture\\token" },
    { label: "an embedded tab", key: "fixture\ttoken" },
    { label: "non-ASCII", key: "fixturé-token" },
    { label: "null", key: null },
    { label: "a non-string", key: 1285927 },
  ])("refuses a declared apiKey containing $label instead of sending a request", async ({ key }) => {
    const remote = await server();
    install(remote.url, key);
    const logs = consoleLines();

    const refusal = await report(run(await start()));

    expect.soft(remote.requests.length, "the endpoint must receive no requests").toBe(0);
    expect.soft(refusal.isError).toBe(true);
    expect
      .soft(
        refusal.text.includes(TARGET) && /apiKey/i.test(refusal.text),
        "the refusal must identify the endpoint's apiKey",
      )
      .toBe(true);
    const value = String(key).trim();
    if (value) {
      const published = `${refusal.text}\n${logs.join("\n")}`;
      expect
        .soft(
          published.includes(value) || published.includes(JSON.stringify(value).slice(1, -1)),
          "a refused key must not appear literally or JSON-escaped in a refusal or diagnostic",
        )
        .toBe(false);
    }
  });
});

function unknown(node: string, ...names: string[]): string {
  return names.map((name) => `event: ${name}\ndata: ${JSON.stringify({ node_id: node })}\n\n`).join("");
}

/** A terminal frame as the journal sends it: its payload names a node and carries the run's answer. */
function terminalFrame(node: string): string {
  return `event: workflow_engine_finished\ndata: ${JSON.stringify({ node_id: node, result: "a copy no read takes" })}\n\n`;
}

const PROTOTYPE_NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty"];

describe("workflow stream event admission", () => {
  it.for([...PROTOTYPE_NAMES, "future_node_event"])("leaves %s inert on the running stream", async (event) => {
    const remote = await server({
      holdStream: true,
      streams: [DISPATCH + textFrame("Inspecting the ")],
      reads: [declaredOutputRead()],
    });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const row = resultRow(capture);
    const first = deferred<string>();
    const followup = deferred<string>();
    const views: string[] = [];
    const pending = run(capture, undefined, (update) => {
      const view = row.paint(update);
      views.push(view);
      if (view.includes("Inspecting the")) first.resolve(view);
      if (view.includes("diff.") && view.includes("read_file")) followup.resolve(view);
    });
    await beforeEnd(first.promise, pending, "the original text appeared on screen");
    await vi.advanceTimersByTimeAsync(45_000);

    // The full turn replaces only analysis's chunks. If the unknown node stole the unnamed
    // channel, the tail remains visible a second time under that other source.
    remote.sendStream(
      unknown("foreign-node", event) +
        textFrame("diff.") +
        progressFrame("full-turn", "Inspecting the diff.") +
        progressFrame("tool-call"),
    );
    await beforeEnd(followup.promise, remote.streamSocketClosed(), "a later chunk rendered on the same open stream");
    const later = await followup.promise;

    expect(later.split("\n")).toEqual(["▶ analysis dispatched", "analysis tool read_file", "Inspecting the diff."]);
    expect(views.every((view) => !view.includes("foreign-node"))).toBe(true);
    expect(remote.streamSocketsOpen()).toBe(1);

    // The full turn's repaint proves the later bytes were consumed before we advance the clock.
    await vi.advanceTimersByTimeAsync(44_999);
    await expectReadAtDeadline(exchanges, remote);
    expect(text(await pending)).toBe(ANSWER);
    expect(readRequests(remote)).toHaveLength(1);
  });

  it("keeps a terminal frame's node and the bytes behind it out of the settled row", async () => {
    // A terminal frame ends this connection: the node its payload names and any chunk that shares
    // the read with it are not this connection's display state.
    const remote = await server({
      holdStream: true,
      streams: [DISPATCH + textFrame("Inspecting the ")],
      reads: [declaredOutputRead()],
    });
    install(remote.url);
    const capture = await start();
    const row = resultRow(capture);
    const live = deferred<void>();
    const pending = run(capture, undefined, (update) => {
      row.paint(update);
      live.resolve();
    });
    await beforeEnd(live.promise, pending, "the first chunk rendered");

    remote.sendStream(terminalFrame("foreign-node") + textFrame("after the terminal frame"));

    const result = await pending;
    expect(text(result)).toBe(ANSWER);
    expect(row.repaints).toEqual([`\u25b6 analysis dispatched\nInspecting the\n${ANSWER}`]);
  });

  it("uses GET at the original silence deadline when no recognized events arrive", async () => {
    const remote = await server({
      holdStream: true,
      streams: [unknown("foreign-node", ...PROTOTYPE_NAMES)],
      reads: [declaredOutputRead()],
    });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const updates: Result[] = [];
    const pending = run(capture, undefined, (update) => updates.push(update));
    await beforeEnd(remote.streamOpened, pending, "the stream opened");
    await exchanges[1].opened;
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(updates).toEqual([]);
    await expectReadAtDeadline(exchanges, remote);
    expect(text(await pending)).toBe(ANSWER);
    expect(readRequests(remote)).toHaveLength(1);
  });
});

async function expectReadAtDeadline(exchanges: Exchanges, remote: TestEndpoint): Promise<void> {
  expect(exchanges, "unknown names must not start an early read or reopen the stream").toHaveLength(2);
  expect(readRequests(remote)).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(1);
  expect(exchanges[2]?.path, "the original silence deadline must start an authoritative read").toBe(runPath(remote));
}

/** The first five failed reads, timed from real replies before advancing the application clock. */
async function handBack(exchanges: Exchanges, remote: TestEndpoint, pending: Promise<Result>): Promise<Result> {
  await beforeEnd(readReply(exchanges, remote, 1), pending, "the first read failed");
  const start = Date.now();
  for (const [index, gap] of [2_000, 4_000, 8_000, 16_000].entries()) {
    const trafficBefore = exchanges.length;
    await vi.advanceTimersByTimeAsync(gap);
    expect(exchanges.length, `there must be a new observation at the ${gap}ms retry`).toBeGreaterThan(trafficBefore);
    await readReply(exchanges, remote, index + 2);
  }
  const reads = exchanges.filter(({ method, path }) => method === "GET" && path === runPath(remote));
  expect(reads.slice(0, 5).map(({ at }) => at - start)).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
  expect(
    readRequests(remote)
      .slice(0, 5)
      .map(({ receivedAt }) => receivedAt - start),
  ).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
  return returnedNow(pending, "the fifth failed read must return the waiter at 30s without any further clock advance");
}

describe("workflow monitor continuity", () => {
  it("keeps the 2/4/8/16/30/30 read cadence across a degraded hand-back", async () => {
    const remote = await server({ streams: [DISPATCH], reads: [OUTAGE] });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const pending = run(capture);

    const handed = await handBack(exchanges, remote, pending);
    expect(text(handed)).toMatch(/unknown/i);
    expect(await status(capture)).toMatch(/audit workflow\) running/);

    for (const reads of [5, 6]) {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(
        exchanges.filter(({ path }) => path === runPath(remote)),
        "hand-back must carry the owed 30s delay",
      ).toHaveLength(reads);
      await vi.advanceTimersByTimeAsync(1);
      expect(exchanges.at(-1)?.path, "the capped delay must end in a read, not a new stream").toBe(runPath(remote));
      await readReply(exchanges, remote, reads + 1);
    }
    const timestamps = readRequests(remote).map(({ receivedAt }) => receivedAt);
    expect(timestamps.slice(1).map((at, index) => at - timestamps[index]!)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(streamRequests(remote)).toHaveLength(1);
  });

  it("repaints the handed-back row from the recovered run", async () => {
    const remote = await server({
      streams: [
        DISPATCH + textFrame("Progress before the outage"),
        lifecycle("node_dispatched", "recovery") + textFrame("Progress on the new connection") + TERMINAL,
      ],
      reads: [...Array.from({ length: 5 }, () => OUTAGE), recordedResponse("read-running"), declaredOutputRead()],
    });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const row = resultRow(capture);

    // Pi no longer submits partial results to the row once the tool waiter has returned.
    const pending = run(capture);
    const handed = await handBack(exchanges, remote, pending);
    expect(text(handed)).toMatch(/unknown/i);
    const before = row.paint(handed);
    expect(before).toContain("Progress before the outage");
    expect(streamRequests(remote), "the stream must not reopen before recovery GET answers running").toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(exchanges.at(-1)?.path).toBe(runPath(remote));
    await readReply(exchanges, remote, 6);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exchanges.at(8)?.path, "only the running GET should have reopened the stream").toBe(
      `${runPath(remote)}/stream`,
    );
    await readReply(exchanges, remote, 7);

    expect(await status(capture)).toMatch(/audit workflow\) completed/);
    expect(row.repaints).toEqual([`▶ recovery dispatched\nProgress on the new connection\n${ANSWER}`]);
  });

  it.for([{ code: 500 }, { code: 503 }])(
    "redacts the endpoint's reason when a $code read hands the waiter back",
    async ({ code }) => {
      const remote = await server({
        echoAuth: true,
        streams: [DISPATCH],
        reads: [{ status: code, body: errorBody(`Read refused: ${AUTH_ECHO}`) }],
      });
      install(remote.url, `${KEY}\t`);
      const capture = await start();
      const exchanges = clockedLoopback();

      const handed = await handBack(exchanges, remote, run(capture));

      authenticates(remote, KEY);
      expect(handed.isError ?? false).toBe(false);
      expect(text(handed)).toMatch(/unknown/i);
      publishes(text(handed), "Read refused: Bearer [redacted]", KEY, "the hand-back note");
    },
  );

  it.for([{ code: 500 }, { code: 503 }])(
    "hands a $code read back with a local diagnostic, never the run's envelope",
    async ({ code }) => {
      // A 5xx answer is a read that failed, and its body is still the run's own envelope: journal and
      // result text. None of it belongs in the note or the row, quoted or redacted.
      const remote = await server({
        echoAuth: true,
        streams: [DISPATCH],
        reads: [
          {
            status: code,
            body: JSON.stringify({
              status: "running",
              events: [{ type: "thinking_delta", text: `Thinking the run never published: ${AUTH_ECHO}` }],
              result: { text: ANSWER },
            }),
          },
        ],
      });
      install(remote.url, `${KEY}\t`);
      const capture = await start();
      const exchanges = clockedLoopback();
      const row = resultRow(capture);

      const handed = await handBack(exchanges, remote, run(capture));

      authenticates(remote, KEY);
      expect(handed.isError ?? false).toBe(false);
      const note = text(handed);
      expect(note).toMatch(/unknown/i);
      expect(note).toMatch(new RegExp(`HTTP ${code}: the endpoint answered with no reason`));
      for (const surface of [note, row.paint(handed)]) {
        expect(surface).not.toContain("Thinking the run never published");
        expect(surface).not.toContain(ANSWER);
        expect(surface).not.toContain(KEY);
        expect(surface).not.toContain(JSON.stringify(`Bearer ${KEY}`).slice(1, -1));
      }
      expect(await status(capture)).toMatch(/audit workflow\) running/);
    },
  );

  it("hands a read that answers no run status back with a local diagnostic, never the run's envelope", async () => {
    // The body of a state read is the run's state envelope: its text is journal data, and a note
    // about a failed read quotes none of it, redacted or not.
    const remote = await server({
      echoAuth: true,
      streams: [DISPATCH],
      reads: [{ status: 200, body: JSON.stringify({ detail: `Unrecognized body: ${AUTH_ECHO}` }) }],
    });
    install(remote.url, `${KEY}\t`);
    const capture = await start();
    const exchanges = clockedLoopback();

    const handed = await handBack(exchanges, remote, run(capture));

    authenticates(remote, KEY);
    expect(handed.isError ?? false).toBe(false);
    const note = text(handed);
    expect(note).toMatch(/unknown/i);
    expect(note).toMatch(/unreadable|no run status/i);
    expect(note).not.toContain("Unrecognized body");
    expect(note).not.toContain(KEY);
    expect(note).not.toContain(JSON.stringify(`Bearer ${KEY}`).slice(1, -1));
  });
});

describe("workflow stop arbitration", () => {
  it.for([
    { ack: "already_finished" as const, read: declaredOutputRead(), status: "completed", answer: ANSWER },
    {
      ack: "interrupted" as const,
      read: stateReply({ status: "interrupted", error: "runner lost its lease" }),
      status: "error",
      answer: "runner lost its lease",
    },
  ])(
    "reads GET on the same tick as $ack without a new stream",
    async ({ ack, read, status: expectedStatus, answer }) => {
      const remote = await server({ holdStream: true, stopOutcome: ack, streams: [DISPATCH], reads: [read] });
      install(remote.url);
      const capture = await start();
      const exchanges = clockedLoopback();
      const esc = new AbortController();
      const row = resultRow(capture);
      const live = deferred<void>();
      const pending = run(capture, esc.signal, (update) => {
        row.paint(update);
        live.resolve();
      });
      await beforeEnd(live.promise, pending, "the held stream rendered live progress");

      const atStop = Date.now();
      esc.abort();
      await consumed(exchanges, remote, 2);
      expect(exchanges[3]?.path, "the next action on this tick must be GET, without waiting on SSE").toBe(
        runPath(remote),
      );
      await consumed(exchanges, remote, 3);
      const result = await pending;

      expect(wire(remote)).toEqual([
        "POST /api/workflows",
        `GET ${runPath(remote)}/stream`,
        `POST ${runPath(remote)}/stop`,
        `GET ${runPath(remote)}`,
      ]);
      expect(readRequests(remote)[0]?.receivedAt).toBe(atStop);
      expect(result.isError ?? false).toBe(expectedStatus === "error");
      expect(text(result)).toContain(answer);
      expect(await status(capture)).toMatch(new RegExp(`audit workflow\\) ${expectedStatus}`));
      expect(row.repaints).toHaveLength(1);
    },
  );

  it("skips an owed read delay for a non-stopped acknowledgement", async () => {
    const remote = await server({
      streams: [DISPATCH],
      reads: [OUTAGE, declaredOutputRead()],
      stopOutcome: "already_finished",
    });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const pending = run(capture, esc.signal);
    await beforeEnd(readReply(exchanges, remote, 1), pending, "the failed GET started its first backoff");

    const atStop = Date.now();
    esc.abort();
    await consumed(exchanges, remote, 3);
    expect(exchanges[4]?.path, "the owed delay must not defer the authoritative read").toBe(runPath(remote));
    expect(text(await pending)).toBe(ANSWER);
    expect(readRequests(remote).map(({ receivedAt }) => receivedAt)).toEqual([atStop, atStop]);
    expect(streamRequests(remote)).toHaveLength(1);
  });

  it("applies the stopped acknowledgement when an unanswered terminal GET is cancelled", async () => {
    const remote = await server({
      streams: [DISPATCH + TERMINAL],
      reads: [stateReply({ status: "failed", error: "terminated" })],
      holdRead: true,
    });
    install(remote.url);
    const capture = await start();
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const row = resultRow(capture);
    const partial = deferred<void>();
    const pending = run(capture, esc.signal, (update) => {
      row.paint(update);
      partial.resolve();
    });
    await beforeEnd(partial.promise, pending, "progress was recorded");
    await beforeEnd(remote.requestAt(2), pending, "a GET was in flight");
    await exchanges[2].opened;

    esc.abort();
    await remote.stopReceived;
    remote.releaseRead();
    const stopped = await pending;
    await exchanges[2].bodyRead;
    await vi.advanceTimersByTimeAsync(0);

    expect(wire(remote)).toEqual([
      "POST /api/workflows",
      `GET ${runPath(remote)}/stream`,
      `GET ${runPath(remote)}`,
      `POST ${runPath(remote)}/stop`,
    ]);
    expect(await status(capture)).toMatch(/audit workflow\) stopped/);
    expect(text(stopped)).toMatch(/acknowledged the stop/i);
    expect(row.repaints).toEqual([`▶ analysis dispatched\n${text(stopped)}`]);
    expect(row.repaints.join("\n")).not.toContain("terminated");
  });

  it("keeps the terminal record when Stop arrives after an applied GET", async () => {
    const remote = await server({ streams: [DISPATCH + TERMINAL], reads: [declaredOutputRead()] });
    install(remote.url);
    const capture = await start();
    const row = resultRow(capture);

    const result = await run(capture, undefined, (update) => row.paint(update));
    const applied = await status(capture);
    const sent = wire(remote);
    const stopped = await stop(capture, runId(applied));

    // The arbiter has already settled this run. There is no concurrent POST to manufacture a late ack from.
    expect(stopped).toMatch(/already completed/i);
    expect(await status(capture)).toBe(applied);
    expect(text(result)).toBe(ANSWER);
    expect(row.repaints).toEqual([`▶ analysis dispatched\n${ANSWER}`]);
    expect(wire(remote)).toEqual(sent);
  });

  it("keeps a refused stop retryable after handing the waiter back", async () => {
    const remote = await server({
      holdStream: true,
      streams: [DISPATCH],
      echoAuth: true,
      stopRejection: [{ status: 503, body: errorBody(`Stop refused: ${AUTH_ECHO}`) }],
    });
    install(remote.url, `${KEY} `);
    const capture = await start();
    const row = resultRow(capture);
    const esc = new AbortController();
    const pending = run(capture, esc.signal);
    await beforeEnd(remote.streamOpened, pending, "the stoppable run is streaming");
    const id = runId(await status(capture));

    await stop(capture, id);
    const handed = await pending;
    publishes(text(handed), "Stop refused: Bearer [redacted]", KEY, "the stop-failed note");
    expect(text(handed)).toMatch(/stop failed.*unknown/i);
    expect(await status(capture)).toMatch(/audit workflow\) running/);
    row.paint(handed);

    esc.abort();
    expect(stopRequests(remote)).toHaveLength(1);
    await stop(capture, id);
    expect(await row.invalidated).toMatch(/acknowledged the stop/i);
    expect(await status(capture)).toMatch(/audit workflow\) stopped/);
    // The second request is explicit; the abandoned foreground waiter's Esc must not contribute a stop.
    expect(stopRequests(remote)).toHaveLength(2);
    authenticates(remote, KEY);
  });
});

describe("workflow session shutdown", () => {
  // Pi's own teardown order (`teardownCurrent`, `dispose`): abort the active turn and await it, then
  // emit `session_shutdown`. That abort is what stops a bound run, so shutdown itself has to add
  // nothing - no second stop, no publication, no record write.
  it("stops the run once when the teardown aborts the turn before it ends the session", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH], reads: [OUTAGE] });
    install(remote.url);
    const notices: string[] = [];
    const capture = await start(notices);
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const updates: Result[] = [];
    const row = resultRow(capture);
    const live = deferred<void>();
    const pending = run(capture, esc.signal, (update) => {
      updates.push(update);
      row.paint(update);
      live.resolve();
    });
    await beforeEnd(live.promise, pending, "the active run rendered progress");

    esc.abort();
    await consumed(exchanges, remote, 2);
    const settled = await pending;
    const sent = wire(remote);
    const attempts = exchanges.length;
    const published = [...updates];
    const painted = [...row.repaints];
    const listed = await status(capture);

    await shutdown();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(text(settled)).toMatch(/acknowledged the stop/i);
    expect(listed).toMatch(/audit workflow\) stopped/);
    expect(stopRequests(remote), "the abort's stop is the only stop the endpoint ever sees").toHaveLength(1);
    expect(exchanges, "shutdown may start no request, retry or stop of its own").toHaveLength(attempts);
    expect(wire(remote)).toEqual(sent);
    expect(updates, "nothing is published into a session that is gone").toEqual(published);
    expect(row.repaints, "the settled row is never repainted by disposal").toEqual(painted);
    expect(notices.join("\n")).not.toMatch(/no longer watched/i);
  });

  it.for(["an open stream", "read backoff", "an unanswered stop"] as const)(
    "ends local observation during %s",
    async (window) => {
      const remote = await server({
        holdStream: window !== "read backoff",
        holdStop: window === "an unanswered stop",
        streams: [DISPATCH],
        reads: [OUTAGE],
      });
      install(remote.url);
      const notices: string[] = [];
      const capture = await start(notices);
      const exchanges = clockedLoopback();
      const esc = new AbortController();
      const updates: Result[] = [];
      const row = resultRow(capture);
      const live = deferred<void>();
      const pending = run(capture, esc.signal, (update) => {
        updates.push(update);
        row.paint(update);
        live.resolve();
      });
      await beforeEnd(live.promise, pending, "the active run rendered progress");
      if (window === "read backoff") {
        await readReply(exchanges, remote, 1);
        expect(readRequests(remote)).toHaveLength(1);
      }
      if (window === "an unanswered stop") {
        esc.abort();
        await beforeEnd(remote.stopReceived, pending, "the stop was sent but not acknowledged");
        expect(stopRequests(remote)).toHaveLength(1);
      }
      expect(vi.getTimerCount(), "the session must have virtual work to cancel").toBeGreaterThan(0);
      const published = [...updates];
      const sent = wire(remote);
      const attempts = exchanges.length;

      await shutdown();
      await vi.advanceTimersByTimeAsync(0);

      const released = await returnedNow(pending, "the waiter must return without a remote response or advancing time");
      expect.soft(text(released)).toMatch(/no longer watched.*(?:outcome|state).*unknown/i);
      expect.soft(notices.join("\n")).toMatch(/no longer watched.*(?:outcome|state).*unknown/i);
      expect
        .soft(`${text(released)} ${notices.join("\n")}`)
        .not.toMatch(/left running remotely|nothing was stopped|was not stopped/i);
      expect.soft(updates, "disposal must not publish a tool update").toEqual(published);
      expect.soft(row.repaints, "disposal must not repaint a terminal result").toEqual([]);
      expect
        .soft(vi.getTimerCount(), "no workflow timer may survive disposal, even before an outstanding stop replies")
        .toBe(0);

      const atRelease = [...updates];
      if (window === "an open stream") await remote.streamSocketClosed();
      remote.releaseStop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(exchanges, "no local retry, read, or extra stop may be started after shutdown").toHaveLength(attempts);
      expect(wire(remote)).toEqual(sent);
      expect(updates, "a late response cannot update the disposed call").toEqual(atRelease);
    },
  );
});
