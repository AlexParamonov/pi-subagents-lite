import type { AgentLifecycle } from "./types.js";

const NOTES: Record<string, string> = {
  stoppedByUser: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  stoppedByAgent: "stopped before completion — output is partial; the task was NOT finished",
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      ? lifecycle.stoppedBy === "user"
        ? NOTES.stoppedByUser
        : NOTES.stoppedByAgent
      : NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
