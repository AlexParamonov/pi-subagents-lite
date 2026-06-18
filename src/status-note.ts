const NOTES: Record<string, string> = {
  stopped: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

export function getStatusNote(status: string): string {
  const note = NOTES[status];
  return note ? ` (${note})` : "";
}
