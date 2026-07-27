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

// Controllable mock for getStore(), used by delta estimation tests
const mockStoreState = { deltaInputTokens: true };

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    agent: {
      deltaInputTokens: mockStoreState.deltaInputTokens,
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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small", isBackground: true });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/4b_small", isBackground: true });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small", isBackground: true });

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
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b_small", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b_small", isBackground: true });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      deferred1.resolve(mockRunResult());
      await new Promise((r) => setTimeout(r, 10));

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/27b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b", isBackground: true });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/27b", isBackground: true });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "claude/sonnet", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "claude/sonnet", isBackground: true });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "claude/sonnet", isBackground: true });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/27b", isBackground: true });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", { description: "task 3", modelKey: "llamacpp/3b", isBackground: true });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", { description: "task 4", modelKey: "claude/sonnet", isBackground: true });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b", isBackground: true });

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

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "task 1", modelKey: "llamacpp/4b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "task 2", modelKey: "llamacpp/4b", isBackground: true });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");

      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      deferred.resolve(mockRunResult());
    });

    it("queues foreground agent when limit is reached", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", { description: "bg task", modelKey: "llamacpp/4b", isBackground: true });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", { description: "fg task", modelKey: "llamacpp/4b", isBackground: false });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      deferred1.resolve(mockRunResult());

      return new Promise((r) => setTimeout(r, 10)).then(() => {
        expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
        expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
        deferred2.resolve(mockRunResult());
      });
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

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "test task", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.05;
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.05);
    });

    it("persists cost after agent is evicted from map", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "test task", modelKey: "test/model" });
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
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", { description: "second", modelKey: "test/model" });
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

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "stoppable", modelKey: "test/model" });
      manager.getRecord(id)!.stats.lifetimeUsage.cost = 0.04;

      manager.abort(id, "agent");

      deferred.resolve({
        responseText: "",
        session: mockAgentSession(),
        aborted: true,
        turnLimited: false,
      });

      await new Promise(r => setTimeout(r, 10));

      expect(manager.getTotalAgentCost()).toBe(0.04);
    });
  });
  // ── Cleanup eviction ──

  describe("cleanup", () => {
    it("preserves unconsumed completed records older than the cutoff", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

      const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
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

    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const record = manager.getRecord(id)!;
    const onUsage = getOnAssistantUsage();

    // First message: 100 input
    onUsage({ input: 100, output: 50, cacheWrite: 0, cost: 0, cacheRead: 0 });
    expect(record.stats.lifetimeUsage.input).toBe(100);

    // Second message: 250 input — delta disabled, so full input used
    onUsage({ input: 250, output: 30, cacheWrite: 0, cost: 0, cacheRead: 0 });
    expect(record.stats.lifetimeUsage.input).toBe(350); // 100 + 250 (full, no delta)
  });

  it("accumulates cache reads and retains only the newest cache-hit rate", () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    const onUsage = getOnAssistantUsage();

    onUsage({ input: 100, output: 10, cacheRead: 80, cacheWrite: 20, cost: 0 });
    onUsage({ input: 200, output: 10, cacheRead: 150, cacheWrite: 50, cost: 0 });

    const stats = manager.getRecord(id)!.stats;
    expect(stats.cacheRead).toBe(230);
    expect(stats.latestCacheHitRate).toBeCloseTo((150 / 400) * 100);
    expect(stats.lifetimeUsage.cacheWrite).toBe(70);
  });

  it("persists final context, auto-compaction, and subscription snapshots", async () => {
    manager = new AgentManager(onComplete);
    const session = {
      ...mockAgentSession(),
      getContextUsage: () => ({ percent: 23.4, contextWindow: 272_000 }),
      autoCompactionEnabled: true,
      model: { provider: "kimi-coding" },
    };
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session }));
    const id = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task", { description: "task", modelKey: "test/model" });
    await manager.getRecord(id)!.execution.promise;

    expect(manager.getRecord(id)!.stats).toMatchObject({
      contextPercent: 23.4,
      contextWindow: 272_000,
      autoCompactionEnabled: true,
      usingSubscription: true,
    });
  });
});
}); // end describe AgentManager
