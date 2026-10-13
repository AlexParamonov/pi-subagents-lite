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
import { fakeCtx, fakePi, makeResolvablePromise } from "../fixtures.js";
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

/** Records the disposal announcements for a child the spawn path has announced. */
function disposedAnnouncements(session: AgentSession): unknown[] {
  const events = createEventBus();
  const disposed: unknown[] = [];
  events.on("subagents:child:disposed", (data) => disposed.push(data));
  announceChildSessionCreated(session, events, "parent-session-1");
  return disposed;
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

  it("announces the released Subagent disposed exactly once, across clear and parent dispose", async () => {
    manager = new AgentManager(onComplete);
    const child = mockAgentSession({ sessionId: CHILD_ID });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session: child }));
    const id = spawnForeground("task");
    await manager.getRecord(id)!.execution.promise;
    const disposed = disposedAnnouncements(manager.getRecord(id)!.execution.session!);

    manager.clear(id);
    await manager.dispose();

    expect(disposed).toEqual([{ sessionId: CHILD_ID }]);
  });

  it("announces a settled Subagent disposed when parent dispose is the only trigger", async () => {
    manager = new AgentManager(onComplete);
    const child = mockAgentSession({ sessionId: CHILD_ID });
    mockModules.mockRunAgent.mockResolvedValue(mockRunResult({ session: child }));
    const id = spawnForeground("task");
    await manager.getRecord(id)!.execution.promise;
    const disposed = disposedAnnouncements(manager.getRecord(id)!.execution.session!);

    await manager.dispose();

    expect(disposed).toEqual([{ sessionId: CHILD_ID }]);
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
