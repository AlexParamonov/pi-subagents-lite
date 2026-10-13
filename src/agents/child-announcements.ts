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
 * Fire-and-forget: nothing is awaited, listener failures stay inside pi's bus,
 * and a missing bus makes every announcement a no-op.
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

export function announceChildSessionCreated(
  session: AgentSession,
  events: EventBus | undefined,
  parentSessionId: string,
): void {
  if (!events) return;
  const sessionId = session.sessionId;
  announced.set(session, { events, sessionId, parentSessionId });
  events.emit(CHILD_SESSION_CREATED, { sessionId, parentSessionId });
}

export function announceChildSessionBound(session: AgentSession): void {
  const announcement = announced.get(session);
  if (!announcement) return;
  announcement.events.emit(CHILD_SESSION_BOUND, {
    sessionId: announcement.sessionId,
    parentSessionId: announcement.parentSessionId,
  });
}

export function announceChildSessionDisposed(session: AgentSession): void {
  const announcement = announced.get(session);
  if (!announcement) return;
  announced.delete(session);
  announcement.events.emit(CHILD_SESSION_DISPOSED, { sessionId: announcement.sessionId });
}
