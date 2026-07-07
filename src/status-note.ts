import type { AgentLifecycle, AgentStatus, StopInitiator } from "./types.js";

const STATUS_NOTES: Partial<Record<AgentStatus, string>> = {
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

const STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent: "stopped before completion — output is partial; the task was NOT finished",
};

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      // A stopped agent with no recorded initiator reads as an agent stop.
      ? STOP_NOTES[lifecycle.stoppedBy ?? "agent"]
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
