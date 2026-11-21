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
  /** Settle the oldest waiting monitor with its outcome; a monitor waits until this or a cancel. */
  settleMonitor(outcome: WorkflowOutcome): void;
  /** Hand over the held create answer. */
  releaseCreate(create?: WorkflowCreate): void;
  /** Change what the endpoint answers a stop request with. */
  answerStop(stop: WorkflowStop): void;
}

interface FakeOptions {
  create?: { ok: true; workflowId: string; taskId: string } | { ok: false; error: string };
  /** Hold the create answer until `releaseCreate`, so a shutdown can overtake it. */
  holdCreate?: boolean;
  stop?: WorkflowStop;
}

function fakeClient(options: FakeOptions = {}): FakeClient {
  const creates: FakeClient["creates"] = [];
  const views: WorkflowView[] = [];
  const waiters = new Set<(outcome: WorkflowOutcome) => void>();
  let heldCreate: ((create: WorkflowCreate) => void) | undefined;
  let stopAnswer = options.stop ?? { ok: true, status: "stopped" };
  const client: FakeClient = {
    creates,
    views,
    stops: 0,
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
    async stop() {
      client.stops += 1;
      return stopAnswer;
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
    });
    expect(shown.views.at(-1)).toBe("✓ analysis completed\nThe declared output");
  });

  // The record's two URL copies are what the widget, the running-agents menu, the conversation viewer
  // and the details export show, and none of them holds this run's publisher: they are written already
  // safe, as one display value shared with the fault text (US-35).
  it("records the display URL with the credential redacted, not the request base", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const keyed = mintEndpoint(`http://127.0.0.1:4100/${KEY}/v1`, KEY);

    const pending = run(client, manager, { endpoint: keyed });
    await started(client);
    client.settleMonitor({ status: "completed", result: DECLARED });
    await pending;

    const record = manager.listAgents()[0];
    expect(record.workflow?.url).toBe("http://127.0.0.1:4100/[redacted]/v1");
    expect(record.display.description).toBe("http://127.0.0.1:4100/[redacted]/v1");
    expect(JSON.stringify(record)).not.toContain(KEY);
  });

  // A prefix the parser percent-escaped is a prefix no literal needle can catch, so the path is
  // withheld and the record says which host the run went to and nothing more.
  it("withholds a percent-escaped prefix from the record's display copies", async () => {
    const manager = new AgentManager();
    const client = fakeClient();
    const escaped = mintEndpoint("http://127.0.0.1:4100/k<7>/v1", "k<7>");

    const pending = run(client, manager, { endpoint: escaped });
    await started(client);
    client.settleMonitor({ status: "completed", result: DECLARED });
    await pending;

    const record = manager.listAgents()[0];
    expect(record.workflow?.url).toBe("http://127.0.0.1:4100");
    expect(record.display.description).toBe("http://127.0.0.1:4100");
    expect(JSON.stringify(record)).not.toContain("k%3C7%3E");
    expect(JSON.stringify(record)).not.toContain("k<7>");
  });

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
