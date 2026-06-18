/**
 * total-cost-accumulator.test.ts — Tests for session-level cost accumulator.
 *
 * Verifies that AgentManager tracks cumulative cost across agent lifecycles,
 * surviving agent eviction so the status bar never drops to $0.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

// --- Mock modules ---

let uuidCounter = 0;

const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockRandomUUID: vi.fn(() => {
    uuidCounter++;
    return `agent-${String(uuidCounter).padStart(8, "0")}`;
  }),
  resetUuidCounter: () => { uuidCounter = 0; },
  fsMock: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));

vi.mock("node:fs", () => mockModules.fsMock);

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
}));

/** Minimal mock session. */
function mockAgentSession(): any {
  return { subscribe: vi.fn(), messages: [], dispose: vi.fn() };
}

function mockRunResult(overrides?: Partial<ReturnType<typeof mockRunResult>>) {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    steered: false,
    ...overrides,
  };
}

// --- Import the module under test ---
import { AgentManager } from "../../src/agents/agent-manager.js";

describe("totalAgentCost accumulator", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    onComplete = vi.fn();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it("starts at zero", () => {
    manager = new AgentManager(onComplete);
    expect(manager.getTotalAgentCost()).toBe(0);
  });

  it("accumulates cost when an agent completes", async () => {
    manager = new AgentManager(onComplete);

    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

    const ctx = fakeCtx();
    const pi = fakePi();

    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "test task",
      modelKey: "test/model",
    });

    // Set cost on the record before the agent finishes.
    // In real usage, cost accumulates via onAssistantUsage during the run.
    const record = manager.getRecord(id)!;
    record.stats.lifetimeUsage.cost = 0.05;

    // Wait for the agent to finish — finally() calls safeNotifyComplete
    await record.execution.promise;

    expect(manager.getTotalAgentCost()).toBe(0.05);
  });

  it("persists cost after agent is evicted from map", async () => {
    manager = new AgentManager(onComplete);

    // Resolve immediately so agent completes
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

    const ctx = fakeCtx();
    const pi = fakePi();

    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "test task",
      modelKey: "test/model",
    });

    const record = manager.getRecord(id)!;
    // Set cost before the run completes — safeNotifyComplete reads it at completion time
    record.stats.lifetimeUsage.cost = 0.03;

    // Wait for completion
    await record.execution.promise;

    // Cost should be accumulated
    const costAfterCompletion = manager.getTotalAgentCost();
    expect(costAfterCompletion).toBe(0.03);

    // Now manually trigger eviction (simulate cleanup aging out the record)
    // We can access cleanup via the private method — but since it's private,
    // let's manipulate the completedAt to force eviction
    record.lifecycle.completedAt = Date.now() - 20 * 60_000; // 20 minutes ago
    (manager as any).cleanup();

    // Record should be evicted
    expect(manager.getRecord(id)).toBeUndefined();

    // But totalAgentCost should still be 0.03
    expect(manager.getTotalAgentCost()).toBe(0.03);
  });

  it("accumulates cost from multiple agents", async () => {
    manager = new AgentManager(onComplete);

    // First agent
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const ctx = fakeCtx();
    const pi = fakePi();

    const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
      description: "first",
      modelKey: "test/model",
    });
    const r1 = manager.getRecord(id1)!;
    r1.stats.lifetimeUsage.cost = 0.02;
    await r1.execution.promise;
    expect(manager.getTotalAgentCost()).toBe(0.02);

    // Second agent
    mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
    const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
      description: "second",
      modelKey: "test/model",
    });
    const r2 = manager.getRecord(id2)!;
    r2.stats.lifetimeUsage.cost = 0.05;
    await r2.execution.promise;
    expect(manager.getTotalAgentCost()).toBe(0.07);
  });

  it("includes cost from failed agents", async () => {
    manager = new AgentManager(onComplete);

    // Agent fails
    mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));
    const ctx = fakeCtx();
    const pi = fakePi();

    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "failing",
      modelKey: "test/model",
    });
    const record = manager.getRecord(id)!;
    record.stats.lifetimeUsage.cost = 0.01;
    await record.execution.promise;

    expect(manager.getTotalAgentCost()).toBe(0.01);
  });

  it("includes cost from stopped agents", async () => {
    manager = new AgentManager(onComplete);

    // Create a deferred promise so the agent stays running until we stop it
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);
    const ctx = fakeCtx();
    const pi = fakePi();

    const id = manager.spawn(pi, ctx, "general-purpose", "task", {
      description: "stoppable",
      modelKey: "test/model",
    });
    const record = manager.getRecord(id)!;
    record.stats.lifetimeUsage.cost = 0.04;

    // Stop the agent
    manager.abort(id);

    // Resolve the deferred to allow the finally() block to run
    deferred.resolve({
      responseText: "",
      session: mockAgentSession(),
      aborted: true,
      steered: false,
    });

    // Wait a tick for microtasks
    await new Promise(r => setTimeout(r, 10));

    expect(manager.getTotalAgentCost()).toBe(0.04);
  });
});
