/**
 * session-teardown.ts — The one child-session disposal path.
 *
 * pi's AgentSession.dispose() emits no session_shutdown, so built-in
 * extension resources loaded per spawn would survive it. Every termination
 * trigger (settle, stop, clear, parent dispose, setup abort) funnels here:
 * abort, emit session_shutdown, dispose — deduplicated per session.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

const inFlight = new WeakMap<AgentSession, Promise<void>>();

export function disposeChildSession(session: AgentSession): Promise<void> {
  const existing = inFlight.get(session);
  if (existing) return existing;
  const teardown = (async () => {
    // abort() and emit() fire from listeners/handlers; either may reject while
    // the parent is going down. Disposal must proceed regardless.
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
    session.dispose();
  })();
  inFlight.set(session, teardown);
  return teardown;
}
