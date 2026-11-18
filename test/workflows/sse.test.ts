/**
 * sse.test.ts — The workflow stream's framing rules.
 *
 * The bytes come from the captured corpus (`recorded/`), plus the two framings a capture cannot
 * give on demand: a frame split across transport chunks, and CRLF, which an intermediary may send.
 * The parser carries no run state: it turns bytes into frames and nothing else.
 */

import { describe, expect, it } from "vite-plus/test";
import { SseParser } from "../../src/workflows/sse.js";
import {
  CHUNK_MULTILINE,
  crlf,
  DISPATCH,
  framesOf,
  PING,
  RECONNECT,
  recorded,
  TERMINAL,
  textFrame,
} from "./fixtures.js";

function frames(...chunks: string[]) {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe("SseParser", () => {
  it("dispatches a frame only at its blank line", () => {
    const parser = new SseParser();

    expect(parser.push(textFrame("Progress on the run"))).toEqual([{ event: null, data: "Progress on the run" }]);
    expect(parser.push("data: not finished\n")).toEqual([]);
  });

  it("joins a payload framed one data line per payload line", () => {
    expect(frames(CHUNK_MULTILINE)).toEqual([
      { event: null, data: "Inspecting the repository\n\nReporting three findings after a blank line" },
    ]);
  });

  it("keeps the event name and drops the fields this client never reads", () => {
    expect(frames(DISPATCH, TERMINAL)).toEqual([
      {
        event: "node_dispatched",
        data: '{"task_id":"wf-capture-declared","event":"node_dispatched","user_message":"Review changes","correlation_id":"corr-1","ts":1700000001000,"workflow_id":"wf-capture-declared","node_id":"analysis"}',
      },
      {
        event: "workflow_engine_finished",
        data: '{"result":{"status":"completed"},"task_id":"wf-capture-declared","event":"workflow_engine_finished","correlation_id":"corr-1","ts":1700000003000,"workflow_id":"wf-capture-declared"}',
      },
    ]);
  });

  it("reassembles a frame split across transport chunks", () => {
    const frame = framesOf(recorded("replay-declared.sse"))[1]!;
    const middle = Math.floor(frame.length / 2);

    expect(frames(frame.slice(0, middle), frame.slice(middle))).toEqual([
      {
        event: "node_dispatched",
        data: '{"started_at":1700000001000,"task_id":"wf-capture-declared","user_message":"Review changes","correlation_id":"corr-1","workflow_id":"wf-capture-declared","node_id":"analysis"}',
      },
    ]);
  });

  it("reframes CRLF line endings held across a chunk boundary", () => {
    // The cut falls between a CR and the LF that completes its line ending: a lone trailing CR
    // must not be read as a line boundary, or the frame's terminating blank line arrives early.
    const chunk = crlf(textFrame("Progress on the run"));
    const cut = chunk.lastIndexOf("\r");

    const parsed = frames(chunk.slice(0, cut), chunk.slice(cut));

    expect(parsed).toEqual([{ event: null, data: "Progress on the run" }]);
  });

  it("dispatches every frame of a captured connection in order", () => {
    expect(frames(recorded("live-stream.sse")).map((frame) => frame.event)).toEqual([
      null,
      "thinking_delta",
      "node_dispatched",
      "node_complete",
      "workflow_engine_finished",
    ]);
  });

  it("drops a keepalive and dispatches the max-duration reconnect that follows it", () => {
    expect(frames(PING + RECONNECT)).toEqual([{ event: "reconnect", data: '{"reason":"max_duration"}' }]);
  });

  it("ignores comments and frames that carry no data", () => {
    expect(frames(": ping\n\n", "\n\n", "id: 7\n\n")).toEqual([]);
  });
});
