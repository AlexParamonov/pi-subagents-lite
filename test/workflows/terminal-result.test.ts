/**
 * terminal-result.test.ts — The one formatting of a run's terminal `result`.
 *
 * The server owns the value (US-37: opaque, string-keyed JSON); this is where it becomes the answer
 * the parent agent reads, so the rules are pinned here rather than scattered over the surfaces that
 * show it. Expected values are worked examples, not a re-run of the code.
 */

import { describe, expect, it } from "vite-plus/test";
import { formatTerminalResult } from "../../src/workflows/terminal-result.js";

describe("the answer a completed run delivers", () => {
  it("is the ReAct payload's text", () => {
    const result = {
      text: "Two findings, one nit.",
      usage: { input_tokens: 341, output_tokens: 12 },
      thinking: "private chain of thought",
      termination_reason: "final_answer",
    };

    expect(formatTerminalResult(result)).toBe("Two findings, one nit.");
  });

  it("says so when a cap stopped the run rather than an answer", () => {
    const result = { text: "I ran out of turns.", termination_reason: "max_iterations" };

    expect(formatTerminalResult(result)).toBe("I ran out of turns.\n\nTermination reason: max_iterations");
  });

  // A producer that reports no reason at all has said nothing about how it ended, so nothing is
  // said: `echo` and a narrow `local` handler complete with `{text, usage}` and no such field, and
  // the line this used to print described a field the endpoint never sent.
  it("says nothing about provenance the producer never reported", () => {
    const result = { text: "A partial answer.", usage: {} };

    expect(formatTerminalResult(result)).toBe("A partial answer.");
  });

  // A strategy with no termination reason carries `nil` (measured on the workflow API: a completed ReAct run
  // answers `termination_reason: nil`). `null` and an absent key are the same fact to the reader - the
  // endpoint did not say how the run ended - and echoing the wire's `null` presented an internal
  // nothing as if it were a reason.
  it("says nothing when the reason is spelled `null`, which is how a strategy with none reports it", () => {
    const result = { text: "A partial answer.", termination_reason: null };

    expect(formatTerminalResult(result)).toBe("A partial answer.");
  });

  // A reason the wire delivered as a value is producer data, not provenance text: that slot can hold
  // an earlier node's reasoning among it, which is exactly what spec §5 keeps out of the answer.
  it("says nothing when the reason is an empty string, which says nothing either", () => {
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: "" })).toBe("A partial answer.");
  });

  it("says nothing about a reason the wire delivered as a value, not a word", () => {
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: { cap: "turns" } })).toBe(
      "A partial answer.",
    );
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: 42 })).toBe("A partial answer.");
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: false })).toBe("A partial answer.");
  });

  it("strips terminal control sequences from the server's answer", () => {
    const result = { text: "Visible answer \u001b[?25l safe suffix", termination_reason: "final_answer" };

    expect(formatTerminalResult(result)).toBe("Visible answer  safe suffix");
  });

  // The withheld-by-shape rule is what used to hide a reasoning block: any key outside the expected
  // set moved the value to the print-it-whole branch, `thinking` with it.
  it("keeps a reasoning block out of the answer whatever other fields the value carries", () => {
    const result = { text: "The audit found two issues.", thinking: "private chain of thought", notes: 2 };

    expect(formatTerminalResult(result)).toBe("The audit found two issues.");
  });
});

// A `local` handler's stored output is its own value: the workflow API unwraps the inner `result` before
// storing it, and its acceptance test pins a textless one (`{headline, chars}`). Forwarding that whole
// would put arbitrary nested data - which can be an earlier node's reasoning - into the text the parent
// agent reads, so an undeclared output says what it is and quotes none of it.
describe("a result that declares no answer", () => {
  const UNDECLARED = "The workflow run stored its output on the endpoint without declaring an answer.";

  it.for([
    { label: "a local handler's payload", value: { headline: "a long build narrative", chars: 22 } },
    { label: "a nested map", value: { nested: null, values: [1, false] } },
    { label: "an array", value: [{ text: "first" }, null, false] },
    { label: "a number", value: 0 },
    { label: "a boolean", value: false },
  ])("names the undeclared output for $label and quotes none of it", ({ value }) => {
    expect(formatTerminalResult(value)).toBe(UNDECLARED);
  });

  // A bare string carries no nested field to hide, so it is the answer rather than undeclared data.
  it("is a bare string result, as the text it is and without the JSON quotes", () => {
    expect(formatTerminalResult("reviewed 3 files")).toBe("reviewed 3 files");
  });

  it("keeps a reasoning block out of an undeclared output", () => {
    expect(formatTerminalResult({ thinking: "private chain of thought", result: { deployed: true } })).toBe(UNDECLARED);
  });

  // An undeclared output still gets the provenance the producer reported: a cap burnout whose handler
  // returned no `text` must not read as a clean answer either.
  it("keeps a reported reason beside an undeclared output", () => {
    expect(formatTerminalResult({ chars: 22, termination_reason: "max_iterations" })).toBe(
      `${UNDECLARED}\n\nTermination reason: max_iterations`,
    );
  });

  it("keeps a value-shaped reason out of an undeclared output too", () => {
    expect(formatTerminalResult({ chars: 22, termination_reason: { cap: "turns" } })).toBe(UNDECLARED);
  });

  // `text` is the declared answer, and the rest of the value is never part of the published text -
  // a local handler's own payload, a Pi run's transcript, token counters.
  it("is the declared answer alone, whatever else the value carries", () => {
    const result = {
      status: "completed",
      text: "A declared output that happens to name a status.",
      result: { deployed: true },
      raw_messages: [{ role: "assistant", content: "..." }],
    };

    expect(formatTerminalResult(result)).toBe("A declared output that happens to name a status.");
  });
});

// The three completed outcomes the endpoint can leave in the slot are three facts, and the reader is
// served by hearing which one it got: nothing stored, an empty answer delivered, or a stored output
// that declares no answer.
describe("a completed run with an empty result", () => {
  it("says there was no output when the slot itself is empty", () => {
    expect(formatTerminalResult(null)).toBe("The workflow run completed with no output.");
  });

  it("says the answer was empty when the producer declared one", () => {
    expect(formatTerminalResult({ text: "", termination_reason: "final_answer" })).toBe(
      "The workflow run completed with an empty answer.",
    );
  });

  // The producer really emits this shape: `react_local`'s terminal-tool path completes with an
  // empty text, so an empty answer is a delivered value and its provenance is the only meaning left.
  it("keeps the provenance beside an answer the producer left empty", () => {
    expect(formatTerminalResult({ text: "", usage: { input_tokens: 5 }, termination_reason: "terminal_tool" })).toBe(
      "The workflow run completed with an empty answer.\n\nTermination reason: terminal_tool",
    );
  });

  it("says no provenance when an empty answer carries no reason either", () => {
    expect(formatTerminalResult({ text: "" })).toBe("The workflow run completed with an empty answer.");
  });
});
