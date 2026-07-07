import type { AgentLifecycle } from "./types.js";

const NOTES: Record<string, string> = {
  stoppedByUser: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  stoppedByAgent: "stopped before completion — output is partial; the task was NOT finished",
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

export function getStatusNote(lifecycle: AgentLifecycle): string {
  let noteKey = lifecycle.status as string;
  if (noteKey === "stopped") {
    noteKey = lifecycle.stoppedBy === "user" ? "stoppedByUser" : "stoppedByAgent";
  }
  const note = NOTES[noteKey];
  return note ? ` (${note})` : "";
}
