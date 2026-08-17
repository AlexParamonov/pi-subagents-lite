/**
 * agent-manager.test.ts — Tests for AgentManager lifecycle, interrupts, and steering.
 * Concurrency tests live in agent-manager-concurrency.test.ts; watchdog tests in
 * agent-manager-watchdog.test.ts. Shared mocks: manager-mocks.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import {
  mockModules,
  mockStoreState,
  mockAgentSession,
  mockRunResult,
  type FakeSessionModel,
  type OnAgentComplete,
} from "./manager-mocks.js";
import { AgentManager, WATCHDOG_TICK_MS } from "../../src/agents/agent-manager.js";

describe("AgentManager", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    mockModules.mockAgentOutputLog.mockClear();
    mockModules.mockGetAgentConfig.mockClear();
    onComplete = vi.fn<OnAgentComplete>();
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

      expect(manager.getTotalAgentCount()).toBe(0);
    });

    it("does not count queued agent that fails to start", async () => {
      manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValueOnce(deferred.promise);

      const id1 = manager.spawn(fakePi(), fakeCtx(), "general-purpose", "task1", {
        description: "t1",
        modelKey: "test/model",
      });
      expect(manager.getRecord(id1)?.lifecycle.status).toBe("running");

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

      expect(manager.getTotalAgentCount()).toBe(1);
      expect(manager.getRecord(id2)?.lifecycle.status).toBe("error");
    });
  });
  // ── Model error handling (final assistant message stopReason "error") ──

  describe("model error handling", () => {
    function sessionWithModel(model?: FakeSessionModel) {
      return mockAgentSession({ model });
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
});
