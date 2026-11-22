/**
 * background-run.test.ts — A background Workflow run, at the entry points its caller uses.
 *
 * Launch, the settlement notification and the teardown rule are driven through the registered
 * `Workflow`, `AgentStatus` and `StopAgent` tools, with the Workflow endpoint on a loopback socket.
 * Pi is the only boundary mocked: `sendMessage` captures what the session is handed, and the
 * registered `subagent-result` renderer says what a reader of that message sees.
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
  DISPATCH,
  endpoint,
  stopRequests,
  streamRequests,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";

const ANSWER = "The declared output";

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;
type Nudge = { message: { content: string; details?: Record<string, unknown> }; options: unknown };

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
  ctx = undefined;
  rmSync(ws.root, { recursive: true, force: true });
});

/**
 * Start the session the way Pi does, with the widget's host attached: `setWidget` hands back the
 * content the widget registered, and `requestRender` counts the repaints the widget asks for.
 */
async function start(options: { notices?: string[]; parentIdle?: boolean } = {}) {
  api = createMockExtensionAPI();
  const notices = options.notices ?? [];
  const repaints: number[] = [];
  const tui = asTui({ terminal: { columns: 240, rows: 24 }, requestRender: () => repaints.push(repaints.length) });
  const theme = { ...defaultTheme, bg: (_color: string, text: string) => text };
  let rows: { render(): string[] } | undefined;
  ctx = fakeCtx({
    cwd: ws.project,
    isIdle: () => options.parentIdle ?? true,
    ui: {
      ...defaultUi,
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWidget: (_key: string, content: unknown) => {
        const build = content as ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
        rows = build ? build(tui, theme) : undefined;
      },
    },
  });
  await loadExtension(api.api);
  await startListener("session_start", { type: "session_start", reason: "startup" });
  // The first turn is what builds the widget, exactly as in a live session.
  await startListener("turn_start", { type: "turn_start" });
  return { capture: api, notices, repaints, widgetText: () => (rows ? rows.render().join("\n") : "") };
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

async function server(options?: EndpointOptions): Promise<TestEndpoint> {
  const remote = await endpoint(options);
  remotes.push(remote);
  return remote;
}

/** The workflow file and endpoint config one single-workflow session needs. */
function install(remote: TestEndpoint, name = "audit"): void {
  write(join(ws.agentDir, "workflows", `${name}.yaml`), workflow(name));
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

function run(
  capture: MockExtensionAPI,
  params: Record<string, unknown> = { workflow: "audit", prompt: "Review changes" },
  signal?: AbortSignal,
  update?: Update,
): Promise<Result> {
  return tool(capture).execute("workflow-call", params, signal, update, ctx!);
}

/** The same call, launched detached. */
function launch(capture: MockExtensionAPI, signal?: AbortSignal, update?: Update): Promise<Result> {
  return run(capture, { workflow: "audit", prompt: "Review changes", run_in_background: true }, signal, update);
}

function text(result: Result): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function report(pending: Promise<Result>): Promise<{ isError: boolean; text: string }> {
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

/** The run id AgentStatus prints - the handle the caller addresses the run by. */
function runId(listing: string): string {
  const id = listing.match(/\b[0-9a-f]{8}\b/)?.[0];
  expect(id, "AgentStatus must list the run by its short id").toBeTypeOf("string");
  return id!;
}

async function stop(capture: MockExtensionAPI, id: string): Promise<string> {
  return text(await tool(capture, "StopAgent").execute("stop-call", { agent_id: id }, undefined, undefined, ctx!));
}

function requests(remote: TestEndpoint): string[] {
  return remote.requests.map(({ method, path }) => `${method} ${path}`);
}

/** Everything the extension handed Pi as a completion notification. */
function nudges(capture: MockExtensionAPI): Nudge[] {
  return capture.api.sendMessage.mock.calls.map(([message, options]) => ({
    message: message as Nudge["message"],
    options,
  }));
}

async function settled(capture: MockExtensionAPI, count = 1): Promise<Nudge[]> {
  await vi.waitFor(() => expect(nudges(capture)).toHaveLength(count), { timeout: 8_000, interval: 20 });
  return nudges(capture);
}

/** Rows a rendered component produced, without the padding each row carries. */
function rendered(component: unknown): string {
  if (typeof component !== "object" || component === null || !("render" in component)) return "";
  if (typeof component.render !== "function") return "";
  const lines: unknown = (component.render as (width: number) => unknown)(240);
  return Array.isArray(lines)
    ? lines
        .filter((line): line is string => typeof line === "string")
        .map((line) => line.trimEnd())
        .join("\n")
    : "";
}

/** The card a reader of the session sees for one delivered message. */
function card(capture: MockExtensionAPI, message: Nudge["message"], expanded = true): string {
  const renderer = capture.messageRenderers.filter((entry) => entry.customType === "subagent-result").at(-1);
  expect(renderer, "Pi must be able to render a completion card").toBeDefined();
  return rendered(
    renderer!.renderer({ content: message.content, details: message.details }, { expanded }, defaultTheme),
  );
}

/** The live Workflow row, driven the way the tool call drives it. */
function resultRow(capture: MockExtensionAPI, args: Record<string, unknown>) {
  const registered = tool(capture);
  const state = {};
  const repaints: string[] = [];
  let snapshot: Result;
  function render(): string {
    const component = registered.renderResult?.(snapshot, { expanded: true }, defaultTheme, {
      args,
      state,
      expanded: true,
      isPartial: false,
      toolCallId: "workflow-call",
      invalidate: () => repaints.push(render()),
      cwd: ws.project,
      executionStarted: true,
      argsComplete: true,
      showImages: false,
      isError: snapshot.isError ?? false,
    });
    return rendered(component);
  }
  return {
    repaints,
    paint(result: Result): string {
      snapshot = result;
      return render();
    },
  };
}

describe("launching a workflow run in the background", () => {
  it("answers the caller with the run's id as soon as the endpoint admits it", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();

    const launched = await report(launch(capture));

    expect(launched.isError).toBe(false);
    expect(launched.text).toMatch(/running/i);
    expect(launched.text, "the server's own run id is how a person reads the run on the endpoint").toContain(
      remote.run,
    );
    expect(launched.text, "the launch never waits for the answer").not.toContain(ANSWER);
    const listed = await status(capture);
    expect(listed).toMatch(/audit workflow\) running/);
    expect(launched.text, "the launch names the id the caller addresses the run by").toContain(runId(listed));
    expect(stopRequests(remote)).toHaveLength(0);
    expect(nudges(capture), "nothing is delivered before the run settles").toEqual([]);
    remote.releaseStream();
  });

  it("tells the model what the parameter does instead of refusing it", async () => {
    const remote = await server();
    install(remote);
    const { capture } = await start();
    const parameter = tool(capture).parameters.properties.run_in_background as { description?: string } | undefined;

    expect(parameter?.description).toMatch(/\bid\b/i);
    expect(parameter?.description).toMatch(/notif/i);
    expect(parameter?.description ?? "").not.toMatch(/not supported/i);
    remote.releaseStream();
  });

  it("keeps the launch receipt on the row while the run is live", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();
    const row = resultRow(capture, { workflow: "audit", prompt: "Review changes", run_in_background: true });

    const launched = await launch(capture);
    const view = row.paint(launched);

    expect(view).toContain(runId(await status(capture)));
    expect(view).toMatch(/running/i);
    remote.releaseStream();
  });

  it("sends no stop for the run the launching turn abandons", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();
    const turn = new AbortController();

    await launch(capture, turn.signal);
    turn.abort();
    await vi.waitFor(() => expect(streamRequests(remote)).toHaveLength(1));

    expect(stopRequests(remote), "a background run is never bound to the turn that launched it").toHaveLength(0);
    expect(await status(capture)).toMatch(/audit workflow\) running/);
    remote.releaseStream();
  });

  it("stops only the run whose turn the interrupt belongs to", async () => {
    const detached = await server({ holdStream: true, streams: [DISPATCH] });
    const waited = await server({ holdStream: true, streams: [DISPATCH] });
    write(
      join(ws.agentDir, "workflows", "audit.yaml"),
      `${workflow("audit", "Inspect a repository")}endpoint: detached\n`,
    );
    write(join(ws.agentDir, "workflows", "report.yaml"), `${workflow("report", "Write a report")}endpoint: waited\n`);
    write(
      join(ws.agentDir, "subagents-lite.json"),
      JSON.stringify({
        workflows: {
          endpoints: { detached: { url: detached.url }, waited: { url: waited.url } },
          defaultEndpoint: "detached",
        },
      }),
    );
    const { capture } = await start();
    const turn = new AbortController();

    await launch(capture, turn.signal);
    const waiting = run(capture, { workflow: "report", prompt: "Write the report" }, turn.signal);
    await beforeEnd(waited.streamOpened, waiting, "the foreground run's stream opened");

    turn.abort();
    await waiting;

    expect(stopRequests(detached), "the run that was detached keeps running").toHaveLength(0);
    expect(stopRequests(waited), "an interrupt stops only the run whose turn it interrupted").toHaveLength(1);
  });
});

