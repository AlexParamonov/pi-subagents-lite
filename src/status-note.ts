/**
 * status-note.ts — Parenthetical status note appended to agent result text.
 *
 * Explicit note for non-normal terminal outcomes so the parent agent can't
 * mistake partial output for a completed result. Empty string for clean
 * completion (and any unknown/non-terminal status).
 *
 * `stopped` (human abort) is deliberately distinct from `aborted` (turn
 * budget cutoff) — the parent should treat them differently.
 */
const NOTES: Record<string, string> = {
  stopped: " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
  aborted: " (aborted — hit the turn limit before completion; output may be incomplete)",
  turn_limited: " (wrapped up at the turn limit — output may be partial)",
};

export function getStatusNote(status: string): string {
  return NOTES[status] ?? "";
}
