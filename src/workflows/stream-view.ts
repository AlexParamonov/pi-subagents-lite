/**
 * stream-view.ts — One SSE connection's display state, and the lines it shows.
 *
 * Each connection rebuilds this from the frames that connection delivers (ADR-0013: the server
 * replays its whole log per connection and this client never resumes by id), so nothing carries
 * over. Text is tracked per node, attempt and turn: one channel of a turn is shown, never
 * concatenated, and a full-turn frame closes the turn it arrives on. `progressLines` spells the
 * state for the tool call.
 */

import { plainText } from "../ui/sanitize.ts";
import { field, parseRecord, record } from "./payload.ts";
import type { SseFrame } from "./sse.ts";

/** Status a node lifecycle frame reports. */
export type WorkflowNodeStatus = "dispatched" | "retry" | "completed" | "failed";

/** What one connection has to show, in the order the caller should render it. */
export type WorkflowDisplayItem =
  | { type: "node-status"; node: string | null; status: WorkflowNodeStatus }
  | { type: "activity"; node: string | null; activity: string }
  | { type: "text"; node: string | null; text: string };

/** What a frame means to the loop: reset the lifecycle silence clock, go read GET, or both. */
export interface FrameEffect {
  lifecycle: boolean;
  reconcile: boolean;
  changed: boolean;
}

const LIFECYCLE: Record<string, WorkflowNodeStatus> = {
  node_dispatched: "dispatched",
  node_retry: "retry",
  node_complete: "completed",
  node_failed: "failed",
};

/** Frames that mean "this connection has nothing more to say; read GET". */
const RECONCILE = new Set(["workflow_engine_finished", "workflow_failed", "reconnect"]);

type Channel = "raw" | "relay" | "delta";

/**
 * The text one turn of one node attempt delivered. The unnamed chunk, the marked relay chunk and
 * the coalesced delta batch carry the same text at different granularity, so exactly one channel is
 * shown and none of them is ever joined with another.
 */
class TurnText {
  /** The turn's full text, set by the frame that closes the turn; null while it is still arriving. */
  full: string | null = null;
  private readonly channels: Record<Channel, string> = { raw: "", relay: "", delta: "" };

  append(channel: Channel, text: string): void {
    this.channels[channel] += text;
  }

  get text(): string {
    if (this.full !== null) return this.full;
    return this.channels.raw || this.channels.relay || this.channels.delta;
  }
}

/** One node's lines: its status, the tools it used, and one text line per turn of this attempt. */
class NodeLines {
  status: WorkflowNodeStatus | undefined;
  readonly activity: string[] = [];
  private readonly closed: string[] = [];
  private turn = new TurnText();

  /** Every turn with text to show, oldest first: the closed ones, then the one still arriving. */
  get texts(): string[] {
    const shown = [...this.closed];
    if (this.turn.text !== "") shown.push(this.turn.text);
    return shown;
  }

  append(channel: Channel, text: string): boolean {
    if (text === "") return false;
    return this.apply(() => {
      if (this.turn.full !== null) this.closeTurn();
      this.turn.append(channel, text);
    });
  }

  /**
   * A full-turn frame is its own turn's boundary: its text replaces whatever the chunks of that turn
   * contributed, and whatever arrives next belongs to the following turn.
   */
  fullTurn(text: string): boolean {
    if (this.turn.full === text) return false;
    return this.apply(() => {
      // A second full-turn frame with other text is the next turn's: a run that streams no chunks
      // emits one per turn with nothing between them.
      if (this.turn.full !== null) this.closeTurn();
      this.turn.full = text;
    });
  }

  /** A node dispatched again is a new attempt: what the last one streamed is not this one's prefix. */
  beginAttempt(): void {
    this.closed.length = 0;
    this.turn = new TurnText();
  }

  showActivity(activity: string): boolean {
    if (this.activity.includes(activity)) return false;
    this.activity.push(activity);
    return true;
  }

  private closeTurn(): void {
    if (this.turn.text !== "") this.closed.push(this.turn.text);
    this.turn = new TurnText();
  }

