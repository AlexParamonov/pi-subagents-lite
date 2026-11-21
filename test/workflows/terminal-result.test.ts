/**
 * terminal-result.test.ts — The one formatting of a run's terminal `result`.
 *
 * The server owns the value (US-37: opaque, string-keyed JSON); this is where it becomes the
 * answer the parent agent reads, so the classification rules are pinned here rather than
 * scattered over the surfaces that show it. Expected values are worked examples, not a
 * re-run of the code.
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

  // A strategy with no termination reason carries `nil` (measured on anagen-x: a completed ReAct run
  // answers `termination_reason: nil`). `null` and an absent key are the same fact to the reader - the
  // endpoint did not say how the run ended - and echoing the wire's `null` presented an internal
  // nothing as if it were a reason.
  it("says nothing when the reason is spelled `null`, which is how a strategy with none reports it", () => {
    const result = { text: "A partial answer.", termination_reason: null };

    expect(formatTerminalResult(result)).toBe("A partial answer.");
  });

  it("echoes a termination reason the wire delivered as a value, not a word", () => {
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: { cap: "turns" } })).toBe(
      'A partial answer.\n\nTermination reason: {"cap":"turns"}',
    );
    expect(formatTerminalResult({ text: "A partial answer.", termination_reason: 42 })).toBe(
      "A partial answer.\n\nTermination reason: 42",
    );
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

  // Measured on anagen-x (wf-1731-1795296255544, `react_local` on `anagen-x:chain/builder`): the
  // terminal `result` of a ReAct output node is the executor's own `{status, value}` map, and the
  // declared answer with its `thinking` sits inside `value`. Reading only the outer key put the whole
  // envelope, reasoning included, into the text the parent model reads.
  it("is the answer the ReAct envelope carries inside its value", () => {
    const result = {
      status: "ok",
      value: {
        text: "GATE-A-relay-default",
        usage: { cached_tokens: 1152, total_tokens: 1333, thinking_tokens: 54 },
        termination_reason: "final_answer",
        thinking: 'The user is asking me to reply with exactly "GATE-A-relay-default".',
      },
    };

    expect(formatTerminalResult(result)).toBe("GATE-A-relay-default");
  });

  // Triangulation: the provenance lives beside the answer, not beside the envelope's status, so a
  // stub that unwrapped only `value.text` and reported the outer reason could not pass.
  it("keeps the provenance that sits beside the answer inside the envelope", () => {
    const result = {
      status: "ok",
      value: { text: "I ran out of turns.", termination_reason: "max_iterations", thinking: "private" },
    };

    expect(formatTerminalResult(result)).toBe("I ran out of turns.\n\nTermination reason: max_iterations");
  });
});

describe("a result from another kind of producer", () => {
  it("is the value itself, nested nulls and all", () => {
    const result = { nested: null, values: [1, false], summary: "kept" };

    expect(JSON.parse(formatTerminalResult(result))).toEqual(result);
  });

  it("is the array itself, nulls inside it kept as data", () => {
    expect(formatTerminalResult([{ text: "first" }, null, false])).toBe('[{"text":"first"},null,false]');
  });

  it("keeps a scalar answer as the JSON it is", () => {
    expect(formatTerminalResult(0)).toBe("0");
    expect(formatTerminalResult(false)).toBe("false");
    expect(formatTerminalResult("reviewed 3 files")).toBe('"reviewed 3 files"');
  });

  // `text` is the answer contract every producer keeps (ADR-0023 requires it of a local handler),
  // so the rest of the value - a local handler's own payload, a Pi run's transcript - is no longer
  // dumped into the text the parent agent reads. It reaches the reader through the call's details.
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

describe("a completed run with nothing in the result slot", () => {
  it("says there was no output rather than answering empty", () => {
    expect(formatTerminalResult(null)).toBe("The workflow run completed with no output.");
  });

  it("says so when the declared output was an empty answer", () => {
    expect(formatTerminalResult({ text: "", termination_reason: "final_answer" })).toBe(
      "The workflow run completed with no output.",
    );
  });

  // The producer really emits this shape: `react_local`'s terminal-tool path completes with an
  // empty text, so an empty answer is a delivered value and its provenance is the only meaning left.
  it("keeps the provenance beside an answer the producer left empty", () => {
    expect(formatTerminalResult({ text: "", usage: { input_tokens: 5 }, termination_reason: "terminal_tool" })).toBe(
      "The workflow run completed with no output.\n\nTermination reason: terminal_tool",
    );
  });

  it("says no provenance when an empty answer carries no reason either", () => {
    expect(formatTerminalResult({ text: "" })).toBe("The workflow run completed with no output.");
  });
});
