/**
 * child-announcements.test.ts — The child-lifecycle wire format: the channel
 * names and payload objects a live subscriber on the parent's real pi event bus
 * hears. The subagent-integration convention (docs/subagent-integration.md in
 * @gotgenes/pi-permission-system) owns those names and shapes.
 *
 * The coverage this feature deliberately does not keep is listed in
 * tasks/lessons.md.
 */

import { describe, it, expect } from "vite-plus/test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import {
  announceChildSessionBound,
  announceChildSessionCreated,
  announceChildSessionDisposed,
} from "../../src/agents/child-announcements.js";
import { asAgentSession } from "../pi-boundaries.js";

const CHILD_ID = "0f0f0f0f-1111-4111-8111-000000000001";
const PARENT_ID = "aaaaaaaa-2222-4222-8222-000000000002";
const CHANNELS = ["subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed"];

/** The real pi bus, with a live subscriber on every channel of the convention. */
function liveSubscriber(): { events: EventBus; heard: Array<{ channel: string; data: unknown }> } {
  const events = createEventBus();
  const heard: Array<{ channel: string; data: unknown }> = [];
  for (const channel of CHANNELS) events.on(channel, (data) => heard.push({ channel, data }));
  return { events, heard };
}

describe("child-session lifecycle channels", () => {
  it("created carries the child session id next to a parent session id that differs from it", () => {
    const { events, heard } = liveSubscriber();

    announceChildSessionCreated(asAgentSession({ sessionId: CHILD_ID }), events, PARENT_ID);

    expect(heard).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });

  it("bound carries the identifiers created carried, on its own channel", () => {
    const { events, heard } = liveSubscriber();
    const session = asAgentSession({ sessionId: CHILD_ID });
    announceChildSessionCreated(session, events, PARENT_ID);

    announceChildSessionBound(session);

    expect(heard).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
      { channel: "subagents:child:bound", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
    ]);
  });

  it("disposed carries the child session id alone", () => {
    const { events, heard } = liveSubscriber();
    const session = asAgentSession({ sessionId: CHILD_ID });
    announceChildSessionCreated(session, events, PARENT_ID);

    announceChildSessionDisposed(session);

    expect(heard).toEqual([
      { channel: "subagents:child:session-created", data: { sessionId: CHILD_ID, parentSessionId: PARENT_ID } },
      { channel: "subagents:child:disposed", data: { sessionId: CHILD_ID } },
    ]);
  });
});