  private apply(update: () => void): boolean {
    const before = this.texts;
    update();
    return !sameLines(before, this.texts);
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export class StreamView {
  private readonly order: (string | null)[] = [];
  private readonly lines = new Map<string | null, NodeLines>();
  /** The unnamed text channel names no node: it belongs to the node this connection last saw. */
  private source: string | null = null;

  apply(frame: SseFrame): FrameEffect {
    const { event, data } = frame;
    // Only a named frame carries a payload to read fields from: a raw frame's `data:` is text to
    // show, and a chunk that happens to look like JSON must not name a node.
    const payload = event === null ? null : parseRecord(data);
    const named = field(payload, "node_id");
    if (named !== undefined) this.source = named;
    const node = named ?? this.source;
    const lines = this.linesFor(node);
    const lifecycle = event === null ? undefined : LIFECYCLE[event];
    const effect: FrameEffect = {
      lifecycle: lifecycle !== undefined,
      reconcile: event !== null && RECONCILE.has(event),
      changed: false,
    };

    if (lifecycle !== undefined) {
      if (lifecycle === "dispatched" || lifecycle === "retry") lines.beginAttempt();
      lines.status = lifecycle;
      effect.changed = true;
    } else if (event === null) {
      effect.changed = lines.append("raw", data);
    } else if (event === "node_progress") {
      effect.changed = applyProgress(lines, payload);
    }
    return effect;
  }

  snapshot(): WorkflowDisplayItem[] {
    const items: WorkflowDisplayItem[] = [];
    for (const node of this.order) {
      const lines = this.lines.get(node)!;
      if (lines.status) items.push({ type: "node-status", node, status: lines.status });
      for (const activity of lines.activity) items.push({ type: "activity", node, activity });
      for (const text of lines.texts) items.push({ type: "text", node, text });
    }
    return items;
  }

  private linesFor(node: string | null): NodeLines {
    const known = this.lines.get(node);
    if (known) return known;
    const lines = new NodeLines();
    this.lines.set(node, lines);
    this.order.push(node);
    return lines;
  }
}

/**
 * The producer's steps that carry a whole turn's text: `assistant_turn` for a turn that went on to
 * call a tool, `llm_response` for one that did not. A `llm_response` marked `chunk: true` is one
 * chunk of the turn still arriving, not a boundary.
 */
const FULL_TURN_STEPS = new Set(["assistant_turn", "llm_response"]);

function applyProgress(lines: NodeLines, payload: Record<string, unknown> | null): boolean {
  const step = field(payload, "step");
  const detail = record(payload?.detail);
  const tool = field(detail, "tool");
  if (tool !== undefined) return lines.showActivity(tool);
  const text = field(detail, "text");
  if (step === "llm_delta") {
    const fragment = field(detail, "fragment");
    return field(detail, "kind") === "text" && fragment !== undefined ? lines.append("delta", fragment) : false;
  }
  if (step === "llm_response" && detail?.chunk === true) {
    return text === undefined ? false : lines.append("relay", text);
  }
  return text !== undefined && step !== undefined && FULL_TURN_STEPS.has(step) ? lines.fullTurn(text) : false;
}

/** The mark and word each node lifecycle state is shown with. */
const NODE_STATUS: Record<WorkflowNodeStatus, { mark: string; word: string }> = {
  dispatched: { mark: "\u25b6", word: "dispatched" },
  retry: { mark: "\u25b6", word: "retrying" },
  completed: { mark: "\u2713", word: "completed" },
  failed: { mark: "\u2717", word: "failed" },
};

function lineFor(item: WorkflowDisplayItem): string {
  const node = item.node === null ? "" : `${item.node} `;
  if (item.type === "node-status") {
    const status = NODE_STATUS[item.status];
    return `${status.mark} ${node}${status.word}`;
  }
  return item.type === "activity" ? `  ${node}tool ${item.activity}` : `  ${item.text}`;
}

/** The lines a tool call shows for one connection's display state, control sequences removed. */
export function progressLines(items: readonly WorkflowDisplayItem[]): string[] {
  return items.map((item) => plainText(lineFor(item))).filter((line) => line !== "");
}
