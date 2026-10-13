/**
 * child-announcements.ts — Lite's publisher for the child-session lifecycle
 * channels of the subagent-integration convention. That convention's document
 * (docs/subagent-integration.md in @gotgenes/pi-permission-system) owns the
 * channel names and payload shapes below: never rename them or add fields.
 *
 * Three invariants the code cannot carry:
 * - `created` shares the child's `bindExtensions()` call stack. A subscriber
 *   registers the child synchronously, and the child's own extensions choose
 *   their permission authority during that bind.
 * - The parent's bus is never handed to a child's resource loader, which would
 *   let child-loaded extensions read parent traffic and forge these events.
 * - `disposed` is the last step of the deduped teardown, not the run's `finally`
 *   as the convention words it: lite keeps a settled child session alive for
 *   continuations. A child left registered leaks the subscriber's entry for the
 *   whole process.
 *
 * Fire-and-forget: nothing is awaited, a missing bus makes every announcement a
 * no-op, and a refused emit is dropped here instead of into a spawn or a
 * teardown. The emit is not a bare call: pi gives extensions `pi.events`, a
 * guarded facade that throws once the session which loaded the extension has
 * been disposed, reloaded or replaced, so a child settling after that point
 * would otherwise fail the teardown it is announced from.
 */

import type { AgentSession, EventBus } from "@earendil-works/pi-coding-agent";

const CHILD_SESSION_CREATED = "subagents:child:session-created";
const CHILD_SESSION_BOUND = "subagents:child:bound";
const CHILD_SESSION_DISPOSED = "subagents:child:disposed";

/** Everything a child was announced with, kept for its later announcements. */
interface ChildAnnouncement {
  events: EventBus;
  sessionId: string;
  parentSessionId: string;
}

/** Per-spawn carrier: the bus a child was announced on outlives the spawn call. */
const announced = new WeakMap<AgentSession, ChildAnnouncement>();

/** The payload of every channel, as the convention defines it. */
type ChildPayload = { sessionId: string; parentSessionId?: string };

function publish(events: EventBus, channel: string, payload: ChildPayload): void {
  try {
    events.emit(channel, payload);
  } catch {
    /* a stale extension ctx must not fail a spawn or a teardown: advisory event */
  }
}

export function announceChildSessionCreated(
  session: AgentSession,
  events: EventBus | undefined,
  parentSessionId: string,
): void {
  if (!events) return;
  const sessionId = session.sessionId;
  announced.set(session, { events, sessionId, parentSessionId });
  publish(events, CHILD_SESSION_CREATED, { sessionId, parentSessionId });
}

export function announceChildSessionBound(session: AgentSession): void {
  const announcement = announced.get(session);
  if (!announcement) return;
  publish(announcement.events, CHILD_SESSION_BOUND, {
    sessionId: announcement.sessionId,
    parentSessionId: announcement.parentSessionId,
  });
}

export function announceChildSessionDisposed(session: AgentSession): void {
  const announcement = announced.get(session);
  if (!announcement) return;
  announced.delete(session);
  publish(announcement.events, CHILD_SESSION_DISPOSED, { sessionId: announcement.sessionId });
}
