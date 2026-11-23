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
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultTheme } from "../mock-utils.js";
import {
  beforeEnd,
  DISPATCH,
  endpoint,
  installWorkflow,
  stopRequests,
  streamRequests,
  workspace,
  write,
  workflow,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";
import {
  mockAgentDir,
  rendered,
  report,
  runId,
  startWorkflowSession,
  text,
  WORKFLOW_CALL,
  type Nudge,
  type WorkflowSession,
} from "./session.js";

const ANSWER = "The declared output";

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;

let ws: Workspace;
let session: WorkflowSession | undefined;
let remotes: TestEndpoint[];

beforeEach(() => {
  ws = workspace();
  remotes = [];
  mockAgentDir(ws);
});

afterEach(async () => {
  await session?.shutdown();
  for (const remote of remotes) await remote.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("@earendil-works/pi-coding-agent");
  session = undefined;
  rmSync(ws.root, { recursive: true, force: true });
});

/** Start the session, and count the repaints its widget asks for: the refresh timer's evidence. */
async function start(options: { parentIdle?: boolean } = {}) {
  const repaints: number[] = [];
  session = await startWorkflowSession({
    cwd: ws.project,
    parentIdle: options.parentIdle,
    requestRender: () => repaints.push(repaints.length),
  });
  return { session, repaints };
}

async function server(options?: EndpointOptions): Promise<TestEndpoint> {
  const remote = await endpoint(options);
  remotes.push(remote);
  return remote;
}

function run(
  of: WorkflowSession,
  params: Record<string, unknown> = { workflow: "audit", prompt: "Review changes" },
  signal?: AbortSignal,
  update?: Update,
): Promise<Result> {
  return of.run(params, signal, update);
}

/** The same call, launched detached. */
function launch(of: WorkflowSession, signal?: AbortSignal, update?: Update): Promise<Result> {
  return run(of, { workflow: "audit", prompt: "Review changes", run_in_background: true }, signal, update);
}

function requests(remote: TestEndpoint): string[] {
  return remote.requests.map(({ method, path }) => `${method} ${path}`);
}

/** Wait on the real clock: these runs settle on their own, with no clock under the test. */
async function settled(of: WorkflowSession): Promise<Nudge[]> {
  await vi.waitFor(() => expect(of.nudges()).toHaveLength(1), { timeout: 8_000, interval: 20 });
  return of.nudges();
}

/** The card a reader of the session sees for one delivered message. */
function card(of: WorkflowSession, message: Nudge["message"], expanded = true): string {
  const renderer = of.capture.messageRenderers.filter((entry) => entry.customType === "subagent-result").at(-1);
  expect(renderer, "Pi must be able to render a completion card").toBeDefined();
  // A settlement's details are what the sender handed Pi; the captured renderer reads them as a record.
  const details = message.details as Record<string, unknown> | undefined;
  return rendered(renderer!.renderer({ content: message.content, details }, { expanded }, defaultTheme));
}

/** The live Workflow row, driven the way the tool call drives it. */
function resultRow(of: WorkflowSession, args: Record<string, unknown>) {
  const registered = of.tool();
  const state = {};
  const repaints: string[] = [];
  let snapshot: Result;
  function render(): string {
    const component = registered.renderResult?.(snapshot, { expanded: true }, defaultTheme, {
      args,
      state,
      expanded: true,
      isPartial: false,
      toolCallId: WORKFLOW_CALL,
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
    installWorkflow(ws, remote);
    const { session } = await start();

    const launched = await report(launch(session));

    expect(launched.isError).toBe(false);
    expect(launched.text).toMatch(/running/i);
    expect(launched.text, "the server's own run id is how a person reads the run on the endpoint").toContain(
      remote.run,
    );
    expect(launched.text, "the launch never waits for the answer").not.toContain(ANSWER);
    const listed = await session.status();
    expect(listed).toMatch(/audit workflow\) running/);
    expect(launched.text, "the launch names the id the caller addresses the run by").toContain(runId(listed));
    expect(stopRequests(remote)).toHaveLength(0);
    expect(session.nudges(), "nothing is delivered before the run settles").toEqual([]);
    remote.releaseStream();
  });

  it("tells the model what the parameter does instead of refusing it", async () => {
    const remote = await server();
    installWorkflow(ws, remote);
    const { session } = await start();
    const parameter = session.tool().parameters.properties.run_in_background as { description?: string } | undefined;

    expect(parameter?.description).toMatch(/\bid\b/i);
    expect(parameter?.description).toMatch(/notif/i);
    expect(parameter?.description ?? "").not.toMatch(/not supported/i);
    remote.releaseStream();
  });

  it("keeps the launch receipt on the row while the run is live", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start();
    const row = resultRow(session, { workflow: "audit", prompt: "Review changes", run_in_background: true });

    const launched = await launch(session);
    const view = row.paint(launched);

    expect(view).toContain(runId(await session.status()));
    expect(view).toMatch(/running/i);
    remote.releaseStream();
  });

  it("sends no stop for the run the launching turn abandons", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start();
    const turn = new AbortController();

    await launch(session, turn.signal);
    turn.abort();
    await vi.waitFor(() => expect(streamRequests(remote)).toHaveLength(1));

    expect(stopRequests(remote), "a background run is never bound to the turn that launched it").toHaveLength(0);
    expect(await session.status()).toMatch(/audit workflow\) running/);
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
    const { session } = await start();
    const turn = new AbortController();

    await launch(session, turn.signal);
    const waiting = run(session, { workflow: "report", prompt: "Write the report" }, turn.signal);
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
    installWorkflow(ws, remote);
    const { session } = await start();
    const paints: Result[] = [];

    const launched = await launch(session, undefined, (update) => paints.push(update));
    // The launch call has returned, so from this instant nothing may reach its `onUpdate` again -
    // every repaint until delivery included.
    const atLaunchReturn = [...paints];
    const [first] = await settled(session);

    expect(first.message.content).toBe(`[Workflow "audit" ${runId(await session.status())} completed]\n\n${ANSWER}`);
    expect(first.options, "an idle parent is woken by the notification").toEqual({ triggerTurn: true });
    expect(JSON.stringify(first.message)).not.toContain("input_tokens");
    expect(JSON.stringify(first.message)).not.toContain("final_answer");
    expect(text(launched), "the launch call was never the result").not.toContain(ANSWER);
    await vi.waitFor(() => expect(streamRequests(remote)).toHaveLength(1));
    expect(session.nudges(), "one settlement, one notification").toHaveLength(1);
    expect(paints, "a call that already returned receives no further updates").toEqual(atLaunchReturn);
  });

  it("renders as a workflow card carrying the run's own status and body", async () => {
    const remote = await server({ streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start();

    await launch(session);
    const [first] = await settled(session);
    const rows = card(session, first.message);

    expect(rows).toContain("Workflow Result");
    expect(rows).toContain("✓");
    expect(rows).toContain(ANSWER);
    expect(rows, "a remote run spent no tokens, so the card invents no stats").not.toMatch(/\d+ uses/);
  });

  it("commits a busy parent's settlement instead of queueing it", async () => {
    const remote = await server({ streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start({ parentIdle: false });

    await launch(session);
    const [first] = await settled(session);

    expect(first.options).toEqual({ triggerTurn: false });
    expect(first.message.content).toContain(ANSWER);
  });

  it("carries the run's real status when the caller stopped it", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start();

    await launch(session);
    // A launch never ends, so this wait has no run to fail it: the milestone is awaited whole.
    await remote.streamOpened;
    await session.stop(runId(await session.status()));
    const [first] = await settled(session);

    expect(first.message.content).toMatch(/^\[Workflow "audit" \w{8} stopped\]/);
    expect(first.message.content).toMatch(/stopp/i);
    expect(card(session, first.message)).toContain("■");
  });

  it("delivers nothing into a session the run outlived", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session } = await start();
    const paints: Result[] = [];

    await launch(session, undefined, (update) => paints.push(update));
    // A launch never ends, so this wait has no run to fail it: the milestone is awaited whole.
    await remote.streamOpened;
    const sentBefore = requests(remote);
    const paintedBefore = [...paints];

    await session.shutdown();
    remote.releaseStream();
    await remote.streamSocketClosed();

    expect(requests(remote), "a detached run keeps no local work alive").toEqual(sentBefore);
    expect(stopRequests(remote), "US-30: teardown never stops a detached run").toHaveLength(0);
    expect(paints, "no update reaches a session that is gone").toEqual(paintedBefore);
    expect(session.nudges(), "no notification reaches a session that is gone").toEqual([]);
  });
});

describe("a workflow-only session watches its own runs", () => {
  it("refreshes a workflow row without any other driver", async () => {
    const remote = await server({ holdStream: true, streams: [DISPATCH] });
    installWorkflow(ws, remote);
    const { session, repaints } = await start();

    await launch(session);
    await vi.waitFor(() => expect(session.widgetText()).toContain("audit workflow"));

    const atRegistration = repaints.length;
    await vi.waitFor(() => expect(repaints.length).toBeGreaterThan(atRegistration + 1), { timeout: 4_000 });

    expect(session.widgetText()).toMatch(/audit workflow/);
    remote.releaseStream();
  });
});
