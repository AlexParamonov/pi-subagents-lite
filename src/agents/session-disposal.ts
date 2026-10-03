import type { AgentSession, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

interface DisposableSession extends Pick<AgentSession, "abort" | "dispose"> {
  extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
}

const disposals = new WeakMap<DisposableSession, Promise<void>>();

/** dispose() alone does not emit the lifecycle event that closes extension resources. */
export function disposeAgentSession(session: DisposableSession): Promise<void> {
  const previous = disposals.get(session);
  if (previous) return previous;
  const pending = (async () => {
    try {
      await session.abort();
    } finally {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    }
  })();
  disposals.set(session, pending);
  return pending;
}
