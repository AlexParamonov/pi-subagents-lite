/**
 * handback-notes.test.ts — what the session is told when workflow monitoring cannot finish: the
 * hand-back note, the widget and AgentStatus rows that carry it while the settlement is still open,
 * the notification for a run that settles after its call was handed back, and the silence kept when
 * the caller still holds the outcome. Driven through the registered tools over a scripted loopback
 * endpoint, with the application's timers under the test's control (`clockedLoopback`).
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
import { asTui } from "../pi-boundaries.js";
import { defaultTheme, defaultUi } from "../mock-utils.js";
import {
  beforeEnd,
  clockedLoopback,
  declaredOutputRead,
  deferred,
  DISPATCH,
  endpoint,
  errorBody,
  stateReply,
  stopRequests,
  streamRequests,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;
type Exchanges = ReturnType<typeof clockedLoopback>;

/** One hand Pi received: the message, plus the options it was delivered with. */
interface Nudge {
  message: { customType: string; content: { type: "text"; text: string }[]; display: boolean; details: unknown };
  options: unknown;
}

/** A tool Pi can call, with its `execute` exposed. */
interface ExecutableTool extends RegisteredTool {
  execute(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: Update | undefined,
    ctx: ExtensionContext,
  ): Promise<Result>;
}

/** The widget the extension registered, reached through `setWidget` as Pi reaches it. */
interface Widget {
  showStatus: boolean;
  render(): string[];
}

const WORKFLOW = "audit";
const ARGS = { workflow: WORKFLOW, prompt: "Review changes" };
/** An endpoint that explains itself without letting the stream answer: the read is the only voice. */
const OUTAGE = { status: 503, body: errorBody("Temporarily unavailable") };
/** A stream that yields the dispatch and then nothing, so the read is what has to answer. */
const QUIET_STREAMS = [DISPATCH, "", "", "", "", "", ""];
/** The refusal the endpoint gives for a run it will not stop. */
const REFUSAL = { status: 409, body: errorBody("workflow is not running") };
/** The hint every hand-back note ends with, so a caller stops polling. */
const NO_POLL = "Don't poll — a workflow run returns its result in the tool call that started it.";
/** A settlement the caller already holds reaches nobody else. */
const NO_NUDGE: Nudge[] = [];

let ws: Workspace;
let api: MockExtensionAPI | undefined;
let ctx: ExtensionContext | undefined;
let remotes: TestEndpoint[] = [];

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
  ctx = undefined;
  rmSync(ws.root, { recursive: true, force: true });
});

/**
 * Start the session the way Pi does, with the widget's host attached. The workflow file and the
 * endpoint config must be installed first: the session reads them as it starts.
 */
async function start(options: { notices?: string[]; parentIdle?: boolean } = {}) {
  api = createMockExtensionAPI();
  const notices = options.notices ?? [];
  const tui = asTui({ terminal: { columns: 240, rows: 24 } });
  const theme = { ...defaultTheme, bg: (_color: string, text: string) => text };
  let rows: Widget | undefined;
  ctx = fakeCtx({
    cwd: ws.project,
    isIdle: () => options.parentIdle ?? true,
    ui: {
      ...defaultUi,
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWidget: (_key: string, content: unknown) => {
        const build = content as ((tui: unknown, theme: unknown) => Widget) | undefined;
        rows = build ? build(tui, theme) : undefined;
      },
    },
  });
  await loadExtension(api.api);
  await startListener("session_start", { type: "session_start", reason: "startup" });
  await startListener("turn_start", { type: "turn_start" });
  return {
    capture: api,
    notices,
    widgetText: () => {
      expect(rows, "the extension must register a widget").toBeDefined();
      rows!.showStatus = true;
      return rows!
        .render()
        .filter((row) => row !== "")
        .join("\n");
    },
  };
}

async function startListener(event: string, payload: Record<string, unknown>): Promise<void> {
  const handler = api!.listeners.find((entry) => entry.event === event)?.handler;
  expect(handler, `the extension must handle ${event}`).toBeDefined();
  await handler!(payload, ctx);
}

async function shutdown(): Promise<void> {
  if (!api || !ctx) return;
  const handler = api.listeners.find((entry) => entry.event === "session_shutdown")?.handler;
  expect(handler, "Pi must be able to end the session").toBeTypeOf("function");
  await handler!({ type: "session_shutdown", reason: "quit" }, ctx);
  ctx = undefined;
}

async function server(options: EndpointOptions): Promise<TestEndpoint> {
  const remote = await endpoint(options);
  remotes.push(remote);
  return remote;
}

