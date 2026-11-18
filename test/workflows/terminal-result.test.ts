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

  it("names an absent termination reason instead of implying an answer", () => {
    const result = { text: "A partial answer.", usage: {} };

    expect(formatTerminalResult(result)).toBe("A partial answer.\n\nTermination reason: absent");
  });

  it("echoes a null termination reason as the wire value it is", () => {
    const result = { text: "A partial answer.", termination_reason: null };

    expect(formatTerminalResult(result)).toBe("A partial answer.\n\nTermination reason: null");
  });

  it("strips terminal control sequences from the server's answer", () => {
    const result = { text: "Visible answer \u001b[?25l safe suffix", termination_reason: "final_answer" };

    expect(formatTerminalResult(result)).toBe("Visible answer  safe suffix");
  });
});

describe("a result from another kind of producer", () => {
  it("is the value itself, nested nulls and all", () => {
    const result = { nested: null, values: [1, false], summary: "kept" };

    expect(JSON.parse(formatTerminalResult(result))).toEqual(result);
  });

  it("keeps a scalar answer as the JSON it is", () => {
    expect(formatTerminalResult(0)).toBe("0");
    expect(formatTerminalResult(false)).toBe("false");
    expect(formatTerminalResult("reviewed 3 files")).toBe('"reviewed 3 files"');
  });

  it("is untouched when it merely carries a status of its own", () => {
    const result = { status: "completed", text: "A declared output that happens to name a status." };

    expect(JSON.parse(formatTerminalResult(result))).toEqual(result);
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

  it("keeps the provenance when an empty answer carries no reason either", () => {
    expect(formatTerminalResult({ text: "" })).toBe(
      "The workflow run completed with no output.\n\nTermination reason: absent",
    );
  });
});
