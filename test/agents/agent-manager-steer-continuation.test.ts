/**
 * agent-manager-steer-continuation.test.ts — Steer continuation tests for AgentManager.
 * Split from agent-manager.test.ts for maintainability. Shared mocks: manager-mocks.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
import { mockModules, mockStoreState, mockAgentSession, mockRunResult, type OnAgentComplete } from "./manager-mocks.js";
import { AgentManager, WATCHDOG_TICK_MS } from "../../src/agents/agent-manager.js";
import { asAgentSession } from "../pi-boundaries.js";

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

  function spawnForeground(prompt: string, options: Record<string, unknown> = {}): string {
    return manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, {
      description: prompt,
      modelKey: "test/model",
      ...options,
    });
  }

  // ── steer continuation: settled agents with a live session ──

  describe("steer continuation", () => {
    function getOnAssistantUsage() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      const callbacks = call[3];
      return callbacks.onAssistantUsage;
    }

    function getOnTurnEnd() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onTurnEnd;
    }

    function getOnToolActivity() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onToolActivity;
    }

    async function spawnSettled(options: Record<string, unknown> = {}): Promise<string> {
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
      const id = spawnForeground("first task", options);
      await manager.getRecord(id)!.execution.promise;
      return id;
    }

    describe("steer continuation", () => {
      function getOnTurnEnd() {
        const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
        return call[3].onTurnEnd;
      }

      function getOnToolActivity() {
        const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
        return call[3].onToolActivity;
      }

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
        record.execution.session = asAgentSession(mockAgentSession({ isStreaming: true }));

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

      it("forwards continuation activity and streamed text to the spawn-time live-view callbacks", async () => {
        manager = new AgentManager(onComplete);
        const onToolActivity = vi.fn();
        const onTextDelta = vi.fn();
        const contRun = makeResolvablePromise();
        mockModules.mockContinueAgentSession.mockReturnValue(contRun.promise);
        const id = await spawnSettled({ onToolActivity, onTextDelta });
        const record = manager.getRecord(id)!;

        await manager.steer(id, "keep going");
        const contCallbacks = mockModules.mockContinueAgentSession.mock.calls[0][2];
        contCallbacks.onToolActivity({ type: "start", toolName: "bash", toolCallId: "c1" });
        contCallbacks.onTextDelta("hel", "hello");

        expect(onToolActivity).toHaveBeenCalledWith({ type: "start", toolName: "bash", toolCallId: "c1" });
        expect(onTextDelta).toHaveBeenCalledWith("hel", "hello");

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
            session: mockAgentSession({ model: { provider: "anthropic", id: "claude-sonnet-4" } }),
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

      it("initializes settlementCount to 0 at spawn", async () => {
        manager = new AgentManager(onComplete);
        mockModules.mockRunAgent.mockReturnValue(makeResolvablePromise().promise);
        const id = spawnForeground("first task");

        expect(manager.getRecord(id)!.execution.settlementCount).toBe(0);
      });

      it("increments settlementCount on every settlement, before notifying", async () => {
        const observedCounts: number[] = [];
        manager = new AgentManager((record) => {
          onComplete(record);
          observedCounts.push(record.execution.settlementCount);
        });
        mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
        const id = spawnForeground("first task");
        await manager.getRecord(id)!.execution.promise;

        const contRun1 = makeResolvablePromise();
        mockModules.mockContinueAgentSession.mockReturnValue(contRun1.promise);
        await manager.steer(id, "keep going");
        contRun1.resolve(mockRunResult());
        await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settled).toBe(true));

        const contRun2 = makeResolvablePromise();
        mockModules.mockContinueAgentSession.mockReturnValue(contRun2.promise);
        await manager.steer(id, "keep going again");
        contRun2.resolve(mockRunResult());
        await vi.waitFor(() => expect(manager.getRecord(id)!.execution.settled).toBe(true));

        const record = manager.getRecord(id)!;
        expect(record.execution.settlementCount).toBe(3);
        // The completion callback observes the incremented count, so the
        // coordinator can tell a continuation settlement from the first one.
        expect(observedCounts).toEqual([1, 2, 3]);
      });

      it("keeps settlementCount at 0 for a never-started queued stop", async () => {
        manager = new AgentManager(onComplete, { default: 1, models: { "test/model": 1 } });
        const firstRun = makeResolvablePromise();
        mockModules.mockRunAgent.mockReturnValue(firstRun.promise);
        const id1 = spawnForeground("first");
        const id2 = spawnForeground("second");
        const record2 = manager.getRecord(id2)!;
        expect(record2.lifecycle.status).toBe("queued");

        manager.abort(id2, "user");
        // The direct notify path (never-started) carries the untouched counter.
        const observed = onComplete.mock.calls.map((c) => c[0]);
        const stopCall = observed.find((r) => r.id === id2)!;
        expect(stopCall.execution.settlementCount).toBe(0);

        firstRun.resolve(mockRunResult());
      });
    });
  });
});
