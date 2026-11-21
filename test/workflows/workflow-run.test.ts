/**
 * workflow-run.test.ts — The foreground run: the record, the observation loop, settlement.
 *
 * The seam is the execution entry the `Workflow` tool calls, with a fake `WorkflowClient` injected
 * at its port and the real AgentManager owning the record, so the races an endpoint cannot be timed
 * for (a stop ack against a settling observation, a hand-back that keeps watching) are driven
 * directly. The wire itself is the acceptance suite's job.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { runWorkflowForeground, type WorkflowRunArgs } from "../../src/workflows/workflow-run.js";
import type {
  WorkflowClient,
  WorkflowOutcome,
  WorkflowStop,
  WorkflowView,
} from "../../src/workflows/workflow-client.js";
import { mintEndpoint } from "./fixtures.js";
import { expectGatePending } from "./gate-assertions.js";

const ENDPOINT = mintEndpoint("http://127.0.0.1:4100");
const KEY = "sekrit-endpoint-value";
const WITH_KEY = mintEndpoint("http://127.0.0.1:4100", KEY);
const REMOTE_ID = "wf-remote-1";
const DECLARED = { text: "The declared output", termination_reason: "final_answer", usage: {} };

type Result = AgentToolResult<Record<string, unknown>>;

/** The create answer the endpoint gives: the run's remote id, or the reason it refused. */
type WorkflowCreate = Awaited<ReturnType<WorkflowClient["create"]>>;

/** A client whose every answer the test hands over by hand. */
interface FakeClient extends WorkflowClient {
  creates: { prompt: string; definition: Record<string, unknown>; workingDir: string }[];
  /** One entry per `monitor` call, in order: the view each call was given. */
  views: WorkflowView[];
  stops: number;
  /** The signal each stop request was given, in order. */
  stopSignals: (AbortSignal | undefined)[];
  /** Settle the oldest waiting monitor with its outcome; a monitor waits until this or a cancel. */
  settleMonitor(outcome: WorkflowOutcome): void;
  /** Hand over the held create answer. */
  releaseCreate(create?: WorkflowCreate): void;
  /** Hand over the held stop answer. */
  releaseStop(stop: WorkflowStop): void;
  /** Change what the endpoint answers a stop request with. */
  answerStop(stop: WorkflowStop): void;
}

interface FakeOptions {
  create?: { ok: true; workflowId: string; taskId: string } | { ok: false; error: string };
  /** Hold the create answer until `releaseCreate`, so a shutdown can overtake it. */
  holdCreate?: boolean;
  /** Hold the stop answer until `releaseStop`, so a shutdown can overtake that too. */
  holdStop?: boolean;
  stop?: WorkflowStop;
}

function fakeClient(options: FakeOptions = {}): FakeClient {
  const creates: FakeClient["creates"] = [];
  const views: WorkflowView[] = [];
  const stopSignals: (AbortSignal | undefined)[] = [];
  const waiters = new Set<(outcome: WorkflowOutcome) => void>();
  let heldCreate: ((create: WorkflowCreate) => void) | undefined;
  let heldStop: ((stop: WorkflowStop) => void) | undefined;
  let stopAnswer = options.stop ?? { ok: true, status: "stopped" };
  const client: FakeClient = {
    creates,
    views,
    stops: 0,
    stopSignals,
    async create(request) {
      creates.push({ prompt: request.prompt, definition: request.definition, workingDir: request.workingDir });
      if (!options.holdCreate) return options.create ?? { ok: true, workflowId: REMOTE_ID, taskId: REMOTE_ID };
      return new Promise<WorkflowCreate>((resolve) => {
        heldCreate = resolve;
      });
    },
    releaseCreate(create = { ok: true, workflowId: REMOTE_ID, taskId: REMOTE_ID }) {
      const answer = heldCreate;
      heldCreate = undefined;
      answer?.(create);
    },
    monitor(_id, view) {
      views.push(view);
      return new Promise<WorkflowOutcome>((resolve) => {
        let answered = false;
        const answer = (outcome: WorkflowOutcome) => {
          if (answered) return;
          answered = true;
          waiters.delete(answer);
          resolve(outcome);
        };
        if (view.signal?.aborted) {
          answer({ status: "aborted" });
          return;
        }
        waiters.add(answer);
        view.signal?.addEventListener("abort", () => answer({ status: "aborted" }), { once: true });
      });
    },
    answerStop(stop) {
      stopAnswer = stop;
    },
    releaseStop(stop) {
      const answer = heldStop;
      heldStop = undefined;
      answer?.(stop);
    },
    async stop(_id, signal) {
      client.stops += 1;
      stopSignals.push(signal);
      if (!options.holdStop) return stopAnswer;
      // The transport ends a cancelled wait as a failed stop; the endpoint's late answer cannot.
      return new Promise<WorkflowStop>((resolve) => {
        heldStop = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "the stop request was cancelled" }), {
          once: true,
        });
      });
    },
    settleMonitor(outcome) {
      waiters.values().next().value?.(outcome);
    },
  };
  return client;
}

