/**
 * child-announcements.test.ts — The child-lifecycle wire format.
 *
 * Lite publishes the subagent-integration convention's channels on the parent's
 * event bus; an external gate subscribes to them by name. These tests pin the
 * channel literals, the payload objects, the missing-bus no-op and exactly-once
 * disposal.
 */

import { describe, it, expect } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
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
  });
});
