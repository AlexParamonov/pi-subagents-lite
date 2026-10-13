/**
 * session-teardown.test.ts — The single child-session disposal path.
 *
 * Pi's AgentSession.dispose() emits no session_shutdown and no lifecycle
 * announcement, so extension resources would leak and a Subagent-aware gate
 * would keep the child registered forever. disposeChildSession aborts, emits
 * session_shutdown, disposes, then announces the child disposed — idempotent
 * per session.
 */

import { describe, it, expect, vi } from "vitest";
import { createEventBus, type AgentSession } from "@earendil-works/pi-coding-agent";
import { refusingEvents } from "../fixtures.js";
import { disposeChildSession } from "../../src/agents/session-teardown.js";
import { announceChildSessionCreated } from "../../src/agents/child-announcements.js";

/** The session surface the teardown drives, asserted against the real type. */
interface TeardownSession {
  sessionId: string;
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  extensionRunner: { emit: ReturnType<typeof vi.fn<(event: unknown) => Promise<void>>> };
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

/** Every child session this file tears down carries this id on the bus. */
const CHILD_ID = "child-session-id";
const PARENT_ID = "parent-session-id";

function teardownSession(overrides: Partial<TeardownSession> = {}): TeardownSession & AgentSession {
  return {
    sessionId: CHILD_ID,
    abort: vi.fn(async () => {}),
    extensionRunner: { emit: vi.fn(async () => undefined) },
    dispose: vi.fn(),
    ...overrides,
  } as TeardownSession & AgentSession;
}

/**
 * A real pi bus recording disposal announcements, plus the seed that makes the
 * session under teardown an announced child (the announcement the spawn path makes).
 */
function lifecycleBus(session: AgentSession, onDisposed: () => void = () => {}) {
  const events = createEventBus();
  const published: string[] = [];
  events.on("subagents:child:disposed", (data) => {
    published.push(`disposed:${JSON.stringify(data)}`);
    onDisposed();
  });
  announceChildSessionCreated(session, events, PARENT_ID);
  return { published };
}

describe("disposeChildSession", () => {
  it("aborts, emits session_shutdown, disposes, then announces the child disposed", async () => {
    const session = teardownSession();
    const order: string[] = [];
    session.abort.mockImplementation(async () => {
      order.push("abort");
    });
    session.extensionRunner.emit.mockImplementation(async () => {
      order.push("emit");
      return undefined;
    });
    session.dispose.mockImplementation(() => {
      order.push("dispose");
    });
    lifecycleBus(session, () => order.push("disposed"));
    await disposeChildSession(session);

    expect(order).toEqual(["abort", "emit", "dispose", "disposed"]);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("announces the child disposed when dispose throws", async () => {
    const session = teardownSession({
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
    });
    const { published } = lifecycleBus(session);

    await disposeChildSession(session);

    expect(published).toEqual([`disposed:${JSON.stringify({ sessionId: CHILD_ID })}`]);
  });

  it("announces the child disposed exactly once when termination triggers overlap", async () => {
    const session = teardownSession();
    const { published } = lifecycleBus(session);

    await Promise.all([disposeChildSession(session), disposeChildSession(session)]);
    await disposeChildSession(session);

    expect(published).toEqual([`disposed:${JSON.stringify({ sessionId: CHILD_ID })}`]);
  });

  it("announces nothing for a child session that was never announced", async () => {
    const session = teardownSession();
    const events = createEventBus();
    const published: string[] = [];
    for (const channel of ["subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed"]) {
      events.on(channel, (data) => published.push(`${channel}:${JSON.stringify(data)}`));
    }

    await expect(disposeChildSession(session)).resolves.toBeUndefined();

    expect(published).toEqual([]);
  });

  it("is idempotent: a second call disposes exactly once and returns the first teardown", async () => {
    const session = teardownSession();
    const first = disposeChildSession(session);
    const second = disposeChildSession(session);

    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("proceeds to emit and dispose when abort rejects", async () => {
    const session = teardownSession({
      abort: vi.fn(async () => {
        throw new Error("listener rejected");
      }),
    });

    await disposeChildSession(session);

    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("proceeds to dispose when the shutdown emit rejects", async () => {
    const session = teardownSession({
      extensionRunner: {
        emit: vi.fn(async () => {
          throw new Error("handler failed");
        }),
      },
    });

    await disposeChildSession(session);

    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("never rejects when dispose throws", async () => {
    const session = teardownSession({
      dispose: vi.fn(() => {
        throw new Error("dispose failed");
      }),
    });

    await expect(disposeChildSession(session)).resolves.toBeUndefined();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("never rejects when the disposal announcement is refused by a stale extension ctx", async () => {
    const session = teardownSession();
    announceChildSessionCreated(session, refusingEvents(), PARENT_ID);

    await expect(disposeChildSession(session)).resolves.toBeUndefined();
  });
});
