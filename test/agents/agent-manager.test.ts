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
  mockContinueAgentSession: vi.fn(),
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
  mockAgentOutputLog: vi.fn(function () {
    return { attach: vi.fn(), finalize: vi.fn(), path: "/tmp/out.log" };
  }),
  mockGetAgentConfig: vi.fn(() => undefined),
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));

vi.mock("node:fs", () => mockModules.fsMock);

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
  continueAgentSession: mockModules.mockContinueAgentSession,
}));
vi.mock("../../src/agents/output-file.js", () => ({
  AgentOutputLog: mockModules.mockAgentOutputLog,
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  getAgentConfig: mockModules.mockGetAgentConfig,
}));

// Controllable mock for getStore(), used by delta estimation + watchdog tests
const mockStoreState = {
  deltaInputTokens: true,
  toolTimeoutMinutes: 0,
  idleTimeoutMinutes: 0,
  outputThinkingBufferSize: 0,
  outputTranscript: true,
};

// Shared agent object so getStore() returns the same reference each time.
const mockStoreAgent = {
  get deltaInputTokens() {
    return mockStoreState.deltaInputTokens;
  },
  get toolTimeoutMinutes() {
    return mockStoreState.toolTimeoutMinutes;
  },
  get idleTimeoutMinutes() {
    return mockStoreState.idleTimeoutMinutes;
  },
  get outputThinkingBufferSize() {
    return mockStoreState.outputThinkingBufferSize;
  },
  get outputTranscript() {
    return mockStoreState.outputTranscript;
  },
};
vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ agent: mockStoreAgent }),
  // Real coordinator calls (one persistence test drives the real spawn path).
  getWidget: () => undefined,
  getPiInstance: () => undefined,
  getSessionCtx: () => undefined,
}));