describe("the settlement notification", () => {
  it("delivers the published settlement text exactly once, labelled as a workflow", async () => {
    const remote = await server({ streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();
    const paints: Result[] = [];

    const launched = await launch(capture, undefined, (update) => paints.push(update));
    // The launch call has returned, so from this instant nothing may reach its `onUpdate` again -
    // every repaint until delivery included.
    const atLaunchReturn = [...paints];
    const [first] = await settled(capture);

    expect(first.message.content).toBe(`[Workflow "audit" ${runId(await status(capture))} completed]\n\n${ANSWER}`);
    expect(first.options, "an idle parent is woken by the notification").toEqual({ triggerTurn: true });
    expect(JSON.stringify(first.message)).not.toContain("input_tokens");
    expect(JSON.stringify(first.message)).not.toContain("final_answer");
    expect(text(launched), "the launch call was never the result").not.toContain(ANSWER);
    await vi.waitFor(() => expect(streamRequests(remote)).toHaveLength(1));
    expect(nudges(capture), "one settlement, one notification").toHaveLength(1);
    expect(paints, "a call that already returned receives no further updates").toEqual(atLaunchReturn);
  });

  it("renders as a workflow card carrying the run's own status and body", async () => {
    const remote = await server({ streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();

    await launch(capture);
    const [first] = await settled(capture);
    const rows = card(capture, first.message);

    expect(rows).toContain("Workflow Result");
    expect(rows).toContain("✓");
    expect(rows).toContain(ANSWER);
    expect(rows, "a remote run spent no tokens, so the card invents no stats").not.toMatch(/\d+ uses/);
  });

  it("commits a busy parent's settlement instead of queueing it", async () => {
    const remote = await server({ streams: [DISPATCH] });
    install(remote);
    const { capture } = await start({ parentIdle: false });

    await launch(capture);
    const [first] = await settled(capture);

    expect(first.options).toEqual({ triggerTurn: false });
    expect(first.message.content).toContain(ANSWER);
  });

  it("carries the run's real status when the caller stopped it", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();

    await launch(capture);
    await beforeEnd(remote.streamOpened, Promise.resolve(), "the run was streaming");
    await stop(capture, runId(await status(capture)));
    const [first] = await settled(capture);

    expect(first.message.content).toMatch(/^\[Workflow "audit" \w{8} stopped\]/);
    expect(first.message.content).toMatch(/stopp/i);
    expect(card(capture, first.message)).toContain("■");
  });

  it("delivers nothing into a session the run outlived", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture } = await start();
    const paints: Result[] = [];

    await launch(capture, undefined, (update) => paints.push(update));
    await beforeEnd(remote.streamOpened, Promise.resolve(), "the run was streaming");
    const sentBefore = requests(remote);
    const paintedBefore = [...paints];

    await shutdown();
    remote.releaseStream();
    await remote.streamSocketClosed();

    expect(requests(remote), "a detached run keeps no local work alive").toEqual(sentBefore);
    expect(stopRequests(remote), "US-30: teardown never stops a detached run").toHaveLength(0);
    expect(paints, "no update reaches a session that is gone").toEqual(paintedBefore);
    expect(nudges(capture), "no notification reaches a session that is gone").toEqual([]);
  });
});

describe("a workflow-only session watches its own runs", () => {
  it("refreshes a workflow row without any other driver", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    install(remote);
    const { capture, repaints, widgetText } = await start();

    await launch(capture);
    await vi.waitFor(() => expect(widgetText()).toContain("audit workflow"));

    const atRegistration = repaints.length;
    await vi.waitFor(() => expect(repaints.length).toBeGreaterThan(atRegistration + 1), { timeout: 4_000 });

    expect(widgetText()).toMatch(/audit workflow/);
    remote.releaseStream();
  });
});
