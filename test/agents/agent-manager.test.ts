/**
 * agent-manager.test.ts — Tests for AgentManager.
 *
 * Covers: concurrency limits (per-model, per-provider, default),
 * queue draining, config updates, cost accumulation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";

let uuidCounter = 0;

const mockModules = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockRandomUUID: vi.fn(() => {
    uuidCounter++;
    return `agent-${String(uuidCounter).padStart(8, "0")}`;
  }),
  resetUuidCounter: () => {
    uuidCounter = 0;
  },
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

// Controllable mock for getStore(), used by delta estimation + watchdog tests
const mockStoreState = { deltaInputTokens: true, toolTimeoutMinutes: 0, idleTimeoutMinutes: 0 };

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    agent: {
      deltaInputTokens: mockStoreState.deltaInputTokens,
      toolTimeoutMinutes: mockStoreState.toolTimeoutMinutes,
      idleTimeoutMinutes: mockStoreState.idleTimeoutMinutes,
    },
  }),
}));

function mockAgentSession(): any {
  return { subscribe: vi.fn(), messages: [], dispose: vi.fn() };
}

function mockRunResult(overrides?: Partial<ReturnType<typeof mockRunResult>>) {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    turnLimited: false,
    ...overrides,
  };
}

import { AgentManager } from "../../src/agents/agent-manager.js";
import type { ConcurrencyConfig } from "../../src/agents/agent-manager.js";

describe("AgentManager", () => {
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

  // ── Concurrency ──

  describe("concurrency", () => {
    it("starts all agents when under per-model limit", () => {
      const config: ConcurrencyConfig = { default: 4, models: {} };
      manager = new AgentManager(onComplete, config);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
    });

    it("queues agents when per-model limit is reached", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("starts queued agent when running agent completes", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred2.resolve(mockRunResult());
    });

    it("queues agents per-model independently", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        models: { "llamacpp/27b": 1, "llamacpp/4b": 4 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("applies default limit for unknown models", () => {
      const config: ConcurrencyConfig = { default: 2, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred1.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred1.resolve(mockRunResult());
    });

    it("applies per-provider limit to all models from that provider", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: {},
      };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("queued");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);

      deferred1.resolve(mockRunResult());
      deferred2.resolve(mockRunResult());
      deferred3.resolve(mockRunResult());
    });

    it("per-model limit overrides per-provider limit", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
    });

    it("applies new limit when setConcurrency is called", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred.resolve(mockRunResult());
    });

    it("queues foreground agent when limit is reached", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", {
        description: "bg task",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", {
        description: "fg task",
        modelKey: "llamacpp/4b",
        isBackground: false,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
      deferred2.resolve(mockRunResult());
    });
  });

  // ── Cost accumulation ──

  describe("totalAgentCost", () => {
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
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.05;
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.05);
    });

    it("persists cost after agent is evicted from map", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", {
        description: "test task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      record.stats.lifetimeUsage.cost = 0.03;
      await record.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.03);

      // Record is consumed (result read) — eligible for eviction when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(manager.getTotalAgentCost()).toBe(0.03);
    });

    it("accumulates cost from multiple agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "first", modelKey: "test/model" });
      manager.getRecord(id1)!.stats.lifetimeUsage.cost = 0.02;
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.02);

      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "second",
        modelKey: "test/model",
      });
      manager.getRecord(id2)!.stats.lifetimeUsage.cost = 0.05;
      await manager.getRecord(id2)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.07);
    });

    it("includes cost from failed agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "failing", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.01;
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.01);
    });

    it("includes cost from stopped agents", async () => {
      manager = new AgentManager(onComplete);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", {
        description: "stoppable",
        modelKey: "test/model",
      });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.04;

      manager.abort(id, "agent");

      deferred.resolve({
        responseText: "",
        session: mockAgentSession(),
        aborted: true,
        turnLimited: false,
      });

      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.04);
    });
  });

  // ── Agent count ──

  describe("totalAgentCount", () => {
    it("starts at zero", () => {
      manager = new AgentManager(onComplete);
      expect(manager.getTotalAgentCount()).toBe(0);
    });

    it("increments when an agent completes", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "test",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("increments after successful spawn only", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task1", {
        description: "t1",
        modelKey: "test/model",
      });
      await manager.getRecord(id1)!.execution.promise;

      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task2", {
        description: "t2",
        modelKey: "test/model",
      });
      await manager.getRecord(id2)!.execution.promise;

      expect(manager.getTotalAgentCount()).toBe(2);
    });

    it("persists count after agent is evicted from map", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "test",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(manager.getTotalAgentCount()).toBe(1);

      // Evict the record
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("counts agent that fails mid-execution", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "fail",
        modelKey: "test/model",
      });
      await manager.getRecord(id)!.execution.promise;

      // Agent failed but still completed (error status), count should increment
      expect(manager.getTotalAgentCount()).toBe(1);
    });

    it("does not count agent that fails to start (startAgent throws)", async () => {
      manager = new AgentManager(onComplete);
      // Mock runAgent to throw synchronously (e.g. AgentOutputLog constructor fails)
      mockModules.mockRunAgent.mockImplementation(() => {
        throw new Error("start failed");
      });

      // spawn catches the error, deletes the record, and re-throws
      expect(() =>
        manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "fail", modelKey: "test/model" }),
      ).toThrow("start failed");

      // Failed start should not count
      expect(manager.getTotalAgentCount()).toBe(0);
    });

    it("does not count queued agent that fails to start", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });

      // First agent fills the concurrency slot
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task1", {
        description: "t1",
        modelKey: "test/model",
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      // Second agent gets queued (concurrency limit = 1)
      mockModules.mockRunAgent.mockImplementationOnce(() => {
        throw new Error("start failed");
      });
      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task2", {
        description: "t2",
        modelKey: "test/model",
      });
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      // Complete first agent — triggers drainQueue, which tries to start id2
      deferred.resolve(mockRunResult());

      await manager.getRecord(id1)!.execution.promise;

      // Agent 1 completed successfully (counted), agent 2 failed to start (not counted)
      expect(manager.getTotalAgentCount()).toBe(1);
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("error");
    });
  });
  // ── Cleanup eviction ──

  describe("cleanup", () => {
    it("preserves unconsumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Result never consumed by the LLM — must not be evicted, even when old.
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });

    it("evicts consumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Once the LLM has read the result, the record is safe to evict when old.
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 20 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("does not evict records younger than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      record.lifecycle.resultConsumed = true;
      // Just completed — well within the 10-minute retention window.
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeDefined();
    });

    it("uses configurable retention via setRetentionMinutes", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Set retention to 1 minute
      manager.setRetentionMinutes(1);

      // Record completed 2 minutes ago — should be evicted
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 2 * 60_000;
      (manager as any).cleanup();

      expect(manager.getRecord(id)).toBeUndefined();
    });

    it("retention update takes effect at next cleanup", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      // Record completed 15 minutes ago — would be evicted with default 10-min retention
      record.lifecycle.resultConsumed = true;
      record.lifecycle.completedAt = Date.now() - 15 * 60_000;

      // But bump retention to 20 minutes before cleanup
      manager.setRetentionMinutes(20);
      (manager as any).cleanup();

      // Should survive because retention was raised
      expect(manager.getRecord(id)).toBeDefined();
    });
  });

  describe("delta estimation", () => {
    /**
     * Helper: capture the onAssistantUsage callback passed to runAgent,
     * so we can invoke it manually with different usage values.
     */
    function getOnAssistantUsage() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      const callbacks = call[3]; // 4th arg is the callbacks object
      return callbacks.onAssistantUsage;
    }

    beforeEach(() => {
      mockStoreState.deltaInputTokens = true;
    });

    it("uses full input on first message (no prevInputTokens yet)", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const onUsage = getOnAssistantUsage();

      // First usage report: 100 input tokens, no cacheRead
      onUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });

      // Full input recorded on first message
      expect(record.stats.lifetimeUsage.input).toBe(100);
      expect(record.stats.lifetimeUsage.output).toBe(50);
      expect(record.stats.prevInputTokens).toBe(100);
    });

    it("computes delta when delta enabled and cacheRead is 0", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const onUsage = getOnAssistantUsage();

      // First message: 100 input
      onUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(100);

      // Second message: 250 input (150 new tokens added to context)
      onUsage({ input: 250, output: 30, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(250); // 100 + 150 delta
      expect(record.stats.lifetimeUsage.output).toBe(80); // 50 + 30
      expect(record.stats.prevInputTokens).toBe(250);
    });

    it("uses full input when cacheRead > 0 (provider reports caching)", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const onUsage = getOnAssistantUsage();

      // First message: 100 input
      onUsage({ input: 100, output: 50, cacheWrite: 10, cost: 0, cacheRead: 80 });
      expect(record.stats.lifetimeUsage.input).toBe(100);

      // Second message: 200 input with cacheRead > 0 — delta estimation skipped
      onUsage({ input: 200, output: 30, cacheWrite: 0, cost: 0, cacheRead: 150 });
      expect(record.stats.lifetimeUsage.input).toBe(300); // 100 + 200 (full, no delta)
    });

    it("prevents negative delta when input shrinks (e.g. after compaction)", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const onUsage = getOnAssistantUsage();

      // First message: 500 input
      onUsage({ input: 500, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(500);

      // After compaction: 200 input (shrunk) — delta would be -300, clamped to 200
      onUsage({ input: 200, output: 30, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(700); // 500 + 200 (full, delta skipped)
    });

    it("skips delta estimation when setting is disabled", () => {
      mockStoreState.deltaInputTokens = false;

      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      const onUsage = getOnAssistantUsage();

      // First message: 100 input
      onUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(100);

      // Second message: 250 input — delta disabled, so full input used
      onUsage({ input: 250, output: 30, cacheWrite: 0, cost: 0, cacheRead: 0 });
      expect(record.stats.lifetimeUsage.input).toBe(350); // 100 + 250 (full, no delta)
    });
  });

  // ── Model error handling (final assistant message stopReason "error") ──

  describe("model error handling", () => {
    function sessionWithModel(model?: { provider: string; id: string }) {
      return { subscribe: vi.fn(), messages: [], dispose: vi.fn(), model };
    }

    it("marks the record error with type, model, and provider error when runAgent reports a modelError", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(
        mockRunResult({
          responseText: "",
          modelError: "model failed to load into memory",
          session: sessionWithModel({ provider: "anthropic", id: "claude-sonnet-4" }),
        }),
      );

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
      expect(record.result).toBe("");
      expect(record.error).toContain("general-purpose");
      expect(record.error).toContain("anthropic/claude-sonnet-4");
      expect(record.error).toContain("model failed to load into memory");
    });

    it("sanitizes newlines in the provider error so multi-line errors do not break TUI layout", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(
        mockRunResult({
          responseText: "",
          modelError: "first line\nsecond line\r\nthird",
          session: sessionWithModel({ provider: "anthropic", id: "claude-sonnet-4" }),
        }),
      );

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
      expect(record.error).toContain("general-purpose");
      expect(record.error).toContain("anthropic/claude-sonnet-4");
      expect(record.error).toContain("first line");
      expect(record.error).toContain("second line");
      expect(record.error).toContain("third");
      expect(record.error).not.toContain("\n");
      expect(record.error).not.toContain("\r");
    });

    it("keeps completed status when runAgent reports no modelError", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("completed");
      expect(record.error).toBeUndefined();
      expect(record.result).toBe("done");
    });

    it("prefers aborted status over modelError", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ aborted: true, modelError: "boom" }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("aborted");
    });

    it("prefers error status over turn_limited", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ turnLimited: true, modelError: "boom" }));

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      const record = manager.getRecord(id)!;
      await record.execution.promise;

      expect(record.lifecycle.status).toBe("error");
    });

    it("does not overwrite an externally stopped status when a modelError is reported", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
      manager.abort(id, "user");
      deferred.resolve(
        mockRunResult({
          modelError: "boom",
          session: sessionWithModel({ provider: "anthropic", id: "claude-sonnet-4" }),
        }),
      );
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getRecord(id)!.lifecycle.status).toBe("stopped");
    });
  });

  // ── Watchdog ──

  describe("watchdog", () => {
    /** Capture the onToolActivity callback passed to the last runAgent call. */
    function getOnToolActivity() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onToolActivity;
    }

    /** Capture the onTextDelta callback passed to the last runAgent call. */
    function getOnTextDelta() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onTextDelta;
    }

    /** Direct access to the manager's per-agent watchdog state (test backdating). */
    function watchdogState(id: string) {
      return (manager as any).watchdog.agents.get(id);
    }

    function spawnRunningAgent(): string {
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      return manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
        description: "task",
        modelKey: "test/model",
      });
    }

    beforeEach(() => {
      mockStoreState.toolTimeoutMinutes = 0;
      mockStoreState.idleTimeoutMinutes = 0;
    });

    it("stops an agent whose tool call runs longer than the tool timeout, recording the reason", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.toolTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
        // Move the clock past the 45-minute threshold.
        vi.setSystemTime(Date.now() + 46 * 60_000);
        (manager as any).checkWatchdogs();

        const record = manager.getRecord(id)!;
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");
        expect(record.lifecycle.stopDetail).toEqual({ kind: "tool", toolName: "bash", elapsedMs: 46 * 60_000 });
        expect(record.execution.abortController?.signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("checks watchdogs automatically on its own interval", async () => {
      vi.useFakeTimers();
      try {
        mockStoreState.toolTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();
        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
        watchdogState(id).toolCalls.get("call_1").startedAt = Date.now() - 46 * 60_000;

        await vi.advanceTimersByTimeAsync(5_000);

        expect(manager.getRecord(id)?.lifecycle.status).toBe("stopped");
        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop an agent when the tool call completed before the timeout", () => {
      mockStoreState.toolTimeoutMinutes = 45;
      manager = new AgentManager(onComplete);
      const id = spawnRunningAgent();

      getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
      // The tool ran long but finished before the check.
      watchdogState(id).toolCalls.get("call_1").startedAt = Date.now() - 46 * 60_000;
      getOnToolActivity()({ type: "end", toolName: "bash", toolCallId: "call_1" });
      (manager as any).checkWatchdogs();

      expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
    });

    it("stops an agent with no activity for longer than the idle timeout", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        vi.setSystemTime(Date.now() + 46 * 60_000);
        (manager as any).checkWatchdogs();

        const record = manager.getRecord(id)!;
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");
        expect(record.lifecycle.stopDetail).toEqual({ kind: "idle", elapsedMs: 46 * 60_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the idle clock on tool events and streamed text", () => {
      mockStoreState.idleTimeoutMinutes = 45;
      manager = new AgentManager(onComplete);
      const id = spawnRunningAgent();

      getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
      getOnToolActivity()({ type: "end", toolName: "bash", toolCallId: "call_1" });
      getOnTextDelta()("hello", "hello");

      // 10 minutes of quiet after the activity: still under the 45m threshold.
      watchdogState(id).lastActivityAt = Date.now() - 10 * 60_000;
      (manager as any).checkWatchdogs();
      expect(manager.getRecord(id)?.lifecycle.status).toBe("running");

      // 46 minutes of quiet: idle kill.
      watchdogState(id).lastActivityAt = Date.now() - 46 * 60_000;
      (manager as any).checkWatchdogs();
      expect(manager.getRecord(id)?.lifecycle.status).toBe("stopped");
    });

    it("never stops an agent that keeps producing activity", () => {
      mockStoreState.idleTimeoutMinutes = 45;
      manager = new AgentManager(onComplete);
      const id = spawnRunningAgent();

      for (let i = 0; i < 6; i++) {
        getOnTextDelta()("tick", "tick");
        watchdogState(id).lastActivityAt = Date.now() - 30 * 60_000;
        (manager as any).checkWatchdogs();
        expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
      }
    });

    it("applies to foreground and background agents alike", () => {
      mockStoreState.idleTimeoutMinutes = 45;
      manager = new AgentManager(onComplete);
      const fgDeferred = makeResolvablePromise();
      const bgDeferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(fgDeferred.promise).mockReturnValueOnce(bgDeferred.promise);
      const fgId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "fg", {
        description: "fg",
        modelKey: "test/model",
        isBackground: false,
      });
      const bgId = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "bg", {
        description: "bg",
        modelKey: "test/model",
        isBackground: true,
      });

      watchdogState(fgId).lastActivityAt = Date.now() - 46 * 60_000;
      watchdogState(bgId).lastActivityAt = Date.now() - 46 * 60_000;
      (manager as any).checkWatchdogs();

      expect(manager.getRecord(fgId)?.lifecycle.status).toBe("stopped");
      expect(manager.getRecord(bgId)?.lifecycle.status).toBe("stopped");
    });

    it("never stops queued agents", () => {
      mockStoreState.idleTimeoutMinutes = 45;
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const first = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(first.promise);
      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "first", {
        description: "first",
        modelKey: "test/model",
      });
      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "second", {
        description: "second",
        modelKey: "test/model",
      });
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      (manager as any).checkWatchdogs();

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
    });

    it("does nothing when both checks are disabled (0)", () => {
      manager = new AgentManager(onComplete);
      const id = spawnRunningAgent();
      getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
      watchdogState(id).toolCalls.get("call_1").startedAt = Date.now() - 46 * 60_000;
      watchdogState(id).lastActivityAt = Date.now() - 46 * 60_000;
      (manager as any).checkWatchdogs();
      expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
    });

    it("records a tool kill when both checks fire at the same instant", () => {
      mockStoreState.toolTimeoutMinutes = 45;
      mockStoreState.idleTimeoutMinutes = 45;
      manager = new AgentManager(onComplete);
      const id = spawnRunningAgent();
      getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
      watchdogState(id).toolCalls.get("call_1").startedAt = Date.now() - 46 * 60_000;
      watchdogState(id).lastActivityAt = Date.now() - 46 * 60_000;
      (manager as any).checkWatchdogs();
      expect(manager.getRecord(id)?.lifecycle.stopDetail?.kind).toBe("tool");
      expect(manager.getRecord(id)?.lifecycle.stopDetail?.toolName).toBe("bash");
    });

    it("surfaces the watchdog reason through the completion nudge callback", async () => {
      vi.useFakeTimers();
      try {
        mockStoreState.toolTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const deferred = makeResolvablePromise();
        mockModules.mockRunAgent.mockReturnValue(deferred.promise);
        const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", {
          description: "task",
          modelKey: "test/model",
        });
        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
        vi.setSystemTime(Date.now() + 46 * 60_000);
        (manager as any).checkWatchdogs();

        deferred.resolve(mockRunResult());
        await manager.getRecord(id)!.execution.promise;

        expect(onComplete).toHaveBeenCalledTimes(1);
        const completed = onComplete.mock.calls[0][0];
        expect(completed.lifecycle.status).toBe("stopped");
        expect(completed.lifecycle.stoppedBy).toBe("watchdog");
        expect(completed.lifecycle.stopDetail).toEqual({ kind: "tool", toolName: "bash", elapsedMs: 46 * 60_000 });
      } finally {
        vi.useRealTimers();
      }
    });
  });
}); // end describe AgentManager
