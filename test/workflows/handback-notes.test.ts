/**
 * handback-notes.test.ts — what the session is told when workflow monitoring cannot finish: the
 * hand-back note, the widget and AgentStatus rows that carry it while the settlement is still open,
 * which stop converts a waiting call and which one does not, and the silence kept when the caller
 * still holds the outcome. Driven through the registered tools over a scripted loopback endpoint,
 * with the application's timers under the test's control (`clockedLoopback`).
 */

import { rmSync } from "node:fs";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultTheme } from "../mock-utils.js";
import {
  beforeEnd,
  clockedLoopback,
  declaredOutputRead,
  deferred,
  DISPATCH,
  endpoint,
  errorBody,
  installWorkflow,
  readRequests,
  RECORDED,
  stateReply,
  stopRequests,
  workspace,
  type EndpointOptions,
  type TestEndpoint,
  type Workspace,
} from "./fixtures.js";
import {
  mockAgentDir,
  renderedRows,
  runId,
  startWorkflowSession,
  text,
  WORKFLOW_CALL,
  type Nudge,
  type WorkflowSession,
} from "./session.js";
import { claimsAStop } from "./note-words.js";

type Result = AgentToolResult<Record<string, unknown>>;
type Update = AgentToolUpdateCallback<Record<string, unknown>>;
type Exchanges = ReturnType<typeof clockedLoopback>;

const WORKFLOW = "audit";
const ARGS = { workflow: WORKFLOW, prompt: "Review changes" };
/** An endpoint that explains itself without letting the stream answer: the read is the only voice. */
const OUTAGE = { status: 503, body: errorBody("Temporarily unavailable") };
/** A stream that yields the dispatch and then nothing, so the read is what has to answer. */
const QUIET_STREAMS = [DISPATCH, "", "", "", "", "", ""];
/** The refusal the endpoint gives for a run it will not stop. */
const REFUSAL = { status: 409, body: errorBody("workflow is not running") };
/** The answer a live run's read carries: the run is running and has nothing to report yet. */
const RUNNING = stateReply({ status: "running" });
/** A stream that yields the dispatch and then nothing, as often as a live run gets it reopened. */
const ENDLESS_QUIET = [DISPATCH, ...Array.from({ length: 20 }, () => "")];
/** The declared answer the endpoint's captured read delivers. */
const ANSWER = RECORDED.answer;
/** How a hand-back note sends the caller off: the run's id, and the surface that reads it back. */
const checkLater = (id: string): string => `Check it later with AgentStatus using id ${id}.`;
/**
 * The note a run whose read budget ran out hands back. This run never requested a stop, so the note
 * says so, and it offers no handle the `Workflow` tool would reject.
 */
const readBudgetNote = (id: string): string =>
  `Workflow run ${id}: its state is unknown after 5 observations; ` +
  `nothing was stopped, and observation was handed back.\n${checkLater(id)}`;
/** A settlement the caller already holds reaches nobody else. */
const NO_NUDGE: Nudge[] = [];

let ws: Workspace;
let session: WorkflowSession | undefined;
let remotes: TestEndpoint[] = [];

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

/**
 * Start the session the way Pi does, widget host attached and first turn fired. The workflow file
 * and the endpoint config must be installed first: the session reads them as it starts.
 */
async function start(options: { parentIdle?: boolean } = {}): Promise<WorkflowSession> {
  session = await startWorkflowSession({ cwd: ws.project, parentIdle: options.parentIdle });
  return session;
}

async function server(options: EndpointOptions): Promise<TestEndpoint> {
  const remote = await endpoint(options);
  remotes.push(remote);
  return remote;
}