function run(
  client: WorkflowClient,
  manager = new AgentManager(),
  overrides: Partial<WorkflowRunArgs> = {},
): Promise<Result> {
  return runWorkflowForeground(
    {
      name: "audit",
      endpoint: ENDPOINT,
      definition: { name: "audit", nodes: [] },
      prompt: "Review changes",
      workingDir: "/srv/checkout",
      toolCallId: "call-1",
      ...overrides,
    },
    { manager, client },
  );
}

function text(result: Result): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** What an update paints: the progress snapshot the details carry, then the outcome text. */
function painted(update: Result): string {
  const progress = (update.details?.progress as string[] | undefined) ?? [];
  return [...progress, ...text(update).split("\n")].filter((line) => line !== "").join("\n");
}

/** The view lines a run published, in order. */
function showPublished(): { views: string[]; publish: (update: Result) => void } {
  const views: string[] = [];
  return { views, publish: (update) => views.push(painted(update)) };
}

async function started(client: FakeClient): Promise<WorkflowView> {
  await vi.waitFor(() => expect(client.views.length).toBeGreaterThan(0));
  return client.views.at(-1)!;
}

describe("a foreground run's record and result", () => {
  it("asks the endpoint for the run with the frozen definition and working directory", async () => {
    const client = fakeClient();

    void run(client);

    expect(client.creates).toEqual([
      { prompt: "Review changes", definition: { name: "audit", nodes: [] }, workingDir: "/srv/checkout" },
    ]);
  });

  it("settles with the server's terminal result, beside the progress the stream carried", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const shown = showPublished();

    const pending = run(client, manager, { onUpdate: shown.publish });
    const view = await started(client);
    view.onUpdate([{ type: "node-status", node: "analysis", status: "completed" }]);
    client.settleMonitor({ status: "completed", result: DECLARED });

    const result = await pending;

    expect(text(result)).toBe("The declared output");
    expect(result.isError ?? false).toBe(false);
    expect(result.details?.agentId).toBeTypeOf("string");
    const record = manager.listAgents()[0];
    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("The declared output");
    expect(record.error).toBeUndefined();
    expect(record.workflow).toEqual({
      name: "audit",
      endpoint: "local",
      url: "http://127.0.0.1:4100",
      remoteId: REMOTE_ID,
      progress: ["\u2713 analysis completed"],
    });
    expect(shown.views.at(-1)).toBe("✓ analysis completed\nThe declared output");
  });

  // The text the parent agent reads is the declared answer, so everything else the producer sent -
  // a local handler's own payload, a Pi run's transcript - would be lost to everyone if the text were
  // the only copy. `details` is what the UI and the export read and the model never reads.
  it("keeps the whole value the producer sent in the details the UI and the export read", async () => {
    const client = fakeClient();
    const pending = run(client);
    await started(client);
    const value = { text: "The declared output", result: { deployed: true }, usage: { input_tokens: 5 } };
    client.settleMonitor({ status: "completed", result: value });

    const result = await pending;

    expect(text(result)).toBe("The declared output");
    expect(result.details?.result).toEqual(value);
  });

  it("carries no result value for a run that produced none", async () => {
    const client = fakeClient();
    const pending = run(client);
    await started(client);
    client.settleMonitor({ status: "failed", error: "the node died" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect("result" in (result.details ?? {})).toBe(false);
  });

  // The record's two URL copies are what the widget, the running-agents menu, the conversation viewer
  // and the details export show, and none of them holds this run's publisher: they are written already
  // safe, as one display value shared with the fault text (US-35). A prefix that carries the run's
  // credential never reaches here - resolution refuses that configuration outright.
  for (const { name, url, apiKey, expectedUrl, hidden } of [
    {
      name: "records a prefix that carries no credential whole in both display copies",
      url: "http://127.0.0.1:4100/gateway/v1",
      apiKey: KEY,
      expectedUrl: "http://127.0.0.1:4100/gateway/v1",
      hidden: [KEY],
    },
  ]) {
    it(name, async () => {
      const manager = new AgentManager();
      const client = fakeClient();
      const pending = run(client, manager, { endpoint: mintEndpoint(url, apiKey) });
      await started(client);
      client.settleMonitor({ status: "completed", result: DECLARED });
      await pending;

      const record = manager.listAgents()[0];
      expect(record.workflow?.url).toBe(expectedUrl);
      expect(record.display.description).toBe(expectedUrl);
      const serialized = JSON.stringify(record);
      for (const secret of hidden) expect(serialized).not.toContain(secret);
    });
  }

  it("settles a failed run as an error record carrying the endpoint's reason", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "failed", error: "validator rejected the diff" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("validator rejected the diff");
    const record = manager.listAgents()[0];
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("Workflow run failed: validator rejected the diff");
    expect(record.result).toBeUndefined();
  });

  it("keeps the endpoint's key out of the reason a failed run answers and records", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager, { endpoint: WITH_KEY });
    await started(client);
    client.settleMonitor({ status: "failed", error: `Node died holding ${KEY}` });

    const result = await pending;

    expect(text(result)).toContain("Node died holding [redacted]");
    expect(text(result)).not.toContain(KEY);
    expect(manager.listAgents()[0].error).not.toContain(KEY);
  });

  it("keeps the endpoint's key out of the terminal result it answers and records", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager, { endpoint: WITH_KEY });
    await started(client);
    client.settleMonitor({
      status: "completed",
      result: { text: `echo of ${KEY}`, termination_reason: "final_answer" },
    });

    const result = await pending;

    expect(text(result)).toBe("echo of [redacted]");
    expect(manager.listAgents()[0].result).toBe("echo of [redacted]");
  });

  it("keeps the endpoint's key out of the progress lines it publishes", async () => {
    const client = fakeClient();
    const shown = showPublished();

    const pending = run(client, new AgentManager(), { endpoint: WITH_KEY, onUpdate: shown.publish });
    const view = await started(client);
    view.onUpdate([{ type: "text", node: "analysis", text: `echo of ${KEY}` }]);
    client.settleMonitor({ status: "completed", result: null });

    await pending;

    expect(shown.views.join("\n")).toContain("echo of [redacted]");
    expect(shown.views.join("\n")).not.toContain(KEY);
  });

  it("keeps the endpoint's key out of the note an unreadable read hands back", async () => {
    const client = fakeClient();

    const pending = run(client, new AgentManager(), { endpoint: WITH_KEY });
    await started(client);
    client.settleMonitor({ status: "degraded", error: `Read refused while holding ${KEY}` });

    const result = await pending;

    expect(text(result)).toBe("Read refused while holding [redacted]");
  });

  it("keeps the endpoint's key out of the refusal a rejected create answers with", async () => {
    const client = fakeClient({ create: { ok: false, error: `Rejected: ${KEY} is not allowed` } });

    const result = await run(client, new AgentManager(), { endpoint: WITH_KEY });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Rejected: [redacted] is not allowed");
  });

  it("settles an interrupted run as an error record keeping the endpoint's reason", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "interrupted", error: "the journal was never written" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/interrupt/i);
    expect(text(result)).toContain("the journal was never written");
    const record = manager.listAgents()[0];
    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("Workflow run was interrupted: the journal was never written");
    expect(record.result).toBeUndefined();
  });

  it("hands back an unknown-state note and keeps watching, leaving the record running", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "degraded", error: "The state is unknown after 5 observations." });

    const result = await pending;

    expect(result.isError ?? false).toBe(false);
    expect(text(result)).toContain("The state is unknown after 5 observations.");
    expect(manager.listAgents()[0].lifecycle.status).toBe("running");
    // Observation carried on: the next wait belongs to the same run.
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
  });

  it("never creates anything for a call that was already interrupted", async () => {
    const client = fakeClient();
    const abort = new AbortController();
    abort.abort();

    const result = await run(client, new AgentManager(), { signal: abort.signal });

    expect(client.creates).toEqual([]);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cancel|abort|interrupt/i);
  });

  it("sends nothing and records nothing when the endpoint refuses the run", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ create: { ok: false, error: "endpoint rejected the run: HTTP 422: no prompt" } });

    const result = await run(client, manager);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("HTTP 422");
    expect(manager.listAgents()).toEqual([]);
  });

  it("stops the run whose create answer arrived after the interrupt", async () => {
    const client = fakeClient();
    const abort = new AbortController();

    const pending = run(client, new AgentManager(), { signal: abort.signal });
    abort.abort();

    const result = await pending;

    expect(client.stops).toBe(1);
    expect(text(result)).toMatch(/stopp/i);
  });

  it("registers, watches and stops nothing when the session ends while create is in flight", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ holdCreate: true });
    const shown = showPublished();

    const pending = run(client, manager, { onUpdate: shown.publish });
    await vi.waitFor(() => expect(client.creates).toHaveLength(1));

    await manager.dispose();
    client.releaseCreate();

    const result = await pending;

    expect(text(result)).toMatch(/shut ?down|session/i);
    expect(result.details.agentId, "a run the session never owned left no record behind").toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
    expect(client.views, "a run the session never owned is never observed").toEqual([]);
    expect(client.stops, "US-30: shutdown never stops the remote run").toBe(0);
    expect(shown.views, "nothing is published into a session that is gone").toEqual([]);
  });
});

