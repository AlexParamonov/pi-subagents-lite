/**
 * terminal-result.ts — The one place a run's terminal `result` becomes text.
 *
 * The server owns the value: it is opaque, string-keyed JSON (US-37), and `text` is the one key that
 * declares an answer. So this publishes `text`, and publishes nothing else of the value: no other
 * field, and no whole-value fallback for a shape the producer chose freely (a `local` handler's stored
 * output is its own value, which the server's own acceptance test pins as textless data such as
 * `{headline, chars}`). Whatever the value holds is copied nowhere either - every client-side home for
 * it, tool `details` above all, is model-reachable or unredacted. The endpoint's stored result, read
 * by an authorized GET, is the only place a full payload exists. Nothing here reads a streamed event,
 * and nothing reshapes a producer's payload.
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

/** A delivered answer that is empty: a value the producer sent, not a slot the server left empty. */
const EMPTY_ANSWER = "The workflow run completed with an empty answer.";

/** A completed run whose stored output declares no `text`. The three outcomes are deliberately
 * distinct: nothing stored, something stored with an empty answer, something stored with no answer.
 */
const UNDECLARED = "The workflow run stored its output on the endpoint without declaring an answer.";

export function formatTerminalResult(result: unknown): string {
  const body = result === null ? undefined : record(result);
  // A declared `text` is the answer. A bare string is the answer too: it carries no nested payload of
  // any kind, so publishing it cannot smuggle a producer's internal field. Anything else - a map, an
  // array, a number - is data whose shape the producer chose, and is not published.
  const text = typeof body?.text === "string" ? body.text : typeof result === "string" ? result : undefined;
  // Computed before the empty answer, because an empty `text` is a delivered value and the reason is
  // then the only provenance the reader gets: a terminal-tool run completes with "".
  const note = provenance(body?.termination_reason);
  if (text !== undefined) return `${text === "" ? EMPTY_ANSWER : plainText(text)}${note}`;
  // No declared answer, so none of the value is quoted: it can be any shape the producer chose, an
  // earlier node's reasoning among them, and the reader is better served by the honest fact.
  return `${result === null ? NO_OUTPUT : UNDECLARED}${note}`;
}

/**
 * Why the run ended, or nothing. Only a string is provenance text: a reason the wire delivered as a
 * value is producer data whose shape the producer chose, and an absent key, a `null` and an empty
 * string all say the same thing - the endpoint did not report how the run ended (the endpoint's own
 * encoding carries `nil` there).
 */
function provenance(reason: unknown): string {
  if (typeof reason !== "string" || reason === "" || reason === NATURAL_ANSWER) return "";
  return `\n\n${plainText(`Termination reason: ${reason}`)}`;
}
