/**
 * terminal-result.ts — The one place a run's terminal `result` becomes text.
 *
 * The server owns the value: it is opaque, string-keyed JSON (US-37), formatted once at
 * settlement so every surface that shows the run shows the same string. Nothing here reads a
 * streamed event, and nothing reshapes a producer's payload.
 */

import { plainText } from "../ui/sanitize.ts";
import { record } from "./payload.ts";

/** The one `termination_reason` that means the model answered on its own. Every other value —
 * absent, null, or a cap — is provenance the answer needs, because a cap burnout's text is
 * otherwise indistinguishable from a real answer.
 */
const NATURAL_ANSWER = "final_answer";

/** GET's `result: null` beside a completed status is an empty slot, not an empty answer. */
const NO_OUTPUT = "The workflow run completed with no output.";

/** The whole ReAct key set (US-37). Anything beside these keys is another producer's payload,
 * whose value must reach the reader whole rather than as one field of it.
 */
const REACT_KEYS = new Set(["text", "usage", "termination_reason", "thinking"]);

export function formatTerminalResult(result: unknown): string {
  if (result === null) return NO_OUTPUT;
  const body = record(result);
  const text = body && Object.keys(body).every((key) => REACT_KEYS.has(key)) ? body.text : undefined;
  if (typeof text !== "string") return plainText(unchanged(result));
  if (text === "") return NO_OUTPUT;
  const answer = plainText(text);
  const reason = body?.termination_reason;
  return reason === NATURAL_ANSWER ? answer : `${answer}\n\n${plainText(`Termination reason: ${shown(reason)}`)}`;
}

function unchanged(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "null" : json;
}

/** The reason as the wire carried it; `absent` is the one state with no value to echo. */
function shown(reason: unknown): string {
  if (reason === undefined) return "absent";
  if (typeof reason === "string") return reason;
  const json = JSON.stringify(reason);
  return json === undefined ? typeof reason : json;
}