/** The registered `Workflow` tool, called with this file's one set of arguments. */
function run(of: WorkflowSession, signal?: AbortSignal, update?: Update): Promise<Result> {
  return of.run(ARGS, signal, update);
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

/** The call has been given back: it returned on the read the test delivered, with no further delay. */
async function handedOver(pending: Promise<Result>, reason: string): Promise<Result> {
  const handed = await Promise.race([pending, Promise.resolve(undefined)]);
  expect(handed, reason).toBeDefined();
  return handed!;
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
  return handedOver(pending, "the fifth failed read must hand the waiting call back");
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

/**
 * Assert the call is still waiting after five seconds of the pacing the client owes - long enough to
 * have included every read the client wanted next, short enough that a test whose scripted reads all
 * say `running` cannot have settled inside it.
 */
async function stillWaiting(pending: Promise<Result>, reason: string): Promise<void> {
  let waiting = true;
  void pending.then(() => {
    waiting = false;
  });
  await waited(5_000);
  expect(waiting, reason).toBe(true);
}

/** The last paint the call delivered: the row a reader of the session is looking at. */
function lastPaint(paints: Result[]): Result {
  const paint = paints.at(-1);
  expect(paint, "the run must have painted while it was observed").toBeDefined();
  return paint!;
}

/** The card's run row: what a reader of the session sees for the run at this paint. */
function row(of: WorkflowSession, paint: Result): string {
  const component = of.tool().renderResult?.(paint, { expanded: true }, defaultTheme, {
    args: ARGS,
    state: {},
    expanded: true,
    isPartial: false,
    toolCallId: WORKFLOW_CALL,
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

/** Wait on this file's own clock: `until` steps the virtual clock these runs are paced by. */
async function settled(of: WorkflowSession): Promise<Nudge[]> {
  await until(() => expect(of.nudges()).toHaveLength(1));
  return of.nudges();
}
describe("a run whose monitoring fails", () => {
  it("hands the call back, keeps the record running and notifies once when the run later settles", async () => {
    const remote = await server({
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), declaredOutputRead()],
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const pending = run(session);

    const handed = await handedBack(exchanges, remote, pending);
    const listing = await session.status();
    const id = runId(listing);
    expect(text(handed)).toBe(readBudgetNote(id));
    expect(listing, "the run is remote, so it stays listed and running").toMatch(
      new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`),
    );
    // The listing prints the note as its writer left it, routing line last: that last line is the
    // whole routing a note gives, and a listing that carried only the note's head would strand the
    // caller with no way back to the run.
    expect(listing.split("\n").slice(0, 2), "the listing carries both lines of the note").toEqual([
      `${id} (${WORKFLOW} workflow) running ${readBudgetNote(id).split("\n")[0]}`,
      checkLater(id),
    ]);
    expect(stopRequests(remote), "a failed read stops nothing").toHaveLength(0);
    expect(session.nudges(), "a run whose state is unknown has settled for no reason").toEqual(NO_NUDGE);

    // The read that answers after the hand-back is the settlement: the caller learns it once, as the
    // one message shape every settlement delivery has - the run's own header over its published text.
    await readAgain(exchanges, remote, 6);
    expect(await settled(session)).toEqual([
      {
        message: {
          customType: "subagent-result",
          content: `[Workflow "${WORKFLOW}" ${id} completed]\n\n${ANSWER}`,
          display: true,
          details: expect.objectContaining({ kind: "workflow", status: "completed" }),
        },
        options: { triggerTurn: true },
      },
    ]);
  }, 60_000);

  it("claims no stop in a note about a failed read", async () => {
    const remote = await server({ streams: QUIET_STREAMS, reads: Array.from({ length: 8 }, () => OUTAGE) });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const pending = run(session);

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await session.status());
    expect(text(handed)).toContain(readBudgetNote(id));
    expect(text(handed), "the run's remote id is the only handle the caller has").toContain(id);
    expect(claimsAStop(text(handed)), "a run that never asked to be stopped is not reported as stopped").toEqual([]);
    expect(stopRequests(remote)).toHaveLength(0);
    expect(row(session, handed), "the card for a handed-back call names no stop failure").not.toMatch(/stop failed/i);
  }, 60_000);

  it("clears the unknown note when a read says the run is live again", async () => {
    const remote = await server({
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), RUNNING],
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const pending = run(session);

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await session.status());
    expect(row(session, handed), "the note is on the row to be cleared").toContain(
      "state is unknown after 5 observations",
    );

    // The read that answers authoritatively ends the unknown, and nothing else follows: no further
    // progress frame, no settlement, no notification.
    await readAgain(exchanges, remote, 6);
    expect(row(session, handed), "the row is still the run's live row").toMatch(
      new RegExp(`^${id} \\(${WORKFLOW} workflow\\) running`),
    );
    expect(row(session, handed), "and it carries no unknown line").not.toMatch(/state is unknown/i);
    expect(await session.status(), "the listing reads the record, so the note is gone there too").not.toMatch(
      /state is unknown/i,
    );
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(session.nudges(), "a run that is known again has not settled").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "recovery stops nothing").toHaveLength(0);
  }, 60_000);

  it("keeps the stop failure ahead of the unknown state, and through a read that says the run is live", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), RUNNING],
      stopRejection: REFUSAL,
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(session, esc.signal, (update) => {
      paints.push(update!);
      live.resolve();
    });

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    const handed = await returned(pending, "a call whose stop was refused is handed back");
    const id = runId(await session.status());
    expect(text(handed)).toContain(`Workflow "${WORKFLOW}" ${id}: stop failed - HTTP 409: workflow is not running.`);

    // The outage continues after the hand-back: the unknown state must not bury the stop failure.
    for (const ordinal of [1, 2, 3, 4, 5]) {
      if (ordinal > 1) await vi.advanceTimersByTimeAsync([2_000, 4_000, 8_000, 16_000][ordinal - 2]!);
      await readReply(exchanges, remote, ordinal);
    }
    expect(row(session, lastPaint(paints)), "the row carries the note while the settlement is still open").toContain(
      "stop failed",
    );
    expect(await session.status()).toContain("stop failed");
    expect(await session.status()).not.toMatch(/unknown/i);

    // The read that says the run is live changes nothing about a standing stop failure: only
    // settlement clears it. Still no notification, still one stop request, still the same note.
    await readAgain(exchanges, remote, 6);
    expect(row(session, lastPaint(paints)), "the standing note outlives the read that says the run is live").toContain(
      "stop failed",
    );
    expect(row(session, lastPaint(paints))).toMatch(new RegExp(`^${id} \\(${WORKFLOW} workflow\\) running`));
    expect(await session.status()).toContain("stop failed");
    expect(await session.status(), "the endpoint answered, so the state is no longer unknown").not.toMatch(/unknown/i);
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(session.nudges(), "a recovered run is not an outcome the parent is notified of").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "a run whose stop was refused is not stopped again").toHaveLength(1);
  }, 60_000);

  it("shows the note on the widget row while the settlement is still open", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: Array.from({ length: 8 }, () => OUTAGE),
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(session, undefined, (update) => {
      paints.push(update!);
      live.resolve();
    });
    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    const id = runId(await session.status());
    // Read the row while the record still holds no note: after the hand-back a row that reads the
    // record - which is what 2-2 builds - paints the note for any snapshot it is given.
    const beforeNote = row(session, lastPaint(paints));

    const handed = await handedBack(exchanges, remote, pending, 90_000);
    expect(session.widgetText(), "the widget lists the run the caller no longer holds").toContain(id);
    expect(beforeNote, "the row before the note is the plain live row").toMatch(
      new RegExp(`^${id} \\(${WORKFLOW} workflow\\) running`),
    );
    expect(beforeNote, "the row a reader sees before the note was written names no failure").not.toMatch(
      /state is unknown/i,
    );
    expect(row(session, handed), "the row carries the note the caller needs").toContain(
      "state is unknown after 5 observations",
    );
    expect(row(session, handed), "the whole note rides this one row, to its last line").toContain(checkLater(id));
    // Observation continues on the read channel: the hand-back carries the delay its failed reads
    // owed, and the reads resume after it. No stream reopens - the last known state is unknown, and
    // only an authoritative `running` read makes it running again (ADR-0013, US-19).
    await readAgain(exchanges, remote, 6);
    expect(readRequests(remote).length, "observation continues after the hand-back").toBeGreaterThan(5);
  }, 60_000);
});

describe("a stop the endpoint did not confirm", () => {
  it("hands an interrupted call back with the stop failure and nothing else", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [RUNNING],
      stopRejection: REFUSAL,
    });
    installWorkflow(ws, remote);
    const session = await start();
    clockedLoopback();
    const esc = new AbortController();
    const paints: Result[] = [];
    const live = deferred<void>();
    const pending = run(session, esc.signal, (update) => {
      paints.push(update!);
      live.resolve();
    });

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    const handed = await returned(pending, "a call whose stop was refused is handed back");
    const id = runId(await session.status());
    expect(text(handed)).toBe(
      `Workflow "${WORKFLOW}" ${id}: stop failed - HTTP 409: workflow is not running. ` +
        `Nothing was stopped, and this session has not seen the run end.\n${checkLater(id)}`,
    );
    expect(claimsAStop(text(handed)), "a stop the endpoint refused is never reported as done").toEqual([]);
    expect(text(handed), "the failure was the stop, not the state").not.toMatch(/unknown/i);
    expect(text(handed), "an endpoint that refused the stop supplied no run state to publish").not.toMatch(
      /running remotely/i,
    );
    expect(row(session, lastPaint(paints)), "the row carries the stop failure").toContain("stop failed");
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(await session.status()).toContain("stop failed");
    expect(session.nudges(), "a run the endpoint refuses to stop has not settled").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "an interrupted call whose stop was refused stops nothing further").toHaveLength(1);
  }, 60_000);

  it("hands back the call whose parent interrupt the endpoint did not confirm", async () => {
    const remote = await server({
      holdStream: true,
      streams: QUIET_STREAMS,
      reads: [RUNNING, declaredOutputRead()],
      stopOutcome: "interrupted",
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const esc = new AbortController();
    const live = deferred<void>();
    const pending = run(session, esc.signal, () => live.resolve());

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    const id = runId(await session.status());
    esc.abort();
    await beforeEnd(remote.stopReceived, pending, "stop request to arrive");
    remote.releaseStream();
    // The acknowledgement says the runner is gone, the deciding read says the run is live, and the
    // parent interrupt that asked for the stop is spent: the wait cannot be kept.
    await readReply(exchanges, remote, 1);
    const handed = await handedOver(pending, "the read that says the run is live hands the interrupted call back");
    const note = text(handed);

    expect(session.nudges(), "a hand-back is not a settlement").toEqual(NO_NUDGE);
    expect(note, "the caller keeps the id the run is addressed by").toContain(id);
    expect(note, "what the endpoint did not confirm was the stop").toMatch(/stop/i);
    expect(note, "the run is still live on the endpoint").toMatch(/still running remotely/i);
    expect(note, "the outcome is promised as a notification").toMatch(/notification/i);
    expect(note, "the promise holds only while this session stays open").toMatch(/this session/i);
    expect(note, "and it routes the caller back to AgentStatus, like every other note").toContain(checkLater(id));
    expect(claimsAStop(note), "a stop the endpoint did not confirm is never reported as done").toEqual([]);
    expect(note, "the note sends the caller to no handle the tool would reject").not.toContain("wait_for");
    expect(row(session, handed), "the note paints as the run's live health").toContain("still running remotely");
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(stopRequests(remote), "the interrupted turn's stop is sent once").toHaveLength(1);

    // Observation continues, and the read that answers is notified exactly once - in the one shape
    // every settlement delivery has.
    await vi.advanceTimersByTimeAsync(2_000);
    await readReply(exchanges, remote, 2);
    expect(await settled(session)).toEqual([
      {
        message: {
          customType: "subagent-result",
          content: `[Workflow "${WORKFLOW}" ${id} completed]\n\n${ANSWER}`,
          display: true,
          details: expect.objectContaining({ kind: "workflow", status: "completed" }),
        },
        options: { triggerTurn: true },
      },
    ]);
  }, 60_000);

  it("answers the call whose stop the caller asked for by hand, and notifies nobody", async () => {
    const remote = await server({
      holdStream: true,
      streams: ENDLESS_QUIET,
      reads: [...Array.from({ length: 12 }, () => RUNNING), declaredOutputRead()],
      stopOutcome: "interrupted",
    });
    installWorkflow(ws, remote);
    const session = await start({ parentIdle: false });
    const exchanges = clockedLoopback();
    const turn = new AbortController();
    const live = deferred<void>();
    const pending = run(session, turn.signal, () => live.resolve());

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    const id = runId(await session.status());
    // A stop the caller asked for while its turn is still running: nothing here aborts the parent
    // signal, and that is what separates it from the Esc above.
    await session.stop(id);
    await beforeEnd(remote.stopReceived, pending, "the hand-requested stop to arrive");
    remote.releaseStream();
    // The dead-runner acknowledgement is a GET trigger, and the read says the run is live: the call
    // keeps waiting for the run, and a run that is waited for is never enrolled for a notification.
    await readReply(exchanges, remote, 1);
    await stillWaiting(pending, "a hand-requested stop of a run the read says is live keeps its call waiting");
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));

    // Twelve reads say `running`, then one answers: the settlement lands in the call that waited.
    const settledInline = text(await returned(pending, "the read that answers settles the waiting call"));
    expect(settledInline).toBe(ANSWER);
    expect(session.nudges(), "the caller holds the outcome, so the parent is not told").toEqual(NO_NUDGE);
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) completed`));
    expect(stopRequests(remote), "the hand-requested stop is sent once").toHaveLength(1);
  }, 60_000);

  it("hands back the call once when the interrupt overtakes the hand-requested stop", async () => {
    // The third order, on this file's endpoint script: the same dead-runner acknowledgement and the
    // same live read as the test above, with one difference - the parent interrupt lands while the
    // hand-requested stop is still on the wire. Only that signal converts the wait, so the call is
    // handed back once and enrolled, and the in-flight stop stays the only request the endpoint sees.
    const remote = await server({
      holdStream: true,
      holdStop: true,
      streams: QUIET_STREAMS,
      reads: [RUNNING, declaredOutputRead()],
      stopOutcome: "interrupted",
    });
    installWorkflow(ws, remote);
    const session = await start({ parentIdle: false });
    const exchanges = clockedLoopback();
    const turn = new AbortController();
    const live = deferred<void>();
    const pending = run(session, turn.signal, () => live.resolve());

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    const id = runId(await session.status());
    await session.stop(id);
    await beforeEnd(remote.stopReceived, pending, "the hand-requested stop to be on the wire");

    turn.abort();
    remote.releaseStop();
    remote.releaseStream();
    await readReply(exchanges, remote, 1);
    const handed = await handedOver(pending, "the interrupt that overtook the stop hands the call back");

    expect(text(handed), "what failed was the stop, so the note is the interrupted one").toMatch(/not confirmed/i);
    expect(text(handed)).toContain(checkLater(id));
    expect(claimsAStop(text(handed)), "a stop the endpoint did not confirm is never reported as done").toEqual([]);
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(session.nudges(), "a hand-back is not a settlement").toEqual(NO_NUDGE);
    expect(stopRequests(remote), "the interrupt adds no stop to the one already on the wire").toHaveLength(1);

    // Enrolled: the read that answers is the run's one notification, committed to the busy parent.
    await vi.advanceTimersByTimeAsync(2_000);
    await readReply(exchanges, remote, 2);
    expect(await settled(session)).toEqual([
      {
        message: {
          customType: "subagent-result",
          content: `[Workflow "${WORKFLOW}" ${id} completed]\n\n${ANSWER}`,
          display: true,
          details: expect.objectContaining({ kind: "workflow", status: "completed" }),
        },
        options: { triggerTurn: false },
      },
    ]);
  }, 60_000);

  it("keeps a hand-stopped run bound to the interrupt its caller never raised", async () => {
    // Same acknowledgement, same live read, no interrupt yet: the call waits (the test above), and so
    // does the parent binding. An interrupt that arrives later is therefore still a stop request -
    // the second one the endpoint sees - and only then is the call handed back.
    const remote = await server({
      holdStream: true,
      streams: ENDLESS_QUIET,
      reads: [...Array.from({ length: 12 }, () => RUNNING), declaredOutputRead()],
      stopOutcome: "interrupted",
    });
    installWorkflow(ws, remote);
    const session = await start({ parentIdle: false });
    const exchanges = clockedLoopback();
    const turn = new AbortController();
    const live = deferred<void>();
    const pending = run(session, turn.signal, () => live.resolve());

    await beforeEnd(live.promise, pending, "the held stream painted live progress");
    const id = runId(await session.status());
    await session.stop(id);
    await beforeEnd(remote.stopReceived, pending, "the hand-requested stop to arrive");
    remote.releaseStream();
    await readReply(exchanges, remote, 1);
    await stillWaiting(pending, "a hand-requested stop with no interrupt keeps its call waiting");
    expect(stopRequests(remote)).toHaveLength(1);

    turn.abort();
    await until(() => expect(stopRequests(remote)).toHaveLength(2));
    const handed = await returned(pending, "the later interrupt reaches the run that is still bound");

    expect(text(handed)).toMatch(/not confirmed/i);
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) running`));
    expect(stopRequests(remote), "the binding answers its own stop, once").toHaveLength(2);
  }, 60_000);

  it("lands a settlement queued at teardown in no session, old or replacement", async () => {
    // The batch owns its message for 200 ms before Pi sees it. A teardown that lands inside that
    // window voids the delivery: the gone session receives nothing, and neither does the session that
    // replaces it, because the flushed message would travel on the shell's current pi.
    const remote = await server({ streams: QUIET_STREAMS, reads: [declaredOutputRead()] });
    installWorkflow(ws, remote);
    const session = await start({ parentIdle: false });
    const exchanges = clockedLoopback();

    const launched = await session.run({ ...ARGS, run_in_background: true });
    expect(launched.isError ?? false).toBe(false);
    const id = runId(await session.status());
    await readReply(exchanges, remote, 1);
    // The run has settled and its delivery is queued; the batch window has not been advanced.
    expect(await session.status()).toMatch(new RegExp(`${id} \\(${WORKFLOW} workflow\\) completed`));
    expect(session.nudges(), "the settlement is still inside the batch window").toEqual(NO_NUDGE);

    // No clock step between the teardown and the replacement session: if the queued delivery
    // survived, it would travel on the shell's current pi - the replacement's.
    await session.shutdown();
    const replacement = await start({ parentIdle: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(session.nudges(), "the session that ended receives no settlement").toEqual(NO_NUDGE);
    expect(replacement.nudges(), "US-30: no settlement arrives in the session that replaced it").toEqual(NO_NUDGE);
    expect(await replacement.status(), "a torn-down run leaves no record behind").not.toContain(id);
  }, 60_000);

  it("stops nothing further when the session ends around a run whose observation was handed back", async () => {
    const remote = await server({
      streams: QUIET_STREAMS,
      reads: [...Array.from({ length: 5 }, () => OUTAGE), RUNNING],
    });
    installWorkflow(ws, remote);
    const session = await start();
    const exchanges = clockedLoopback();
    const pending = run(session);

    const handed = await handedBack(exchanges, remote, pending);
    const id = runId(await session.status());
    expect(text(handed)).toContain(id);
    expect(stopRequests(remote)).toHaveLength(0);

    await readAgain(exchanges, remote, 6);
    expect(session.nudges(), "a run the endpoint says is live gets no completion notification").toEqual(NO_NUDGE);

    await session.shutdown();
    expect(stopRequests(remote), "a run whose state is unknown stops nothing on cleanup").toHaveLength(0);
    const reopened = await start();
    expect(await reopened.status(), "a run whose state was never confirmed is not a live local run").not.toContain(id);
    expect(stopRequests(remote)).toHaveLength(0);
  }, 60_000);
});
