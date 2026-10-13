/**
 * child-announcements.test.ts — The child-lifecycle wire format.
 *
 * Lite publishes the subagent-integration convention's channels on the parent's
 * event bus; an external gate subscribes to them by name. These tests pin the
 * channel literals, the payload objects, the missing-bus no-op, the dropped
 * emit rejection and its diagnostic, and exactly-once disposal.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { refusingEvents } from "../fixtures.js";
import {
  announceChildSessionBound,
  announceChildSessionCreated,
  announceChildSessionDisposed,
} from "../../src/agents/child-announcements.js";
import { asAgentSession } from "../pi-boundaries.js";

const CHILD_ID = "0f0f0f0f-1111-4111-8111-000000000001";
const PARENT_ID = "aaaaaaaa-2222-4222-8222-000000000002";

function recordingBus() {
  const bus = createEventBus();
  const published: Array<{ channel: string; data: unknown }> = [];
  return {
    bus,
    published,
    watch(...channels: string[]) {
      for (const channel of channels) bus.on(channel, (data) => published.push({ channel, data }));
    },
  };
}

let warn: Mock<Console["warn"]>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("announceChildSessionCreated", () => {
  it("publishes the convention's created channel with the child and parent session ids", () => {
    const { bus, watch, published } = recordingBus();
    watch("subagents:child:session-created");

    announceChildSessionCreated(asAgentSession({ sessionId: CHILD_ID }), bus, PARENT_ID);

    expect(published).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });
});

describe("announceChildSessionBound", () => {
  it("publishes the convention's bound channel with the same identifiers", () => {
    const { bus, watch, published } = recordingBus();
    watch("subagents:child:bound");
    const session = asAgentSession({ sessionId: CHILD_ID });
    announceChildSessionCreated(session, bus, PARENT_ID);

    announceChildSessionBound(session);

    expect(published).toEqual([
      { channel: "subagents:child:bound", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });
});
describe("announceChildSessionDisposed", () => {
  it("publishes the convention's disposed channel with the child session id only", () => {
    const { bus, watch, published } = recordingBus();
    watch("subagents:child:disposed");
    const session = asAgentSession({ sessionId: CHILD_ID });
    announceChildSessionCreated(session, bus, PARENT_ID);

    announceChildSessionDisposed(session);

    expect(published).toEqual([{ channel: "subagents:child:disposed", data: { sessionId: CHILD_ID } }]);
  });

  it("publishes once however many termination triggers reach the same child", () => {
    const { bus, watch, published } = recordingBus();
    watch("subagents:child:disposed");
    const session = asAgentSession({ sessionId: CHILD_ID });
    announceChildSessionCreated(session, bus, PARENT_ID);

    announceChildSessionDisposed(session);
    announceChildSessionDisposed(session);

    expect(published).toHaveLength(1);
  });

  it("publishes nothing for a child session that was never announced", () => {
    const { bus, watch, published } = recordingBus();
    watch("subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed");

    expect(() => announceChildSessionDisposed(asAgentSession({ sessionId: CHILD_ID }))).not.toThrow();

    expect(published).toEqual([]);
  });
});

describe("without an event bus", () => {
  it("every announcement is a no-op", () => {
    const session = asAgentSession({ sessionId: CHILD_ID });

    expect(() => {
      announceChildSessionCreated(session, undefined, PARENT_ID);
      announceChildSessionBound(session);
      announceChildSessionDisposed(session);
    }).not.toThrow();

    expect(warn.mock.calls).toEqual([]);
  });
});

describe("when the bus refuses the emit (pi's stale extension ctx)", () => {
  it("no announcement throws into the caller", () => {
    const events = refusingEvents();
    const session = asAgentSession({ sessionId: CHILD_ID });

    expect(() => {
      announceChildSessionCreated(session, events, PARENT_ID);
      announceChildSessionBound(session);
      announceChildSessionDisposed(session);
    }).not.toThrow();
  });

  it("warns once per dropped announcement, naming the Subagent and that channel", () => {
    const events = refusingEvents();
    const session = asAgentSession({ sessionId: CHILD_ID });

    announceChildSessionCreated(session, events, PARENT_ID);
    announceChildSessionBound(session);
    announceChildSessionDisposed(session);

    const lines = warn.mock.calls.map((call) => call.join(" "));
    expect(lines).toEqual([
      expect.stringContaining("subagents:child:session-created"),
      expect.stringContaining("subagents:child:bound"),
      expect.stringContaining("subagents:child:disposed"),
    ]);
    for (const line of lines) expect(line).toContain(CHILD_ID);
  });

  it("names the Subagent by its session name, the handle the user holds", () => {
    const events = refusingEvents();
    const session = asAgentSession({ sessionId: CHILD_ID, sessionName: "Explore#a1b2c3d4" });

    announceChildSessionCreated(session, events, PARENT_ID);
    announceChildSessionBound(session);
    announceChildSessionDisposed(session);

    const lines = warn.mock.calls.map((call) => call.join(" "));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain("Explore#a1b2c3d4");
      expect(line).toContain(CHILD_ID);
    }
  });
});

describe("while the bus accepts the announcements", () => {
  it("publishes no diagnostic", () => {
    const { bus } = recordingBus();
    const session = asAgentSession({ sessionId: CHILD_ID });

    announceChildSessionCreated(session, bus, PARENT_ID);
    announceChildSessionBound(session);
    announceChildSessionDisposed(session);

    expect(warn.mock.calls).toEqual([]);
  });
});
