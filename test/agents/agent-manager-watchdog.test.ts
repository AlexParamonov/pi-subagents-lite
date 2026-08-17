/**
 * agent-manager-watchdog.test.ts — Watchdog stop decisions wired through AgentManager.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.ts";
import { mockModules, mockStoreState, mockRunResult, type OnAgentComplete } from "./manager-mocks.ts";
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

  describe("watchdog", () => {
    function getOnToolActivity() {
      const call = mockModules.mockRunAgent.mock.calls[mockModules.mockRunAgent.mock.calls.length - 1];
      return call[3].onToolActivity;
    }

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

        const detail = manager.getRecord(id)?.lifecycle.stopDetail;
        expect(detail).toMatchObject({ kind: "tool", toolName: "bash" });
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
});
