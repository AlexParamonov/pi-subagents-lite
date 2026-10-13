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
import { fakeCtx } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";
import { mockModules, resetMocks, createMockSession, type MockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const CHILD_ID = "child-session-id";
/** The parent id fakeCtx()'s session manager reports. */
const PARENT_ID = "session-1";

/** A bus fake that appends to the shared timeline; the SDK module is mocked here. */
function timelineBus(timeline: string[], onPublished?: (channel: string, data: unknown) => void): EventBus {
  return {
    emit: (channel, data) => {
      timeline.push(channel);
      onPublished?.(channel, data);
    },
    on: () => () => {},
  };
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
    const timeline: string[] = [];
    session.bindExtensions.mockImplementation(async () => {
      timeline.push("bind");
    });

    await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(timelineBus(timeline)) });

    expect(timeline).toEqual(["subagents:child:session-created", "bind", "subagents:child:bound"]);
  });

  it("announces the child's own session id next to the parent's", async () => {
    const published: Array<{ channel: string; data: unknown }> = [];

    await runAgent(fakeCtx(), "test-agent", "task", {
      pi: piWithBus(timelineBus([], (c, d) => published.push({ channel: c, data: d }))),
    });

    expect(published).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
      { channel: "subagents:child:bound", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });

  it("never announces a child whose binding failed, and disposes it exactly once", async () => {
    const timeline: string[] = [];
    session.bindExtensions.mockRejectedValue(new Error("bind failed"));

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(timelineBus(timeline)) })).rejects.toThrow(
      "bind failed",
    );

    expect(timeline).toEqual(["subagents:child:session-created", "subagents:child:disposed"]);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("never hands the parent's event bus to the child's resource loader", async () => {
    const timeline: string[] = [];
    const bus = timelineBus(timeline);

    await runAgent(fakeCtx(), "test-agent", "task", { pi: piWithBus(bus) });

    // Guard against a vacuous pass: the announcement proves the bus was live.
    expect(timeline).not.toEqual([]);
    const loaderOpts = mockModules.getLoaderOpts();
    expect(loaderOpts).not.toBeNull();
    expect(Object.values(loaderOpts!)).not.toContain(bus);
  });

  it("announces a spawn aborted after session creation as bound then disposed", async () => {
    const controller = new AbortController();
    const timeline: string[] = [];
    mockModules.mockCreateAgentSession.mockImplementation(async () => {
      controller.abort();
      return { session, extensionsResult: {} };
    });

    await expect(
      runAgent(fakeCtx(), "test-agent", "task", {
        pi: piWithBus(timelineBus(timeline)),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted during setup/);

    expect(timeline).toEqual(["subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed"]);
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