/** The workflow file and endpoint config one single-workflow session needs. */
function install(remote: TestEndpoint): void {
  write(join(ws.agentDir, "workflows", `${WORKFLOW}.yaml`), workflow());
  write(
    join(ws.agentDir, "subagents-lite.json"),
    JSON.stringify({ workflows: { endpoints: { local: { url: remote.url } }, defaultEndpoint: "local" } }),
  );
}

function tool(capture: MockExtensionAPI, name = "Workflow"): ExecutableTool {
  const registered = capture.tools.filter((entry) => entry.name === name).at(-1) as ExecutableTool | undefined;
  expect(registered?.execute, `Pi must be able to call ${name}`).toBeTypeOf("function");
  return registered!;
}

function run(signal?: AbortSignal, update?: Update): Promise<Result> {
  return tool(api!).execute("workflow-call", ARGS, signal, update, ctx!);
}

function text(result: Result): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function status(capture: MockExtensionAPI): Promise<string> {
  return text(await tool(capture, "AgentStatus").execute("status-call", {}, undefined, undefined, ctx!));
}

/** The run id AgentStatus prints - the handle the caller addresses the run by. */
function runId(listing: string): string {
  const id = listing.match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "the session must be given the run's id").toBeTypeOf("string");
  return id!;
}

/** Everything the extension handed Pi as a completion notification. */
function nudges(capture: MockExtensionAPI): Nudge[] {
  return capture.api.sendMessage.mock.calls.map(([message, options]) => ({
    message: message as Nudge["message"],
    options,
  }));
}

/**
 * Wait for the run's ordinal-th state read and deliver its response in full. The clock is stepped by
 * the caller at the cadence the client owes: a virtual clock never delivers a socket by itself.
 */
async function readReply(exchanges: Exchanges, remote: TestEndpoint, ordinal: number): Promise<void> {
  for (let index = 0, seen = 0; ; index += 1) {
    const request = await remote.requestAt(index);
    if (request.method !== "GET" || request.path !== `${remote.prefix}/api/workflows/${remote.segment}`) continue;
    seen += 1;
    if (seen < ordinal) continue;
    await exchanges[index].bodyRead;
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
}

/**
 * The five failed reads the client owes, at the cadence it owes them; the fifth hands the call back.
 * `firstGap` is how long the first read waits: nothing on a stream that ended, the silence window on
 * one the endpoint holds open.
 */
async function handedBack(
  exchanges: Exchanges,
  remote: TestEndpoint,
  pending: Promise<Result>,
  firstGap = 0,
): Promise<Result> {
  await vi.advanceTimersByTimeAsync(firstGap);
  await beforeEnd(readReply(exchanges, remote, 1), pending, "the first read to fail");
  for (const [index, gap] of [2_000, 4_000, 8_000, 16_000].entries()) {
    await vi.advanceTimersByTimeAsync(gap);
    // The read that hands the call back returns while its own response is still being delivered.
    await readReply(exchanges, remote, index + 2);
  }
  const handed = await Promise.race([pending, Promise.resolve(undefined)]);
  expect(handed, "the fifth failed read must hand the waiting call back").toBeDefined();
  return handed!;
}

/** The run's read after the hand-back, after the delay the failed reads carried. */
async function readAgain(exchanges: Exchanges, remote: TestEndpoint, ordinal: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(30_000);
  await readReply(exchanges, remote, ordinal);
}

/** Let the application wait out a delay it owes, without a remote event to anchor on. */
async function waited(ms: number): Promise<void> {
  for (let step = 0; step < ms / 250; step += 1) {
    await new Promise((yieldToSocket) => setImmediate(yieldToSocket));
    await vi.advanceTimersByTimeAsync(250);
  }
}

/** Run the application clock until `check` holds, then report the check's own failure if it never does. */
async function until(check: () => void): Promise<void> {
  for (let step = 0; step < 80; step += 1) {
    try {
      check();
      return;
    } catch {
      await waited(2_000);
    }
  }
  check();
}

/** Await the call's return, naming the reason it must return rather than dying on the test's timeout. */
async function returned(pending: Promise<Result>, reason: string): Promise<Result> {
  let result: Result | undefined;
  void pending.then((value) => {
    result = value;
  });
  await until(() => expect(result, `${reason}; the call never returned`).toBeDefined());
  return result!;
}

/** Assert the waiting call is still waiting after the delay a failed read owes has elapsed. */
async function stillWaiting(pending: Promise<Result>, reason: string): Promise<void> {
  let waiting = true;
  void pending.then(() => {
    waiting = false;
  });
  await waited(5_000);
  expect(waiting, reason).toBe(true);
}

/** Rows a rendered component produced, without the padding each row carries. */
function renderedRows(component: unknown): string[] {
  if (typeof component !== "object" || component === null || !("render" in component)) return [];
  if (typeof component.render !== "function") return [];
  const lines: unknown = (component.render as (width: number) => unknown)(240);
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === "string").map((line) => line.trimEnd())
    : [];
}