describe("stopping a foreground run", () => {
  it("settles stopped on the acknowledged stop, keeping the partial view", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const shown = showPublished();
    const abort = new AbortController();

    const pending = run(client, manager, { onUpdate: shown.publish, signal: abort.signal });
    const view = await started(client);
    view.onUpdate([{ type: "text", node: "analysis", text: "Inspecting the repository" }]);

    abort.abort();

    const result = await pending;

    expect(client.stops).toBe(1);
    expect(text(result)).toMatch(/stopp/i);
    expect(manager.listAgents()[0].lifecycle.status).toBe("stopped");
    expect(shown.views.at(-1)).toBe(
      "  Inspecting the repository\n" +
        "Workflow run stopped: the endpoint acknowledged the stop and sent no terminal result.",
    );
  });

  it("reconciles an already-finished run through the endpoint's answer, not a stopped label", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ stop: { ok: true, status: "already_finished" } });
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);

    abort.abort();
    await vi.waitFor(() => expect(client.stops).toBe(1));
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
    client.settleMonitor({ status: "failed", error: "Runner lost its lease" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Runner lost its lease");
    expect(manager.listAgents()[0].lifecycle.status).toBe("error");
    expect(client.stops).toBe(1);
  });

  it("reports a refused stop as failed with the run still remote", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ stop: { ok: false, error: "The endpoint refused the stop request." } });
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);

    abort.abort();

    const result = await pending;

    expect(text(result)).toMatch(/stop failed/i);
    expect(text(result)).toMatch(/unknown/i);
    expect(manager.listAgents()[0].lifecycle.status).toBe("running");
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
  });

  it("ends with the session, leaving the remote run alone", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);

    await manager.dispose();

    expect(text(await pending)).toMatch(/shutdown|session/i);
    expect(client.stops).toBe(0);
  });

  it("ignores an interrupt that arrives after the run settled", async () => {
    const client = fakeClient();
    const abort = new AbortController();

    const pending = run(client, new AgentManager(), { signal: abort.signal });
    await started(client);
    client.settleMonitor({ status: "completed", result: DECLARED });
    await pending;

    abort.abort();
    await Promise.resolve();

    expect(client.stops).toBe(0);
  });

  it("ignores an interrupt that arrives after a failed stop handed the call back", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ stop: { ok: false, error: "The endpoint refused the stop request." } });
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);
    const record = manager.listAgents()[0]!;

    expect(manager.abort(record.id, "user"), "the stop request reaches the endpoint").toBe(true);
    const result = await pending;

    expect(text(result)).toMatch(/stop failed/i);
    expect(client.stops).toBe(1);

    abort.abort();
    await vi.waitFor(() => expect(client.views).toHaveLength(2));

    expect(client.stops, "a run the call handed back is no longer the caller's to stop").toBe(1);
    expect(record.lifecycle.status).toBe("running");

    client.answerStop({ ok: true, status: "stopped" });
    expect(manager.abort(record.id, "user"), "an explicit retry still reaches the endpoint").toBe(true);
    await vi.waitFor(() => expect(record.lifecycle.status).toBe("stopped"));

    expect(client.stops).toBe(2);
  });

  it("ignores an interrupt that arrives after the run was handed back", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);
    client.settleMonitor({ status: "degraded", error: "The state is unknown after 5 observations." });
    await pending;

    abort.abort();
    await vi.waitFor(() => expect(client.views).toHaveLength(2));

    expect(client.stops, "a run the call handed back is no longer the caller's to stop").toBe(0);
    expect(manager.listAgents()[0]!.lifecycle.status).toBe("running");
  });
});

