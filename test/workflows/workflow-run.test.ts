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
import { progressLines, runWorkflowForeground, type WorkflowRunArgs } from "../../src/workflows/workflow-run.js";
import type {
  WorkflowClient,
  WorkflowDisplayItem,
  WorkflowOutcome,
  WorkflowStop,
  WorkflowView,
} from "../../src/workflows/workflow-client.js";
import type { WorkflowEndpoint } from "../../src/workflows/endpoints.js";

const ENDPOINT: WorkflowEndpoint = { name: "local", url: "http://127.0.0.1:4100" };
const REMOTE_ID = "wf-remote-1";
const DECLARED = { text: "The declared output", termination_reason: "final_answer", usage: {} };

type Result = AgentToolResult<Record<string, unknown>>;

/** A client whose every answer the test hands over by hand. */
interface FakeClient extends WorkflowClient {
  creates: { prompt: string; definition: Record<string, unknown>; workingDir: string }[];
  /** One entry per `monitor` call, in order: the view each call was given. */
  views: WorkflowView[];
  stops: number;
  /** Settle the oldest waiting monitor with its outcome; a monitor waits until this or a cancel. */
  settleMonitor(outcome: WorkflowOutcome): void;
}

interface FakeOptions {
  create?: { ok: true; workflowId: string; taskId: string } | { ok: false; error: string };
  stop?: WorkflowStop;
}

function fakeClient(options: FakeOptions = {}): FakeClient {
  const creates: FakeClient["creates"] = [];
  const views: WorkflowView[] = [];
  const waiters = new Set<(outcome: WorkflowOutcome) => void>();
  const client: FakeClient = {
    creates,
    views,
    stops: 0,
    async create(request) {
      creates.push({ prompt: request.prompt, definition: request.definition, workingDir: request.workingDir });
      return options.create ?? { ok: true, workflowId: REMOTE_ID, taskId: REMOTE_ID };
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
    async stop() {
      client.stops += 1;
      return options.stop ?? { ok: true, status: "stopped" };
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
    expect(record.workflow).toEqual({
      name: "audit",
      endpoint: "local",
      url: "http://127.0.0.1:4100",
      remoteId: REMOTE_ID,
    });
    expect(shown.views.at(-1)).toBe("✓ analysis completed\nThe declared output");
  });

  it("reports a failed run as an error carrying the endpoint's reason", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "failed", error: "validator rejected the diff" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("validator rejected the diff");
    expect(manager.listAgents()[0].lifecycle.status).toBe("error");
  });

  it("reports an interrupted run as interrupted, reason and all", async () => {
    const manager = new AgentManager();
    const client = fakeClient();

    const pending = run(client, manager);
    await started(client);
    client.settleMonitor({ status: "interrupted", error: "the journal was never written" });

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/interrupt/i);
    expect(text(result)).toContain("the journal was never written");
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
});

describe("the live view", () => {
  it("shows one status line per node, one tool line, and the streamed text", () => {
    const items: WorkflowDisplayItem[] = [
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: "read_file" },
      { type: "text", node: "analysis", text: "Inspecting the repository" },
      { type: "node-status", node: "report", status: "failed" },
      { type: "text", node: null, text: "and a chunk naming no node" },
    ];

    expect(progressLines(items)).toEqual([
      "\u25b6 analysis dispatched",
      "  analysis tool read_file",
      "  Inspecting the repository",
      "\u2717 report failed",
      "  and a chunk naming no node",
    ]);
  });

  it("keeps a control sequence out of every line", () => {
    expect(progressLines([{ type: "text", node: null, text: "ok \u001b[?25l here" }])).toEqual(["  ok  here"]);
  });
});