function mockAgentSession(): any {
  return {
    subscribe: vi.fn(),
    messages: [],
    dispose: vi.fn(),
    isStreaming: false,
    abort: vi.fn(async () => {}),
  };
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

import { AgentManager, WATCHDOG_TICK_MS } from "../../src/agents/agent-manager.js";
import type { ConcurrencyConfig } from "../../src/agents/agent-manager.js";

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockModules.mockGetAgentConfig.mockClear();
    onComplete = vi.fn();
  });

  afterEach(() => {
    manager?.dispose();
  });

  /**
   * Helper: capture the onAssistantUsage callback passed to the most recent
   * runAgent call, so tests can drive usage reports through the real
   * callback → accumulator → total path.
   */
  function getOnAssistantUsage() {
    const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
    const callbacks = call[3]; // 4th arg is the callbacks object
    return callbacks.onAssistantUsage;
  }

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

      manager.spawn(pi, ctx, "general-purpose", "task 1", {
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

    it("removes per-model slot when model entry is removed from config", () => {
      // Set up: per-model limit of 1 for llamacpp/4b
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // First agent starts (limit is 1)
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      // Remove the per-model limit — should fall back to default (4)
      manager.setConcurrency({ default: 4, models: {} });

      // New agents should now spawn under default limit, not the old per-model limit
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      // All should be running (default limit is 4, old per-model limit of 1 is gone)
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("removes per-provider slot when provider entry is removed from config", () => {
      // Set up: per-provider limit of 1 for llamacpp
      const config: ConcurrencyConfig = { default: 4, providers: { llamacpp: 1 }, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // First agent starts (provider limit is 1)
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      // Remove the per-provider limit — should fall back to default (4)
      manager.setConcurrency({ default: 4, providers: {}, models: {} });

      // New agents should now spawn under default limit
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
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/3b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(4);

      deferred.resolve(mockRunResult());
    });

    it("reset to defaults clears per-model and per-provider slots", () => {
      // Set up: per-model and per-provider limits
      const config: ConcurrencyConfig = {
        default: 4,
        providers: { llamacpp: 2 },
        models: { "llamacpp/4b": 1, "claude/sonnet": 2 },
      };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // Spawn one agent per model to establish slots
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      // Reset to defaults: no per-model or per-provider overrides
      manager.setConcurrency({ default: 4 });

      // New spawns should use default limit for all models
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id4 = manager.spawn(pi, ctx, "general-purpose", "task 4", {
        description: "task 4",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id5 = manager.spawn(pi, ctx, "general-purpose", "task 5", {
        description: "task 5",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      // id1 + id3 + id4 + id5 = 4 running for llamacpp/4b (default limit 4)
      expect(manager.getRecord(id3)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id4)?.lifecycle.status).toBe("running");
      expect(manager.getRecord(id5)?.lifecycle.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(5);

      deferred.resolve(mockRunResult());
    });

    it("running agent under removed slot still settles without error", async () => {
      // Agent running under a per-model limit; slot is removed while agent runs.
      // The agent must complete and decrement its (now orphaned) slot gracefully.
      const config: ConcurrencyConfig = { default: 4, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

      // Remove the per-model limit while agent is still running
      manager.setConcurrency({ default: 4, models: {} });

      // Spawn a new agent — should use default limit now (not blocked by old slot)
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("running");

      // Complete the original agent — must not throw
      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("completed");
      expect(onComplete).toHaveBeenCalledTimes(1);

      // Clean up id2
      deferred2.resolve(mockRunResult());
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
      getOnAssistantUsage()({ input: 0, output: 0, cacheWrite: 0, cost: 0.05, cacheRead: 0 });
      await manager.getRecord(id)!.execution.promise;

      expect(manager.getTotalAgentCost()).toBe(0.05);
    });

    it("accumulates cost from multiple agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", { description: "first", modelKey: "test/model" });
      getOnAssistantUsage()({ input: 0, output: 0, cacheWrite: 0, cost: 0.02, cacheRead: 0 });
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.02);

      mockModules.mockRunAgent.mockResolvedValueOnce(mockRunResult());
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "second",
        modelKey: "test/model",
      });
      getOnAssistantUsage()({ input: 0, output: 0, cacheWrite: 0, cost: 0.05, cacheRead: 0 });
      await manager.getRecord(id2)!.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.07);
    });

    it("includes cost from failed agents", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockRejectedValueOnce(new Error("boom"));

      const ctx = fakeCtx();
      const pi = fakePi();

      const id = manager.spawn(pi, ctx, "general-purpose", "task", { description: "failing", modelKey: "test/model" });
      getOnAssistantUsage()({ input: 0, output: 0, cacheWrite: 0, cost: 0.01, cacheRead: 0 });
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
      getOnAssistantUsage()({ input: 0, output: 0, cacheWrite: 0, cost: 0.04, cacheRead: 0 });

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

  describe("delta estimation", () => {
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
        // Jump the clock so the next watchdog tick lands 46 minutes after the call started.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

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

        // Jump the clock so the next watchdog tick lands 46 minutes after the call started.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS);

        expect(manager.getRecord(id)?.lifecycle.status).toBe("stopped");
        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not stop an agent when the tool call completed before the timeout", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.toolTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
        // The tool ran long but finished before the check: move the clock
        // (without firing timers) so the end event lands 46 minutes in.
        vi.setSystemTime(Date.now() + 46 * 60_000);
        getOnToolActivity()({ type: "end", toolName: "bash", toolCallId: "call_1" });
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

        expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops an agent with no activity for longer than the idle timeout", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        // Jump the clock so the next watchdog tick lands 46 minutes after spawn.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

        const record = manager.getRecord(id)!;
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");
        expect(record.lifecycle.stopDetail).toEqual({ kind: "idle", elapsedMs: 46 * 60_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the idle clock on tool events and streamed text", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });
        getOnToolActivity()({ type: "end", toolName: "bash", toolCallId: "call_1" });
        getOnTextDelta()("hello", "hello");

        // 10 minutes of quiet after the activity: still under the 45m threshold.
        vi.setSystemTime(Date.now() + 10 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(manager.getRecord(id)?.lifecycle.status).toBe("running");

        // 46 minutes of quiet: idle kill.
        vi.setSystemTime(Date.now() + 36 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(manager.getRecord(id)?.lifecycle.status).toBe("stopped");
      } finally {
        vi.useRealTimers();
      }
    });

    it("never stops an agent that keeps producing activity", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();

        for (let i = 0; i < 6; i++) {
          getOnTextDelta()("tick", "tick");
          // 30 quiet minutes pass between activities — the watchdog scans
          // every 5s and must never see 45m of inactivity.
          vi.setSystemTime(Date.now() + 30 * 60_000 - WATCHDOG_TICK_MS);
          vi.advanceTimersByTime(WATCHDOG_TICK_MS);
          expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies to foreground and background agents alike", () => {
      vi.useFakeTimers();
      try {
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

        // Jump the clock so the next watchdog tick lands 46 minutes after spawn.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

        expect(manager.getRecord(fgId)?.lifecycle.status).toBe("stopped");
        expect(manager.getRecord(bgId)?.lifecycle.status).toBe("stopped");
      } finally {
        vi.useRealTimers();
      }
    });

    it("never stops queued agents", () => {
      vi.useFakeTimers();
      try {
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

        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

        expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
        expect(manager.getRecord(id2)?.lifecycle.status).toBe("queued");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does nothing when both checks are disabled (0)", () => {
      vi.useFakeTimers();
      try {
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();
        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });

        vi.advanceTimersByTime(46 * 60_000);

        expect(manager.getRecord(id)?.lifecycle.status).toBe("running");
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a tool kill when both checks fire at the same instant", () => {
      vi.useFakeTimers();
      try {
        mockStoreState.toolTimeoutMinutes = 45;
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        const id = spawnRunningAgent();
        getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "call_1" });

        // Jump the clock so the next watchdog tick lands 46 minutes after the call started.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

        expect(manager.getRecord(id)?.lifecycle.stopDetail?.kind).toBe("tool");
        expect(manager.getRecord(id)?.lifecycle.stopDetail?.toolName).toBe("bash");
      } finally {
        vi.useRealTimers();
      }
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

        // Jump the clock so the next watchdog tick lands 46 minutes after the call started.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);

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

  // ── Wave 1: parent interrupt binding and completion gate (slice 1-1) ──

  function spawnForeground(prompt: string, options: Record<string, unknown> = {}): string {
    return manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, {
      description: prompt,
      modelKey: "test/model",
      ...options,
    });
  }

  describe("parent interrupt binding", () => {
    it("stops a running foreground subagent with stoppedBy user and preserves partial output", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      const controller = new AbortController();

      const id = spawnForeground("task", { signal: controller.signal });
      const record = manager.getRecord(id)!;
      expect(record.lifecycle.status).toBe("running");

      controller.abort();
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("user");

      // The gate must not open until the run settles and partial output is captured.
      let gateOpened = false;
      void record.execution.promise!.then(() => {
        gateOpened = true;
      });
      await Promise.resolve();
      expect(gateOpened).toBe(false);

      deferred.resolve(mockRunResult({ responseText: "partial output", aborted: true }));
      await record.execution.promise;

      expect(record.result).toBe("partial output");
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("user");
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("cancels a queued foreground subagent on parent abort without ever starting it", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);
      const controller = new AbortController();

      const id1 = spawnForeground("first", { signal: controller.signal });
      const id2 = spawnForeground("second", { signal: controller.signal });
      const record2 = manager.getRecord(id2)!;
      expect(record2.lifecycle.status).toBe("queued");
      expect(record2.execution.promise).toBeDefined();

      controller.abort();
      expect(record2.lifecycle.status).toBe("stopped");
      expect(record2.lifecycle.stoppedBy).toBe("user");
      expect(record2.lifecycle.completedAt).toBeDefined();
      expect(record2.result).toBeUndefined();
      await record2.execution.promise; // the gate opens on the queued stop

      // The slot frees — the cancelled record must never start.
      firstRun.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("stopped");
    });

    it("notifies completion exactly once when a queued subagent is stopped, without tallying it", () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);

      const id1 = spawnForeground("first");
      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "bg task", {
        description: "bg task",
        modelKey: "test/model",
        isBackground: true,
      });
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("queued");

      // StopAgent tool path: abort with the agent initiator.
      expect(manager.abort(id2, "agent")).toBe(true);
      const record2 = manager.getRecord(id2)!;
      expect(record2.lifecycle.status).toBe("stopped");
      expect(record2.lifecycle.stoppedBy).toBe("agent");
      expect(record2.result).toBeUndefined();

      // Queued stops notify directly; they never tally as completed agents.
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(manager.getTotalAgentCount()).toBe(0);

      firstRun.resolve(mockRunResult());
    });

    it("opens the completion gate when a queued start fails during drain", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise).mockImplementationOnce(() => {
        throw new Error("start failed");
      });

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      const record2 = manager.getRecord(id2)!;
      expect(record2.execution.promise).toBeDefined();

      firstRun.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(record2.lifecycle.status).toBe("error");
      await record2.execution.promise;
    });

    it("one abort of the shared parent signal stops every bound subagent", async () => {
      manager = new AgentManager(onComplete);
      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);
      const controller = new AbortController();

      const id1 = spawnForeground("first", { signal: controller.signal });
      const id2 = spawnForeground("second", { signal: controller.signal });

      controller.abort();
      expect(manager.getRecord(id1)!.lifecycle.status).toBe("stopped");
      expect(manager.getRecord(id1)!.lifecycle.stoppedBy).toBe("user");
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("stopped");
      expect(manager.getRecord(id2)!.lifecycle.stoppedBy).toBe("user");

      // Settlement order does not matter — gates open for both.
      deferred1.resolve(mockRunResult({ responseText: "partial one", aborted: true }));
      deferred2.resolve(mockRunResult({ responseText: "partial two", aborted: true }));
      await manager.getRecord(id1)!.execution.promise;
      await manager.getRecord(id2)!.execution.promise;
      expect(manager.getRecord(id1)!.result).toBe("partial one");
      expect(manager.getRecord(id2)!.result).toBe("partial two");
    });

    it("leaves a settled subagent untouched by a later abort of the parent signal", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();

      const id = spawnForeground("task", { signal: controller.signal });
      await manager.getRecord(id)!.execution.promise;
      expect(manager.getRecord(id)!.lifecycle.status).toBe("completed");

      controller.abort();
      const record = manager.getRecord(id)!;
      expect(record.lifecycle.status).toBe("completed");
      expect(record.lifecycle.stoppedBy).toBeUndefined();
      expect(record.result).toBe("done");
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("cleans up the interrupt binding when spawn fails synchronously", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockImplementation(() => {
        throw new Error("start failed");
      });
      const controller = new AbortController();

      expect(() => spawnForeground("task", { signal: controller.signal })).toThrow("start failed");
      expect(manager.listAgents()).toHaveLength(0);

      // A later abort of the parent signal must be a no-op, not a crash.
      expect(() => controller.abort()).not.toThrow();
    });
  });

  describe("interrupt binding lifecycle guards", () => {
    it("abort of the parent signal invokes the stop path exactly once, with stoppedBy user", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();
      const id = spawnForeground("task", { signal: controller.signal });

      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();

      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortSpy).toHaveBeenCalledWith(id, "user");
      abortSpy.mockRestore();
      await manager.getRecord(id)!.execution.promise;
    });

    it("detaches the binding at settlement — a later abort never reaches the stop path", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();
      const id = spawnForeground("task", { signal: controller.signal });
      const record = manager.getRecord(id)!;
      expect(await record.execution.promise).toBe("done");

      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();
      expect(abortSpy).not.toHaveBeenCalled();
      expect(record.lifecycle.status).toBe("completed");
      abortSpy.mockRestore();
    });

    it("detaches the binding when the agent is stopped — a later abort never reaches the stop path", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();
      const id = spawnForeground("task", { signal: controller.signal });

      manager.abort(id, "agent");
      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();
      expect(abortSpy).not.toHaveBeenCalled();
      abortSpy.mockRestore();
      await manager.getRecord(id)!.execution.promise;
    });

    it("detaches all bindings on dispose — a later abort never reaches the stop path", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();
      spawnForeground("task", { signal: controller.signal });

      manager.dispose();
      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();
      expect(abortSpy).not.toHaveBeenCalled();
      abortSpy.mockRestore();
    });

    it("detaches the binding when a queued start fails during drain", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise).mockImplementationOnce(() => {
        throw new Error("start failed");
      });
      const controller = new AbortController();
      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second", { signal: controller.signal });

      firstRun.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("error");

      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();
      expect(abortSpy).not.toHaveBeenCalled();
      abortSpy.mockRestore();
    });
  });

  describe("already-aborted signal at spawn", () => {
    it("records an already-aborted spawn as stopped without ever starting it", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();
      controller.abort();

      const id = spawnForeground("task", { signal: controller.signal });
      const record = manager.getRecord(id)!;
      expect(record.lifecycle.status).toBe("stopped");
      expect(record.lifecycle.stoppedBy).toBe("user");
      expect(record.lifecycle.completedAt).toBeDefined();
      expect(record.lifecycle.started).toBe(false);
      expect(mockModules.mockRunAgent).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      await record.execution.promise; // gate opens immediately
    });

    it("removes an already-aborted queued spawn from the queue", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);
      const controller = new AbortController();
      controller.abort();

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second", { signal: controller.signal });
      const record2 = manager.getRecord(id2)!;
      expect(record2.lifecycle.status).toBe("stopped");
      expect(record2.lifecycle.started).toBe(false);

      firstRun.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("stopped");
    });
  });

  describe("completion gate", () => {
    it("creates the completion gate at spawn for every record", () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      expect(manager.getRecord(id1)!.execution.promise).toBeDefined();
      expect(manager.getRecord(id2)!.execution.promise).toBeDefined();

      firstRun.resolve(mockRunResult());
    });

    it("keeps the completion gate separate from the run's own promise", () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = spawnForeground("task");
      expect(manager.getRecord(id)!.execution.promise).not.toBe(deferred.promise);

      deferred.resolve(mockRunResult());
    });

    it("flips the started marker synchronously when the run starts", () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = spawnForeground("task");
      expect(manager.getRecord(id)!.lifecycle.started).toBe(true);

      deferred.resolve(mockRunResult());
    });
  });

  describe("dispose", () => {
    it("marks a queued foreground subagent error with the dispose message and opens its gate", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      const record2 = manager.getRecord(id2)!;
      expect(record2.lifecycle.status).toBe("queued");

      manager.dispose();
      expect(record2.lifecycle.status).toBe("error");
      expect(record2.error).toBe("Agent manager disposed before the queued agent could start.");
      expect(record2.lifecycle.completedAt).toBeDefined();
      await record2.execution.promise; // the waiting tool call resumes

      firstRun.resolve(mockRunResult());
    });

    it("opens the gate of a running subagent when its run settles after dispose", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id = spawnForeground("task");
      const record = manager.getRecord(id)!;

      manager.dispose();
      deferred.resolve(mockRunResult());
      await record.execution.promise; // must not dangle
    });
  });

  describe("clear", () => {
    it("removes a finished record and disposes its session", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const id = spawnForeground("task");
      await manager.getRecord(id)!.execution.promise;
      const record = manager.getRecord(id)!;
      const session = record.execution.session!;

      manager.clear(id);

      expect(manager.getRecord(id)).toBeUndefined();
      expect(session.dispose).toHaveBeenCalled();
    });

    it("rejects clear for running and queued records", () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      expect(manager.getRecord(id2)!.lifecycle.status).toBe("queued");

      manager.clear(id1);
      manager.clear(id2);

      expect(manager.getRecord(id1)).toBeDefined();
      expect(manager.getRecord(id2)).toBeDefined();

      deferred.resolve(mockRunResult());
    });

    it("returns true for a terminal record and false for active or unknown ids", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      deferred1.resolve(mockRunResult());
      await manager.getRecord(id1)!.execution.promise;

      expect(manager.clear(id1)).toBe(true);
      expect(manager.getRecord(id1)).toBeUndefined(); // cleared: removed from the map
      expect(manager.clear(id2)).toBe(false); // running or queued
      expect(manager.getRecord(id2)).toBeDefined(); // rejected: no state change
      expect(manager.clear("no-such-id")).toBe(false);

      deferred2.resolve(mockRunResult());
    });

    it("opens the completion gate when a stopped-but-settling record is cleared", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      const controller = new AbortController();

      const id = spawnForeground("task", { signal: controller.signal });
      const record = manager.getRecord(id)!;

      controller.abort(); // status flips to stopped; the run is still settling
      expect(record.lifecycle.status).toBe("stopped");

      const gate = record.execution.promise!;
      let gateOpened = false;
      void gate.then(() => {
        gateOpened = true;
      });
      await Promise.resolve();
      expect(gateOpened).toBe(false);

      manager.clear(id);
      await gate; // the coordinator's await must resume, not dangle
      expect(manager.getRecord(id)).toBeUndefined();

      deferred.resolve(mockRunResult({ aborted: true, responseText: "partial" }));
    });

    it("detaches the parent binding when a finished record is cleared", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const controller = new AbortController();

      const id = spawnForeground("task", { signal: controller.signal });
      await manager.getRecord(id)!.execution.promise;

      expect(manager.clear(id)).toBe(true);
      const abortSpy = vi.spyOn(manager, "abort");
      controller.abort();
      expect(abortSpy).not.toHaveBeenCalled();
      abortSpy.mockRestore();
    });
  });

  // ── Wave 1: settled-record persistence (slice 1-4, ADR-0006) ──

  describe("settled-record persistence", () => {
    it("keeps a settled record after the old eviction cutoff, even once its result was consumed", async () => {
      vi.useFakeTimers();
      try {
        manager = new AgentManager(onComplete);
        mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
        // Drive the real spawn path — same route as a foreground tool spawn.
        const { SpawnCoordinator } = await import("../../src/spawn/spawn-coordinator.js");
        const coordinator = new SpawnCoordinator(manager);
        const { agentId } = await coordinator.spawn(fakePi(), fakeCtx(), {
          type: "general-purpose",
          prompt: "task",
          description: "task",
          graceTurns: 6,
          runInBackground: false,
        });
        expect(manager.getRecord(agentId)!.lifecycle.status).toBe("completed");

        vi.advanceTimersByTime(20 * 60_000);

        expect(manager.getRecord(agentId)).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── outputThinkingBufferSize live-read ──

  describe("outputThinkingBufferSize", () => {
    it("reads bufferSize live from store at spawn time", () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      mockStoreState.outputThinkingBufferSize = 100;
      mockStoreState.outputTranscript = true;

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task 1", {
        description: "task 1",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");
      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledTimes(1);
      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledWith(
        id1,
        "task 1",
        undefined,
        100, // store value, not constructor value
      );

      // Change store value; next spawn should use the new value.
      mockModules.mockAgentOutputLog.mockClear();
      mockStoreState.outputThinkingBufferSize = 200;

      const id2 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task 2", {
        description: "task 2",
        isBackground: true,
      });

      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledTimes(1);
      expect(mockModules.mockAgentOutputLog).toHaveBeenCalledWith(
        id2,
        "task 2",
        undefined,
        200, // updated store value
      );
    });
  });

  // ── steer continuation: settled agents with a live session ──

  describe("steer continuation", () => {
    /** Capture the onTurnEnd callback passed to the most recent runAgent call. */
    function getOnTurnEnd() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onTurnEnd;
    }

    /** Capture the onToolActivity callback passed to the most recent runAgent call. */
    function getOnToolActivity() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onToolActivity;
    }

    /** Spawn and settle a completed agent; returns its id. */
    async function spawnSettled(options: Record<string, unknown> = {}): Promise<string> {
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const id = spawnForeground("first task", options);
      await manager.getRecord(id)!.execution.promise;
      return id;
    }

    it("continues a settled agent by prompting its session, returning true immediately", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(deferred.promise);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      const oldController = record.execution.abortController;
      const oldStartedAt = record.lifecycle.startedAt;
      expect(record.lifecycle.status).toBe("completed");

      const steered = await manager.steer(id, "keep going");
      expect(steered).toBe(true);
      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledWith(
        record.execution.session,
        "keep going",
        expect.objectContaining({ maxTurns: undefined, graceTurns: 6 }),
      );
      // Record is reset to running with a fresh abort controller.
      expect(record.lifecycle.status).toBe("running");
      expect(record.lifecycle.startedAt).toBeGreaterThanOrEqual(oldStartedAt);
      expect(record.lifecycle.completedAt).toBeUndefined();
      expect(record.result).toBeUndefined();
      expect(record.error).toBeUndefined();
      expect(record.execution.settled).toBe(false);
      expect(record.execution.abortController).not.toBe(oldController);

      deferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("keeps the completion gate untouched across continuation", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(deferred.promise);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      const gate = record.execution.promise;

      await manager.steer(id, "keep going");
      expect(record.execution.promise).toBe(gate);

      deferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("returns false for a settled agent without a session", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session: undefined }));
      const id = spawnForeground("first task");
      const record = manager.getRecord(id)!;
      await record.execution.promise;
      expect(record.lifecycle.status).toBe("completed");

      await expect(manager.steer(id, "keep going")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();
    });

    it("returns false while the record is still settling (settled guard)", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      const id = spawnForeground("first task");
      const record = manager.getRecord(id)!;
      // Simulate a session already created, then stop: status flips to stopped
      // synchronously while the run is still settling (settled stays false).
      const session = mockAgentSession();
      mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(session);
      manager.abort(id, "user");
      expect(record.lifecycle.status).toBe("stopped");

      await expect(manager.steer(id, "keep going")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      deferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("rejects when the session is streaming", async () => {
      manager = new AgentManager(onComplete);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      record.execution.session!.isStreaming = true;

      await expect(manager.steer(id, "keep going")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();
    });

    it("re-reserves the concurrency slot and rejects when it is full", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      const secondRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
      const idA = spawnForeground("A");
      const idB = spawnForeground("B");
      expect(manager.getRecord(idB)!.lifecycle.status).toBe("queued");

      firstRun.resolve(mockRunResult());
      await manager.getRecord(idA)!.execution.promise;
      // B drained into the slot after A settled.
      expect(manager.getRecord(idB)!.lifecycle.status).toBe("running");
      mockModules.mockContinueAgentSession.mockReturnValue(makeResolvablePromise().promise);
      await expect(manager.steer(idA, "keep going")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      secondRun.resolve(mockRunResult());
      await manager.getRecord(idB)!.execution.promise;
    });

    it("skips re-reservation entirely when modelKey is undefined", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const deferred = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(deferred.promise);
      const id = await spawnSettled({ modelKey: undefined });

      await expect(manager.steer(id, "keep going")).resolves.toBe(true);
      expect(mockModules.mockContinueAgentSession).toHaveBeenCalledTimes(1);

      deferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settled).toBe(true));
    });

    it("releases the slot and drains the queue when the continuation settles", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const idA = await spawnSettled();

      await manager.steer(idA, "keep going");
      // The continuation holds the slot: a new spawn must queue.
      const cRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(cRun.promise);
      const idC = spawnForeground("C");
      expect(manager.getRecord(idC)!.lifecycle.status).toBe("queued");

      contRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(idC)!.lifecycle.status).toBe("running"));
      cRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(idC)!.execution.settled).toBe(true));
    });

    it("preserves stats and accumulates the turn count across continuation", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const id = spawnForeground("first task");
      const record = manager.getRecord(id)!;
      getOnAssistantUsage()({ input: 100, output: 50, cacheWrite: 0, cost: 0.1, cacheRead: 0 });
      getOnToolActivity()({ type: "start", toolName: "bash", toolCallId: "c1" });
      getOnToolActivity()({ type: "end", toolName: "bash", toolCallId: "c1" });
      getOnTurnEnd()(3);
      await record.execution.promise;
      expect(record.stats.lifetimeUsage.cost).toBe(0.1);
      expect(record.stats.toolUses).toBe(1);
      expect(record.stats.turnCount).toBe(3);

      await manager.steer(id, "keep going");
      const contCallbacks = mockModules.mockContinueAgentSession.mock.calls[0][2];
      contCallbacks.onAssistantUsage({ input: 50, output: 25, cacheWrite: 0, cost: 0.05, cacheRead: 0 });
      contCallbacks.onToolActivity({ type: "start", toolName: "bash", toolCallId: "c2" });
      contCallbacks.onToolActivity({ type: "end", toolName: "bash", toolCallId: "c2" });
      contCallbacks.onTurnEnd(2);

      expect(record.stats.lifetimeUsage.cost).toBeCloseTo(0.15);
      expect(record.stats.toolUses).toBe(2);
      expect(record.stats.turnCount).toBe(5); // 3 from the first run + 2 from the continuation

      contRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("tallies only the cost delta and does not double-count the agent", async () => {
      manager = new AgentManager(onComplete);
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const id = spawnForeground("first task");
      const record = manager.getRecord(id)!;
      getOnAssistantUsage()({ input: 100, output: 50, cacheWrite: 0, cost: 0.1, cacheRead: 0 });
      await record.execution.promise;
      expect(manager.getTotalAgentCost()).toBe(0.1);
      expect(manager.getTotalAgentCount()).toBe(1);

      const contDeferred = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contDeferred.promise);
      await manager.steer(id, "keep going");
      mockModules.mockContinueAgentSession.mock.calls[0][2].onAssistantUsage({
        input: 200,
        output: 100,
        cacheWrite: 0,
        cost: 0.25,
        cacheRead: 0,
      });
      contDeferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
      expect(manager.getTotalAgentCost()).toBe(0.35); // 0.1 first run + only the 0.25 continuation delta (not 0.45)
      expect(manager.getTotalAgentCount()).toBe(1); // continuation never increments
    });

    it("notifies completion on every settlement", async () => {
      manager = new AgentManager(onComplete);
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const id = await spawnSettled();
      expect(onComplete).toHaveBeenCalledTimes(1);

      await manager.steer(id, "keep going");
      contRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settled).toBe(true));
      expect(onComplete).toHaveBeenCalledTimes(2); // first settlement + continuation
    });

    it("clears the stale result when the continuation fails", async () => {
      manager = new AgentManager(onComplete);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      expect(record.result).toBe("done");

      mockModules.mockContinueAgentSession.mockRejectedValue(new Error("boom"));
      await manager.steer(id, "keep going");
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
      expect(record.result).toBeUndefined(); // no stale result from the prior run
      expect(record.error).toContain("boom");
      expect(record.lifecycle.status).toBe("error");
      expect(onComplete).toHaveBeenCalledTimes(2);
    });

    it("classifies provider model errors like the first run", async () => {
      manager = new AgentManager(onComplete);
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      await manager.steer(id, "keep going");
      contRun.resolve(
        mockRunResult({
          responseText: "",
          modelError: "model failed to load into memory",
          session: { ...mockAgentSession(), model: { provider: "anthropic", id: "claude-sonnet-4" } },
        }),
      );
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
      expect(record.lifecycle.status).toBe("error");
      // The failed continuation must not leave the first run's result visible.
      expect(record.result).toBe("");
      expect(record.error).toContain("general-purpose");
      expect(record.error).toContain("anthropic/claude-sonnet-4");
      expect(record.error).toContain("model failed to load into memory");
    });

    it("forwards Stop through the fresh abort controller during a continuation", async () => {
      manager = new AgentManager(onComplete);
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const id = await spawnSettled();
      const record = manager.getRecord(id)!;
      await manager.steer(id, "keep going");
      // The runner wires the fresh controller's signal to session.abort();
      // here we verify the manager hands that controller to the runner.
      const contSignal = mockModules.mockContinueAgentSession.mock.calls[0][2].signal;
      expect(contSignal).toBe(record.execution.abortController!.signal);

      manager.abort(id, "user");
      expect(record.lifecycle.status).toBe("stopped");
      expect(contSignal.aborted).toBe(true);

      contRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
      expect(record.lifecycle.status).toBe("stopped");
    });

    it("does not re-attach the parent abort binding on continuation", async () => {
      manager = new AgentManager(onComplete);
      const contRun = makeResolvablePromise();
      mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
      const controller = new AbortController();
      const id = await spawnSettled({ signal: controller.signal });
      const record = manager.getRecord(id)!;
      await manager.steer(id, "keep going");

      controller.abort();
      expect(record.lifecycle.status).toBe("running"); // parent interrupt is over

      contRun.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("restarts the watchdog clock on continuation", async () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
        const id = spawnForeground("task");
        const record = manager.getRecord(id)!;
        await record.execution.promise;

        // 44 minutes of quiet after the first run settled.
        vi.setSystemTime(Date.now() + 44 * 60_000);
        const contRun = makeResolvablePromise();
        mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
        await manager.steer(id, "keep going");

        // 2 minutes later (46 total since spawn): a stale clock from spawn
        // would kill now; the restarted clock must not.
        vi.setSystemTime(Date.now() + 2 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(record.lifecycle.status).toBe("running");

        // 44 minutes after the continuation: the restarted clock kills it.
        vi.setSystemTime(Date.now() + 44 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");

        contRun.resolve(mockRunResult());
      } finally {
        vi.useRealTimers();
      }
    });

    it("feeds streamed text to the idle watchdog during a continuation", async () => {
      vi.useFakeTimers();
      try {
        mockStoreState.idleTimeoutMinutes = 45;
        manager = new AgentManager(onComplete);
        mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
        const id = spawnForeground("task");
        const record = manager.getRecord(id)!;
        await record.execution.promise;

        const contRun = makeResolvablePromise();
        mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
        await manager.steer(id, "keep going");
        const contCallbacks = mockModules.mockContinueAgentSession.mock.calls[0][2];

        // Streamed response text resets the idle clock: 30 quiet minutes
        // after each delta must never accumulate 45m of inactivity.
        for (let i = 0; i < 3; i++) {
          contCallbacks.onTextDelta?.("tick", "tick");
          vi.setSystemTime(Date.now() + 30 * 60_000 - WATCHDOG_TICK_MS);
          vi.advanceTimersByTime(WATCHDOG_TICK_MS);
          expect(record.lifecycle.status).toBe("running");
        }

        // 46 minutes of quiet after the last delta: idle kill.
        vi.setSystemTime(Date.now() + 46 * 60_000 - WATCHDOG_TICK_MS);
        vi.advanceTimersByTime(WATCHDOG_TICK_MS);
        expect(record.lifecycle.status).toBe("stopped");
        expect(record.lifecycle.stoppedBy).toBe("watchdog");

        contRun.resolve(mockRunResult());
      } finally {
        vi.useRealTimers();
      }
    });

    it("steer on a running agent still delegates to session.steer (unchanged)", async () => {
      manager = new AgentManager(onComplete);
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);
      const id = spawnForeground("task");
      const record = manager.getRecord(id)!;

      // No session yet: the message is queued as a pending steer.
      await expect(manager.steer(id, "early")).resolves.toBe(true);
      expect(record.execution.pendingSteers).toEqual(["early"]);

      // Session arrives: pending steers flush, live steers delegate.
      const session = mockAgentSession();
      session.steer = vi.fn(async () => {});
      mockModules.mockRunAgent.mock.calls[0][3].onSessionCreated(session);
      await expect(manager.steer(id, "later")).resolves.toBe(true);
      expect(session.steer).toHaveBeenCalledWith("later");
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      deferred.resolve(mockRunResult());
      await vi.waitFor(() => expect(record.execution.settled).toBe(true));
    });

    it("does not continue a record that never settled (queued stop)", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
      const firstRun = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(firstRun.promise);
      const id1 = spawnForeground("first");
      const id2 = spawnForeground("second");
      const record2 = manager.getRecord(id2)!;
      expect(record2.lifecycle.status).toBe("queued");

      manager.abort(id2, "user");
      expect(record2.lifecycle.status).toBe("stopped");
      await expect(manager.steer(id2, "keep going")).resolves.toBe(false);
      expect(mockModules.mockContinueAgentSession).not.toHaveBeenCalled();

      firstRun.resolve(mockRunResult());
    });
  });
}); // end describe AgentManager
