/**
 * agent-manager-workflow.test.ts — The shared manager's Workflow-run seam.
 *
 * A Workflow run is a record like any other, with the guards that come from having no session:
 * it cannot be steered, stopping it is the endpoint's answer and never a synchronous label, and
 * it settles exactly once however many paths reach for it.
 */
import "./manager-mocks.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { AgentRecord, WorkflowRunInfo } from "../../src/types.js";

const WORKFLOW: WorkflowRunInfo = {
  name: "audit",
  endpoint: "local",
  url: "http://127.0.0.1:4001",
  remoteId: "wf-remote-1",
};

function registration(overrides: Record<string, unknown> = {}) {
  return {
    workflow: WORKFLOW,
    description: "http://127.0.0.1:4001",
    ...overrides,
  };
}

/** A run the session owns, registered the only way a Workflow record comes to exist. */
function registered(manager: AgentManager, onEnd = vi.fn(), overrides: Record<string, unknown> = {}): AgentRecord {
  const record = manager.beginWorkflowRun(onEnd).register(registration(overrides));
  expect(record, "a live session owns the run it registers").toBeDefined();
  return record!;
}

describe("a workflow run in the record store", () => {
  it("is a running record tagged with the workflow, its endpoint and its remote id", () => {
    const manager = new AgentManager();

    const record = registered(manager);

    expect(record.workflow).toEqual(WORKFLOW);
    expect(record.lifecycle.status).toBe("running");
    expect(record.display.type).toBe("audit");
    expect(manager.listAgents()).toEqual([record]);
  });

  it("carries the completion gate every record carries", async () => {
    const manager = new AgentManager();
    const record = registered(manager);

    manager.settleWorkflowRun(record, "completed", "The declared output");

    await expect(record.execution.promise!).resolves.toBe("The declared output");
  });

  it("announces itself to the start callback, so the row and widget see it", () => {
    const started: AgentRecord[] = [];
    const manager = new AgentManager(undefined, undefined, (r) => started.push(r));

    const record = registered(manager);

    expect(started).toEqual([record]);
  });
});

describe("the session's claim on a workflow run", () => {
  it("ends the run whose record arrives after shutdown, and registers nothing", async () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const ownership = manager.beginWorkflowRun(onEnd);

    await manager.dispose();
    const record = ownership.register(registration());

    expect(onEnd).toHaveBeenCalledWith("shutdown");
    expect(record, "a dead session registers no run").toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
  });

  it("claims nothing for a run that begins after shutdown", async () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();

    await manager.dispose();
    const record = manager.beginWorkflowRun(onEnd).register(registration());

    expect(onEnd).not.toHaveBeenCalled();
    expect(record).toBeUndefined();
    expect(manager.listAgents()).toEqual([]);
  });

  it("gives up the claim of a run that never became a record", async () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const ownership = manager.beginWorkflowRun(onEnd);

    ownership.abandon();
    await manager.dispose();

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("gives up the claim of a run that already settled", async () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const record = registered(manager, onEnd);

    manager.settleWorkflowRun(record, "completed", "The answer");
    await manager.dispose();

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("drops the gate of a run the session outlives, without opening it", async () => {
    // A settlement path that somehow still holds the record must find no gate to speak into: the
    // resolver is dropped at dispose, never opened, so a dead session receives no completion.
    const manager = new AgentManager();
    const record = registered(manager);

    await manager.dispose();
    manager.settleWorkflowRun(record, "stopped", "A path that reached a dead session");

    // The fallback must wait a whole task: a bare value is adopted one hop before an already-resolved
    // gate is, so it would report "pending" whether or not the gate had opened.
    const gate = await Promise.race([
      record.execution.promise!.then(() => "opened"),
      new Promise<string>((resolve) => setTimeout(resolve, 0, "pending")),
    ]);
    expect(gate).toBe("pending");
  });
});

describe("settling a workflow run", () => {
  it("happens exactly once, however many paths reach for it", async () => {
    const manager = new AgentManager();
    const completed: AgentRecord[] = [];
    manager.setOnComplete((r) => completed.push(r));
    const record = registered(manager);

    const first = manager.settleWorkflowRun(record, "completed", "The answer");
    const second = manager.settleWorkflowRun(record, "error", "A late failure");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(record.lifecycle.status).toBe("completed");
    expect(record.result).toBe("The answer");
    await expect(record.execution.promise!).resolves.toBe("The answer");
    expect(completed).toHaveLength(1);
  });

  it("keeps a failure's reason on the record", () => {
    const manager = new AgentManager();
    const record = registered(manager);

    manager.settleWorkflowRun(record, "error", "Workflow run was interrupted: lost its lease");

    expect(record.lifecycle.status).toBe("error");
    expect(record.error).toBe("Workflow run was interrupted: lost its lease");
  });

  it("counts no cost, because a remote run spent none of this session's tokens", () => {
    const manager = new AgentManager();
    const record = registered(manager);

    manager.settleWorkflowRun(record, "completed", "The answer");

    expect(manager.getTotalAgentCount()).toBe(0);
    expect(manager.getTotalAgentCost()).toBe(0);
  });
});

describe("stopping a workflow run", () => {
  it("asks the run's own execution for a stop and marks nothing synchronously", () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const record = registered(manager, onEnd);

    const stopped = manager.abort(record.id, "agent");

    expect(stopped).toBe(true);
    expect(onEnd).toHaveBeenCalledWith("stop");
    expect(record.lifecycle.status).toBe("running");
  });

  it("refuses steering: there is no session to receive the message", async () => {
    const manager = new AgentManager();
    const record = registered(manager);

    await expect(manager.steer(record.id, "Focus on tests")).resolves.toBe(false);
  });

  it("ends local observation at shutdown without asking for a remote stop", async () => {
    const manager = new AgentManager();
    const record = registered(
      manager,
      vi.fn((reason: "stop" | "shutdown") => {
        if (reason === "shutdown") manager.settleWorkflowRun(record, "stopped", "Ended with the session.");
      }),
    );

    await manager.dispose();

    await expect(record.execution.promise!).resolves.toBe("Ended with the session.");
  });

  it("ignores the parent interrupt once the run has settled", () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const parent = new AbortController();
    const record = registered(manager, onEnd, { signal: parent.signal });

    manager.settleWorkflowRun(record, "completed", "The answer");
    parent.abort();

    expect(onEnd).not.toHaveBeenCalledWith("stop");
  });

  it("routes the parent interrupt to the stop path while the run is live", () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const parent = new AbortController();
    registered(manager, onEnd, { signal: parent.signal });

    parent.abort();

    expect(onEnd).toHaveBeenCalledWith("stop");
  });

  it("stops forwarding the parent interrupt once the run's claim is detached", () => {
    const manager = new AgentManager();
    const onEnd = vi.fn();
    const parent = new AbortController();
    const record = registered(manager, onEnd, { signal: parent.signal });

    manager.detachParentInterrupt(record.id);
    parent.abort();

    expect(onEnd).not.toHaveBeenCalledWith("stop");
  });
});