/** The last paint the call delivered: the row a reader of the session is looking at. */
function lastPaint(paints: Result[]): Result {
  const paint = paints.at(-1);
  expect(paint, "the run must have painted while it was observed").toBeDefined();
  return paint!;
}

/** The card's run row: what a reader of the session sees for the run at this paint. */
function row(paint: Result): string {
  const component = tool(api!).renderResult?.(paint, { expanded: true }, defaultTheme, {
    args: ARGS,
    state: {},
    expanded: true,
    isPartial: false,
    toolCallId: "workflow-call",
    invalidate: () => {},
    cwd: ws.project,
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    isError: paint.isError ?? false,
  });
  return (
    renderedRows(component)
      .find((line) => /^\s*[0-9a-f]{8} \(/.test(line))
      ?.trim() ?? ""
  );
}

async function settled(capture: MockExtensionAPI, count = 1): Promise<Nudge[]> {
  await until(() => expect(nudges(capture)).toHaveLength(count));
  return nudges(capture);
}

describe("a run whose monitoring fails", () => {
  it("hands the call back, keeps the record running and notifies once when the run later settles", async () => {
    const remote = await server({
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), declaredOutputRead()],
    });
    install(remote);
    const capture = (await start()).capture;
    const exchanges = clockedLoopback();
    const pending = run();

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await status(capture));
    expect(text(handed)).toBe(
      `Workflow run ${id} is still running remotely. Its state is unknown after 5 observations: ` +
        `nothing was stopped, and observation was handed back.\n` +
        `Check it later with AgentStatus using id ${id}, or with Workflow using wait_for: "${id}".\n` +
        NO_POLL,
    );
    expect(await status(capture), "the run is remote, so it stays listed and running").toMatch(
      new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`),
    );
    expect(stopRequests(remote), "a failed read stops nothing").toHaveLength(0);
    expect(nudges(capture), "a run whose state is unknown has settled for no reason").toEqual(NO_NUDGE);

    // The read that answers after the hand-back is the settlement: the caller learns it once.
    await readAgain(exchanges, remote, 6);
    expect(await settled(capture)).toEqual([
      {
        message: {
          customType: "subagent-result",
          content: [{ type: "text", text: `Workflow run ${id} completed:\nThe declared output` }],
          display: true,
          details: expect.objectContaining({ agentId: expect.stringContaining(id) }),
        },
        options: { triggerTurn: true },
      },
    ]);
  }, 60_000);

  it("says nothing about the stop in a note about a failed read", async () => {
    const remote = await server({ streams: QUIET_STREAMS, reads: Array.from({ length: 8 }, () => OUTAGE) });
    install(remote);
    const capture = (await start()).capture;
    const exchanges = clockedLoopback();
    const pending = run();

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await status(capture));
    expect(text(handed)).toContain(
      `Workflow run ${id} is still running remotely. Its state is unknown after 5 observations: ` +
        `nothing was stopped, and observation was handed back.`,
    );
    expect(text(handed), "the run's remote id is the only handle the caller has").toContain(id);
    expect(text(handed), "nothing was stopped, so a stop must never be implied").not.toMatch(/stop/i);
    expect(stopRequests(remote)).toHaveLength(0);
    expect(row(handed), "the card for a handed-back call names no stop").not.toMatch(/stop failed/i);
  }, 60_000);

  it("keeps the stop failure ahead of the unknown state, and clears both when the run is known again", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [OUTAGE, OUTAGE, OUTAGE, OUTAGE, OUTAGE, stateReply({ status: "running" })],
      stopRejection: REFUSAL,
    });
    install(remote);
    const capture = (await start()).capture;
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(esc.signal, (update) => {
      paints.push(update!);
      live.resolve();
    });

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    const handed = await returned(pending, "a call whose stop was refused is handed back");
    const id = runId(await status(capture));
    expect(text(handed)).toContain(`Workflow "${WORKFLOW}" ${id}: stop failed - HTTP 409: workflow is not running.`);

    // The outage continues after the hand-back: the unknown state must not bury the stop failure.
    for (const ordinal of [1, 2, 3, 4, 5]) {
      if (ordinal > 1) await vi.advanceTimersByTimeAsync([2_000, 4_000, 8_000, 16_000][ordinal - 2]!);
      await readReply(exchanges, remote, ordinal);
    }
    expect(row(lastPaint(paints)), "the row carries the note while the settlement is still open").toContain(
      "stop failed",
    );
    expect(await status(capture)).toContain("stop failed");
    expect(await status(capture)).not.toMatch(/unknown/i);

    // The read that says the run is live clears the note, and nothing more is notified.
    await readAgain(exchanges, remote, 6);
    expect(row(lastPaint(paints))).toMatch(new RegExp(`^${id} \\(${WORKFLOW} workflow\\) running`));
    expect(await status(capture)).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(await status(capture)).not.toMatch(/stop failed|unknown/i);
    expect(nudges(capture), "a recovered run is not an outcome the parent is notified of").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "a run whose stop was refused is not stopped again").toHaveLength(1);
  }, 60_000);

  it("shows the note on the widget row while the settlement is still open", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: Array.from({ length: 8 }, () => OUTAGE),
    });
    install(remote);
    const started = await start();
    const capture = started.capture;
    const exchanges = clockedLoopback();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(undefined, (update) => {
      paints.push(update!);
      live.resolve();
    });
    await beforeEnd(live.promise, pending, "the held stream painted live progress");

    const handed = await handedBack(exchanges, remote, pending, 90_000);
    const id = runId(await status(capture));
    const noted = lastPaint(paints);
    expect(started.widgetText(), "the widget lists the run the caller no longer holds").toContain(id);
    expect(row(noted), "the row a reader sees before the note was written names no failure").not.toMatch(
      /state is unknown/i,
    );
    expect(row(handed)).toContain("state is unknown after 5 observations");
    expect(row(handed)).toContain(NO_POLL);
    expect(streamRequests(remote).length, "observation continues after the hand-back").toBeGreaterThan(1);
  }, 60_000);
});

describe("a stop the endpoint did not confirm", () => {
  it("hands an interrupted call back with the stop failure and nothing else", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [stateReply({ status: "running" })],
      stopRejection: REFUSAL,
    });
    install(remote);
    const capture = (await start()).capture;
    clockedLoopback();
    const esc = new AbortController();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(esc.signal, (update) => {
      paints.push(update!);
      live.resolve();
    });

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    const handed = await returned(pending, "a call whose stop was refused is handed back");
    const id = runId(await status(capture));
    expect(text(handed)).toBe(
      `Workflow "${WORKFLOW}" ${id}: stop failed - HTTP 409: workflow is not running. ` +
        `The run is still running remotely; nothing more was stopped.\n` +
        `Check it later with AgentStatus using id ${id}, or with Workflow using wait_for: "${id}".\n` +
        NO_POLL,
    );
    expect(text(handed), "a stop that was refused is never reported as done").not.toMatch(/\bstopped\b/i);
    expect(text(handed), "the failure was the stop, not the state").not.toMatch(/unknown/i);
    expect(row(lastPaint(paints)), "the row carries the stop failure").toContain("stop failed");
    expect(await status(capture)).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(await status(capture)).toContain("stop failed");
    expect(nudges(capture), "a run the endpoint refuses to stop has not settled").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "an interrupted call whose stop was refused stops nothing further").toHaveLength(1);
  }, 60_000);

  it("answers the call that stayed waiting for the run, and notifies nobody", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [stateReply({ status: "running" }), declaredOutputRead()],
      stopOutcome: "interrupted",
    });
    install(remote);
    const capture = (await start({ parentIdle: false })).capture;
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const live = deferred<void>();
    const pending = run(esc.signal, () => live.resolve());

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    remote.releaseStream();
    // The dead-runner acknowledgement is a GET trigger, and the run says it is live: nothing settled.
    await readReply(exchanges, remote, 1);
    await stillWaiting(pending, "a run the read says is live leaves its call waiting");
    await readReply(exchanges, remote, 2);
    const id = runId(await status(capture));
    expect(await returned(pending, "the settlement answers the call that stayed waiting")).toContain("completed");
    expect(nudges(capture), "the caller holds the outcome, so the parent is not told").toEqual(NO_NUDGE);
    expect(await status(capture)).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) completed`));
  }, 60_000);

  it("stops nothing further when the session ends around a run whose observation was handed back", async () => {
    const remote = await server({
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), stateReply({ status: "running" })],
    });
    install(remote);
    const capture = (await start()).capture;
    const exchanges = clockedLoopback();
    const pending = run();

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await status(capture));
    expect(text(handed)).toContain(id);
    expect(stopRequests(remote)).toHaveLength(0);

    await readAgain(exchanges, remote, 6);
    expect(nudges(capture), "a run the endpoint says is live gets no completion notification").toEqual(NO_NUDGE);

    await shutdown();
    expect(stopRequests(remote), "a run whose state is unknown stops nothing on cleanup").toHaveLength(0);
    const reopened = await start();
    expect(
      await status(reopened.capture),
      "a run whose state was never confirmed is not a live local run",
    ).not.toContain(id);
    expect(stopRequests(remote)).toHaveLength(0);
  }, 60_000);
});
