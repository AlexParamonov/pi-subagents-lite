/**
 * agent-runner-announcements.test.ts — The Subagent lifecycle announcements a
 * spawn makes on the parent's event bus.
 *
 * The ordering the subagent-integration convention requires is a synchronous
 * one: `created` must already be on the bus when the child's extensions are
 * bound. These tests watch the announcement timeline against the bind call.
 *
 * Shared mocks: agent-runner-mocks.ts (must be the first import).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { fakeCtx, refusingEvents } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";
import { mockModules, resetMocks, createMockSession, type MockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const CHILD_ID = "child-session-id";
/** The parent id fakeCtx()'s session manager reports. */
const PARENT_ID = "session-1";

/**
 * Bus fake recording what lite published, so a test can read the ordering
 * (`timeline`, interleaved with the run's own markers) or the exact payloads
 * (`published`). A fake because this file mocks the SDK module, so the real bus
 * factory is unavailable; the contract suite covers the real one.
 */
function busRecorder(): {
  bus: EventBus;
  timeline: string[];
  published: Array<{ channel: string; data: unknown }>;
} {
  const timeline: string[] = [];
  const published: Array<{ channel: string; data: unknown }> = [];
  const bus: EventBus = {
    emit: (channel, data) => {
      timeline.push(channel);
      published.push({ channel, data });
    },
    on: () => () => {},
  };
  return { bus, timeline, published };
}

function piWithBus(bus: EventBus) {
  return asExtensionAPI({ exec: execStub(), events: bus });
}

/** A pi instance from a pi version (or host) that exposes no event bus. */
function piWithoutBus() {
  return asExtensionAPI({ exec: execStub() });
}

function execStub() {
  return vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
}

let session: MockSession;

beforeEach(() => {
  resetMocks();
  session = createMockSession();
  session.sessionId = CHILD_ID;
  session.getActiveToolNames.mockReturnValue(["read", "bash"]);
  mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
});

describe("Subagent lifecycle announcements", () => {
  it("announces the child created before binding and bound after it", async () => {
    const { bus, timeline } = busRecorder();
    session.bindExtensions.mockImplementation(async () => {
      timeline.push("bind");
    });

    await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(bus) });

    expect(timeline).toEqual(["subagents:child:session-created", "bind", "subagents:child:bound"]);
  });

  it("announces the child's own session id next to the parent's", async () => {
    const { bus, published } = busRecorder();

    await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(bus) });

    expect(published).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
      { channel: "subagents:child:bound", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });

  it("never announces a child whose binding failed, and disposes it exactly once", async () => {
    const { bus, timeline } = busRecorder();
    session.bindExtensions.mockRejectedValue(new Error("bind failed"));

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(bus) })).rejects.toThrow("bind failed");

    expect(timeline).toEqual(["subagents:child:session-created", "subagents:child:disposed"]);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("never hands the parent's event bus to the child's resource loader", async () => {
    const { bus, timeline } = busRecorder();

    await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(bus) });

    // Guard against a vacuous pass: the announcement proves the bus was live.
    expect(timeline).not.toEqual([]);
    const loaderOpts = mockModules.getLoaderOpts();
    expect(loaderOpts).not.toBeNull();
    expect(Object.values(loaderOpts!)).not.toContain(bus);
  });

  it("announces a spawn aborted after session creation as bound then disposed", async () => {
    const controller = new AbortController();
    const { bus, timeline } = busRecorder();
    mockModules.mockCreateAgentSession.mockImplementation(async () => {
      controller.abort();
      return { session, extensionsResult: {} };
    });

    await expect(
      runAgent(fakeCtx(), "test-agent", "task", {
        pi: piWithBus(bus),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted during setup/);

    expect(timeline).toEqual(["subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed"]);
  });
});

describe("an announcement that cannot be published never breaks the run", () => {
  it("binds and returns the session as usual", async () => {
    const result = await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(refusingEvents()) });

    expect(result.session).toBe(session);
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("tears the session down when the parent session id cannot be read", async () => {
    const ctx = fakeCtx();
    ctx.sessionManager.getSessionId = () => {
      throw new Error("parent session is gone");
    };

    await expect(runAgent(ctx, "test-agent", "task", { pi: piWithBus(busRecorder().bus) })).rejects.toThrow(
      "parent session is gone",
    );

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports the bind failure, not the refused announcement", async () => {
    session.bindExtensions.mockRejectedValue(new Error("bind failed"));

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(refusingEvents()) })).rejects.toThrow(
      "bind failed",
    );

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("Subagent lifecycle announcements without an event bus", () => {
  it("spawns, binds and returns the session unchanged", async () => {
    const result = await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithoutBus() });

    expect(result.session).toBe(session);
    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("still disposes a session whose binding failed", async () => {
    session.bindExtensions.mockRejectedValue(new Error("bind failed"));

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: piWithoutBus() })).rejects.toThrow("bind failed");

    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});