describe("the live view", () => {
  it("paints each connection's whole view rather than the lines it has seen so far", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const shown = showPublished();

    const pending = run(client, manager, { onUpdate: shown.publish });
    const first = await started(client);
    first.onUpdate([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Inspecting the repository" },
    ]);
    // The wait ends without an outcome, so the next one belongs to the same run and receives the
    // journal replayed from the start, with the status this node reached since.
    client.settleMonitor({ status: "degraded", error: "The state is unknown after 5 observations." });
    await pending;
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
    client.views[1]!.onUpdate([
      { type: "node-status", node: "analysis", status: "completed" },
      { type: "text", node: "analysis", text: "Inspecting the repository" },
    ]);
    client.settleMonitor({ status: "completed", result: DECLARED });
    await vi.waitFor(() => expect(manager.listAgents()[0]!.lifecycle.status).toBe("completed"));

    for (const view of shown.views) {
      expect(
        view.split("\n").filter((line) => line.includes("analysis")),
        "the published view shows one status line for the node",
      ).toHaveLength(1);
    }
    expect(shown.views.at(-1)).toBe("\u2713 analysis completed\n  Inspecting the repository\nThe declared output");
  });
});

describe("observation health on the record", () => {
  /** A run driven to a degraded hand-back, with the record and the second waiter in hand. */
  async function handedBack(manager: AgentManager, client: FakeClient) {
    const pending = run(client, manager);
    const first = await started(client);
    first.onUpdate([{ type: "text", node: "analysis", text: "Inspecting the repository" }]);
    client.settleMonitor({ status: "degraded", error: "The state is unknown after 5 observations." });
    const result = await pending;
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
    return { result, record: manager.listAgents()[0]!, next: client.views[1]! };
  }

  it("keeps the connection's latest progress on the record as well as in the call", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    const view = await started(client);
    view.onUpdate([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Inspecting the repository" },
    ]);

    expect(manager.listAgents()[0]!.workflow?.progress).toEqual([
      "\u25b6 analysis dispatched",
      "  Inspecting the repository",
    ]);
    client.settleMonitor({ status: "completed", result: DECLARED });
    await pending;
  });

  it("hands the unknown-state note to the record and leaves the run running and stoppable", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const { result, record } = await handedBack(manager, client);

    expect(result.isError ?? false).toBe(false);
    expect(record.lifecycle.status).toBe("running");
    expect(record.workflow?.note).toContain("The state is unknown after 5 observations.");
    expect(manager.abort(record.id, "user"), "the handed-back run is still this session's to stop").toBe(true);
    await vi.waitFor(() => expect(client.stops).toBe(1));
  });

  it("clears the unknown-state note when an authoritative read lands running", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const { record, next } = await handedBack(manager, client);

    next.onRead?.("running");

    expect(record.workflow?.note).toBeUndefined();
    expect(record.lifecycle.status).toBe("running");
  });

  it("keeps the stop-failed note through an authoritative running read", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ stop: { ok: false, error: "The endpoint refused the stop request." } });
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(client.views).toHaveLength(2));
    const record = manager.listAgents()[0]!;

    client.views[1]!.onRead?.("running");

    expect(record.workflow?.note).toMatch(/stop failed/i);
    expect(record.lifecycle.status).toBe("running");
  });

  it("keeps updating the record after the waiter is gone, and never re-labels the run", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const { record, next } = await handedBack(manager, client);

    next.onUpdate([{ type: "node-status", node: "analysis", status: "completed" }]);
    expect(record.workflow?.progress).toEqual(["\u2713 analysis completed"]);

    client.settleMonitor({ status: "completed", result: DECLARED });
    await expect(record.execution.promise!).resolves.toBe("The declared output");
    expect(record.lifecycle.status).toBe("completed");
    expect(record.workflow?.note).toBeUndefined();
  });
});

