/**
 * terminal-result.ts — The one place a run's terminal `result` becomes text.
 *
 * The server owns the value: it is opaque, string-keyed JSON (US-37). One key is promised across
 * producers - `text` is the answer, and ADR-0023 requires it of a local handler - so that field is
 * what the parent agent reads and nothing else about the value is guessed at. What the value holds
 * besides the answer is copied nowhere: every client-side home for it - tool `details` above all - is
 * model-reachable or unredacted, and the endpoint's stored result stays the place to read it. Nothing
 * here reads a streamed event, and nothing reshapes a producer's payload.
 */

import { plainText } from "../ui/sanitize.ts";
import { record } from "./payload.ts";

/** The one `termination_reason` that means the model answered on its own. Every other value is
 * provenance the answer needs, because a cap burnout's text is otherwise indistinguishable from a
 * real answer.
 */
const NATURAL_ANSWER = "final_answer";

/** GET's `result: null` beside a completed status is an empty slot, not an empty answer. */
const NO_OUTPUT = "The workflow run completed with no output.";

export function formatTerminalResult(result: unknown): string {
  if (result === null) return NO_OUTPUT;
  const body = record(declared(result));
  const text = typeof body?.text === "string" ? body.text : undefined;
  // A value with no declared answer is its own answer, kept whole.
  if (text === undefined) return plainText(unchanged(result));
  // Computed before the empty answer, because an empty `text` is a delivered value and the reason is
  // then the only provenance the reader gets: a terminal-tool run completes with "".
  return (text === "" ? NO_OUTPUT : plainText(text)) + provenance(body?.termination_reason);
}

/**
 * The layer a non-`local` output node stores its answer behind: `{"status":"ok","value":{...}}`,
 * measured on anagen-x (wf-1731-1795296255544, `react_local` on `anagen-x:chain/builder`). The answer,
 * its provenance and any `thinking` all live inside `value`, so that layer is stepped through once -
 * printing the outer map instead would put the reasoning block into the text a model reads. A map
 * without both keys is its own answer, which is what a `local` handler's stored value is.
 */
function declared(value: unknown): unknown {
  const outer = record(value);
  return outer && "status" in outer && "value" in outer ? outer.value : value;
}

/**
 * Why the run ended, or nothing. An absent key and a `null` are one fact to the reader - the endpoint
 * did not say how the run ended, which is what a strategy with no reason field reports (anagen-x
 * carries `nil` there) - and neither is a reason worth printing. Any value the producer did report is
 * echoed as the wire gave it.
 */
function provenance(reason: unknown): string {
  if (reason === undefined || reason === null || reason === NATURAL_ANSWER) return "";
  return `\n\n${plainText(`Termination reason: ${shown(reason)}`)}`;
}

function unchanged(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "null" : json;
}

/** The reason as the wire carried it: text stays itself, anything else is shown as its JSON. */
function shown(reason: unknown): string {
  if (typeof reason === "string") return reason;
  const json = JSON.stringify(reason);
  return json === undefined ? typeof reason : json;
}
