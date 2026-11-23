/**
 * note-words.ts — The committed word rule a workflow hand-back note must obey, shared by the unit
 * seam that composes the note and the acceptance seam that reads it back.
 */

/**
 * What no hand-back note may claim: that a stop was performed, or that it succeeded. The honest
 * denials a note is required to carry are removed first, so any stop wording left behind is a claim
 * about a stop the endpoint never confirmed - whether the run issued one whose landing is unknown,
 * or never issued one at all.
 */
const HONEST_STOP_DENIALS = [/nothing(?: more)? was stopped/gi, /stop failed/gi];

export function claimsAStop(note: string): string[] {
  const wording = HONEST_STOP_DENIALS.reduce((rest, denial) => rest.replace(denial, ""), note);
  return wording.match(/\bstop(?:s|ped|ping)?\b/gi) ?? [];
}