describe("one settlement decider", () => {
  it("settles stopped exactly once from the ack when the in-flight read was cancelled", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const abort = new AbortController();

    const pending = run(client, manager, { signal: abort.signal });
    await started(client);
    abort.abort();

    const result = await pending;
    const record = manager.listAgents()[0]!;

    expect(text(result)).toMatch(/acknowledged the stop/i);
    expect(record.lifecycle.status).toBe("stopped");
    expect(record.execution.settlementCount).toBe(1);
    await expect(record.execution.promise!).resolves.toMatch(/acknowledged the stop/i);
  });

  it("leaves a settled terminal record inert against a later stop request", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "completed", result: DECLARED });
    const result = await pending;
    const record = manager.listAgents()[0]!;

    const stopped = manager.abort(record.id, "user");

    expect(stopped, "a settled run answers for itself; the stop request is inert").toBe(false);
    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("The declared output");
    expect(text(result)).toBe("The declared output");
    expect(client.stops).toBe(0);
  });
});

describe("shutdown releases without publishing", () => {
  // Pi awaits the aborted turn before it emits `session_shutdown`, so a bound run has already
  // settled from its own stop acknowledgement by then: shutdown finds a settled record and must
  // leave it alone and send nothing.
  it("sends nothing and writes nothing when the teardown's abort settled the run first", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const shown = showPublished();
    const abort = new AbortController();

    const pending = run(client, manager, { onUpdate: shown.publish, signal: abort.signal });
    await started(client);
    abort.abort();
    const result = await pending;
    const record = manager.listAgents()[0]!;
    const settled = {
      status: record.lifecycle.status,
      completedAt: record.lifecycle.completedAt,
      stoppedBy: record.lifecycle.stoppedBy,
      result: record.result,
      workflow: structuredClone(record.workflow ?? null),
    };
    const views = [...shown.views];

    await manager.dispose();
    await Promise.resolve();

    expect(text(result)).toMatch(/acknowledged the stop/i);
    expect(client.stops, "the abort's stop is the only stop this run ever sends").toBe(1);
    expect(record.lifecycle.status).toBe(settled.status);
    expect(record.lifecycle.completedAt, "shutdown rewrites no end time").toBe(settled.completedAt);
    expect(record.lifecycle.stoppedBy, "shutdown rewrites no stop initiator").toBe(settled.stoppedBy);
    expect(record.result).toBe(settled.result);
    expect(record.workflow).toEqual(settled.workflow);
    expect(record.execution.settlementCount).toBe(1);
    expect(shown.views, "shutdown publishes nothing into a session that is gone").toEqual(views);
  });

  it("releases the watched run with a note that asserts nothing about a stop", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const shown = showPublished();

    const pending = run(client, manager, { onUpdate: shown.publish });
    await started(client);
    const record = manager.listAgents()[0]!;

    await manager.dispose();

    const result = await pending;
    expect(text(result)).toMatch(/no longer watched.*(?:outcome|state).*unknown/i);
    expect(text(result)).not.toMatch(/left running remotely|nothing was stopped|was not stopped/i);
    expect(record.lifecycle.status, "shutdown is not a settlement").toBe("running");
    expect(shown.views, "nothing is published into a session that is gone").toEqual([]);
    await expectGatePending(record.execution.promise!, "the release came from the note, not the gate");
  });

  it("releases the run whose stop is in flight and applies nothing that arrives after", async () => {
    const manager = new AgentManager();
    const client = fakeClient({ holdStop: true });
    const shown = showPublished();
    const abort = new AbortController();

    const pending = run(client, manager, { onUpdate: shown.publish, signal: abort.signal });
    await started(client);
    const record = manager.listAgents()[0]!;
    manager.abort(record.id, "user");
    await vi.waitFor(() => expect(client.stopSignals).toHaveLength(1));
    const stopSignal = client.stopSignals[0]!;

    await manager.dispose();

    const result = await pending;
    expect(text(result)).toMatch(/no longer watched.*(?:outcome|state).*unknown/i);
    expect(stopSignal.aborted, "the in-flight stop's local wait is cancelled with the session").toBe(true);
    client.releaseStop({ ok: true, status: "stopped" });
    await Promise.resolve();
    expect(record.lifecycle.status).toBe("running");
    expect(shown.views).toEqual([]);
    expect(client.stops, "shutdown sends no second stop").toBe(1);
  });
});
