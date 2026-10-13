/**
 * agent-manager-disposal.test.ts — Lifecycle hardening: every child session
 * terminates through the shared teardown (abort, session_shutdown, dispose,
 * disposed announcement) exactly once, whatever the trigger: clear, parent
 * dispose, or a run that settles after its record vanished (cleared mid-setup /
 * stopped mid-setup).
 *
 * Shared mocks: manager-mocks.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createEventBus, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fakeCtx, fakePi, guardedEvents, makeResolvablePromise } from "../fixtures.js";
import {
  mockModules,
  mockAgentSession,
  mockRunResult,
  type MockAgentSession,
  type OnAgentComplete,
} from "./manager-mocks.js";
import { AgentManager } from "../../src/agents/agent-manager.js";
import { announceChildSessionCreated } from "../../src/agents/child-announcements.js";

const CHILD_ID = "child-session-id";
/** The parent session id a spawn announcement carries. */
const PARENT_ID = "parent-session-1";

/**
 * Announces the child on a live `pi.events` facade over a fresh parent bus and
 * returns what that bus hears on the disposal channel. `invalidate()` makes the
 * handle stale, as replacing, reloading or disposing the parent session does.
 */
function parentHandle(session: AgentSession): { disposed: unknown[]; invalidate(): void } {
  const bus = createEventBus();
  const disposed: unknown[] = [];
  bus.on("subagents:child:disposed", (data) => disposed.push(data));
  const parent = guardedEvents(bus);
  announceChildSessionCreated(session, parent.events, PARENT_ID);
  return { disposed, invalidate: () => parent.invalidate() };
}

describe("AgentManager session disposal", () => {
  let manager: AgentManager;
  let onComplete: Mock<OnAgentComplete>;

  const callOrder = (session: MockAgentSession): string[] => {
    const order: string[] = [];
    session.abort.mockImplementation(async () => {
      order.push("abort");
    });
    session.extensionRunner.emit.mockImplementation(async () => {
      order.push("shutdown");
      return undefined;
    });
    session.dispose.mockImplementation(() => {
      order.push("dispose");
    });
    return order;
  };

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mockModules.mockContinueAgentSession.mockReset();
    onComplete = vi.fn<OnAgentComplete>();
  });

  afterEach(() => {
    manager?.dispose();
  });

  /** One cast per file: the real session type down to the mock's vi.fn surface. */
  function mockOf(session: AgentSession): MockAgentSession {
    return session as unknown as MockAgentSession;
  }

  function spawnForeground(prompt: string, options: Record<string, unknown> = {}): string {
    return manager.spawn(fakePi(), fakeCtx(), "general-purpose", prompt, {
      description: prompt,
      modelKey: "test/model",
      ...options,
    });
  }

  /**
   * Opens the manager (as every test here does), spawns a foreground agent and
   * waits for its run to settle, returning the live child session the record
   * still holds: the one the release under test must tear down.
   */
  async function spawnSettledChild(): Promise<{ id: string; session: AgentSession }> {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session: mockAgentSession({ sessionId: CHILD_ID }) }));
    const id = spawnForeground("task");
    await manager.getRecord(id)!.execution.promise;
    return { id, session: manager.getRecord(id)!.execution.session! };
  }

  it("announces the released Subagent disposed exactly once, across clear and parent dispose", async () => {
    const { id, session } = await spawnSettledChild();
    const parent = parentHandle(session);

    manager.clear(id);
    await manager.dispose();

    expect(parent.disposed).toEqual([{ sessionId: CHILD_ID }]);
  });

  it("announces a settled Subagent disposed when parent dispose is the only trigger", async () => {
    const { session } = await spawnSettledChild();
    const parent = parentHandle(session);

    await manager.dispose();

    expect(parent.disposed).toEqual([{ sessionId: CHILD_ID }]);
  });

  it("drains a Subagent whose announcements are refused by a stale parent handle", async () => {
    const { id, session } = await spawnSettledChild();
    const parent = parentHandle(session);
    // The parent session is replaced, reloaded or disposed while this child runs.
    parent.invalidate();

    manager.clear(id);
    await manager.dispose();

    expect(mockOf(session).dispose).toHaveBeenCalledTimes(1);
  });

  it("clear() then dispose(): teardown in order, the session disposed exactly once", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = spawnForeground("task");
    await manager.getRecord(id)!.execution.promise;
    const session = mockOf(manager.getRecord(id)!.execution.session!);
    const order = callOrder(session);

    manager.clear(id);
    await manager.dispose();

    expect(order).toEqual(["abort", "shutdown", "dispose"]);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("disposes a run's session that settles after its record vanished (cleared mid-setup)", async () => {
    manager = new AgentManager(onComplete);
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const controller = new AbortController();
    const id = spawnForeground("task", { signal: controller.signal });
    const gate = manager.getRecord(id)!.execution.promise!;

    controller.abort();
    manager.clear(id);
    expect(manager.getRecord(id)).toBeUndefined();

    const lateSession = mockAgentSession();
    deferred.resolve(mockRunResult({ session: lateSession }));
    await gate;
    await manager.dispose();

    expect(lateSession.dispose).toHaveBeenCalledTimes(1);
    expect(lateSession.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("dispose() awaits in-flight settlements and their session teardowns before returning", async () => {
    manager = new AgentManager(onComplete);
    const deferred = makeResolvablePromise();
    mockModules.mockRunAgent.mockReturnValue(deferred.promise);
    const id = spawnForeground("task");
    const lateSession = mockAgentSession();

    const disposing = manager.dispose();
    deferred.resolve(mockRunResult({ session: lateSession }));
    await disposing;

    expect(lateSession.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose() drains session teardowns before returning", async () => {
    manager = new AgentManager(onComplete);
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult());
    const id = spawnForeground("task");
    await manager.getRecord(id)!.execution.promise;
    const session = mockOf(manager.getRecord(id)!.execution.session!);

    await manager.dispose();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
  });
});
