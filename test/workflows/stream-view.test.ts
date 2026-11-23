/**
 * stream-view.test.ts — What a frame does to one connection's display state (`apply`, `snapshot`)
 * and the lines that state becomes (`progressLines`), which is what a tool call shows. Which channel
 * of a node's text is shown, and what a replayed journal sets, is pinned through the client.
 */
import { describe, expect, it } from "vite-plus/test";
import { progressLines, StreamView } from "../../src/workflows/stream-view.js";
import type { WorkflowDisplayItem } from "../../src/workflows/stream-view.js";
import type { SseFrame } from "../../src/workflows/sse.js";

/** A frame as the parser hands it over: its SSE event name and its joined payload. */
function frame(event: string | null, data: string): SseFrame {
  return { event, data };
}

/**
 * A named frame as the producer sends it: `node_id` names the node it belongs to, next to whatever
 * else that event's payload carries.
 */
function named(event: string, node: string, payload?: Record<string, unknown>): SseFrame {
  return frame(event, JSON.stringify({ node_id: node, ...payload }));
}

/** An unnamed chunk: the text channel the producer sends without a name or an id. */
function chunk(text: string): SseFrame {
  return frame(null, text);
}

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

// A lookup on a plain object also matches what Object.prototype carries, so the first four names are
// frames a newer producer can send that a `LIFECYCLE[name]`-style lookup cannot tell from a known one.
// The last is an ordinary name from a producer this view has not been taught.
const UNKNOWN_NAMES = ["constructor", "toString", "__proto__", "hasOwnProperty", "node_interrupted"];

describe("a frame whose name this view does not know", () => {
  it.for(UNKNOWN_NAMES)("reports %s as no lifecycle, no read and no change", (name) => {
    const view = new StreamView();

    expect(view.apply(named(name, "analysis"))).toEqual({ lifecycle: false, reconcile: false, changed: false });
  });

  it.for(UNKNOWN_NAMES)("shows nothing for the frame named %s", (name) => {
    const view = new StreamView();
    view.apply(named("node_dispatched", "analysis"));

    view.apply(named(name, "analysis", { reason: "paused" }));

    expect(progressLines(view.snapshot())).toEqual(["\u25b6 analysis dispatched"]);
  });

  it("leaves a later unnamed chunk on the node the last known frame named", () => {
    const view = new StreamView();
    view.apply(named("node_dispatched", "analysis"));
    view.apply(chunk("Inspecting the "));

    view.apply(named("node_interrupted", "foreign-node"));
    view.apply(chunk("diff."));

    expect(view.snapshot()).toEqual([
      { type: "node-status", node: "analysis", status: "dispatched" },
      { type: "text", node: "analysis", text: "Inspecting the diff." },
    ]);
  });

  it("shows the lines of a known-frame stream when unknown frames arrive among them", () => {
    const known = [
      named("node_dispatched", "analysis"),
      chunk("Inspecting the "),
      named("node_progress", "analysis", { step: "tool_call", detail: { tool: "read_file" } }),
      named("node_progress", "analysis", { step: "llm_response", detail: { text: "Inspecting the diff." } }),
      named("node_complete", "analysis"),
      named("workflow_engine_finished", "analysis"),
    ];
    // A name before the first lifecycle frame, between known frames, and after the terminal frame.
    const mixed = [
      named("node_interrupted", "watcher"),
      known[0]!,
      named("toString", "watcher"),
      known[1]!,
      named("__proto__", "watcher"),
      known[2]!,
      named("hasOwnProperty", "watcher"),
      known[3]!,
      known[4]!,
      known[5]!,
      named("constructor", "watcher"),
    ];
    const shown = (frames: SseFrame[]): string[] => {
      const view = new StreamView();
      for (const each of frames) view.apply(each);
      return progressLines(view.snapshot());
    };

    expect(shown(known)).toEqual(["\u2713 analysis completed", "  analysis tool read_file", "  Inspecting the diff."]);
    expect(shown(mixed)).toEqual(["\u2713 analysis completed", "  analysis tool read_file", "  Inspecting the diff."]);
  });
});

describe("a frame whose name this view knows", () => {
  it("still reports the effect every known frame carries", () => {
    const view = new StreamView();
    const frames = [
      named("node_dispatched", "analysis"),
      named("node_progress", "analysis", { step: "tool_call", detail: { tool: "read_file" } }),
      chunk("Inspecting the repository"),
      named("node_complete", "analysis"),
      named("workflow_engine_finished", "analysis"),
      named("reconnect", "analysis", { reason: "max_duration" }),
    ];

    const effects = frames.map((each) => view.apply(each));

    expect(effects).toEqual([
      { lifecycle: true, reconcile: false, changed: true },
      { lifecycle: false, reconcile: false, changed: true },
      { lifecycle: false, reconcile: false, changed: true },
      { lifecycle: true, reconcile: false, changed: true },
      { lifecycle: false, reconcile: true, changed: false },
      { lifecycle: false, reconcile: true, changed: false },
    ]);
  });
});

// A frame that only means "this connection is over, read GET" carries the run's terminal payload, and
// a node named inside that payload is no reason to move the channel unnamed text belongs to.
describe("a frame that only asks for the authoritative read", () => {
  it.for(["workflow_engine_finished", "workflow_failed", "reconnect"] as const)(
    "names no node and changes no display state for %s",
    (event) => {
      const view = new StreamView();
      view.apply(named("node_dispatched", "analysis"));
      view.apply(chunk("Inspecting the "));

      const effect = view.apply(named(event, "foreign-node", { result: "The declared output" }));
      view.apply(chunk("diff."));

      expect(effect).toEqual({ lifecycle: false, reconcile: true, changed: false });
      expect(progressLines(view.snapshot())).toEqual(["\u25b6 analysis dispatched", "  Inspecting the diff."]);
    },
  );
});
