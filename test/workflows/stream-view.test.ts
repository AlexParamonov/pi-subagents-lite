/**
 * stream-view.test.ts — The lines a connection's display state becomes.
 *
 * `progressLines` is the seam the tool call's result view is built from: one line per display item,
 * in the order the connection's state lists them. The state itself (which channel of a node's text
 * is shown, what a replayed journal sets) is pinned through the client in `workflow-client.test.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import { progressLines } from "../../src/workflows/stream-view.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";

describe("progressLines", () => {
  it("shows one status line per node, one tool line, and the streamed text", () => {
    const items: WorkflowDisplayItem[] = [
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "activity", node: "analysis", activity: "read_file" },
      { type: "text", node: "analysis", text: "Inspecting the repository" },
      { type: "node-status", node: "report", status: "failed" },
      { type: "text", node: null, text: "and a chunk naming no node" },
    ];

    expect(progressLines(items)).toEqual([
      "\u25b6 analysis dispatched",
      "  analysis tool read_file",
      "  Inspecting the repository",
      "\u2717 report failed",
      "  and a chunk naming no node",
    ]);
  });

  it("keeps a control sequence out of every line", () => {
    expect(progressLines([{ type: "text", node: null, text: "ok \u001b[?25l here" }])).toEqual(["  ok  here"]);
  });
});
