/**
 * session-teardown.ts — The one child-session disposal path.
 *
 * pi's AgentSession.dispose() emits no session_shutdown, so built-in
 * extension resources loaded per spawn would survive it. Every termination
 * trigger (settle, stop, clear, parent dispose, setup abort) funnels here:
 * abort, emit session_shutdown, dispose, announce disposed — deduplicated per
 * session.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { announceChildSessionDisposed } from "./child-announcements.ts";

const inFlight = new WeakMap<AgentSession, Promise<void>>();

export function disposeChildSession(session: AgentSession): Promise<void> {
  const existing = inFlight.get(session);
  if (existing) return existing;
  const teardown = (async () => {
    // Each step may throw while the parent is going down, and the manager
    // tracks this promise fire-and-forget: no step may reject.
    try {
      await session.abort();
    } catch {
      /* abort is best-effort */
    }
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      /* a failing extension handler must not skip dispose */
    }
    try {
      session.dispose();
    } catch {
      /* a throwing dispose must not reject the teardown */
    }
    announceChildSessionDisposed(session);
  })();
  inFlight.set(session, teardown);
  return teardown;
}
