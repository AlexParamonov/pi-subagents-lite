/**
 * stream-view.ts — One SSE connection's display state, and the lines it shows.
 *
 * Each connection rebuilds this from the frames that connection delivers (ADR-0013: the server
 * replays its whole log per connection and this client never resumes by id), so nothing carries
 * over. Text is tracked per channel and one channel is shown, never concatenated across channels.
 * `StreamView` tracks what a connection delivered; `progressLines` spells it for the tool call.
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

/** One node's lines. Streamed text is kept per channel; the full turn replaces all of them. */
class NodeLines {
  status: WorkflowNodeStatus | undefined;
  readonly activity: string[] = [];
  private readonly channels: Record<Channel | "fullTurn", string> = { raw: "", relay: "", delta: "", fullTurn: "" };

  append(channel: Channel, text: string): boolean {
    return this.store(channel, this.channels[channel] + text);
  }

  fullTurn(text: string): boolean {
    return this.store("fullTurn", text);
  }

  showActivity(activity: string): boolean {
    if (this.activity.includes(activity)) return false;
    this.activity.push(activity);
    return true;
  }

  get text(): string {
    return this.channels.fullTurn || this.channels.raw || this.channels.relay || this.channels.delta;
  }

  private store(channel: Channel | "fullTurn", text: string): boolean {
    if (text === this.channels[channel]) return false;
    this.channels[channel] = text;
    return true;
  }
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
      if (lines.text !== "") items.push({ type: "text", node, text: lines.text });
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

function applyProgress(lines: NodeLines, payload: Record<string, unknown> | null): boolean {
  const detail = record(payload?.detail);
  const tool = field(detail, "tool");
  if (tool !== undefined) return lines.showActivity(tool);
  const text = field(detail, "text");
  if (field(payload, "step") === "llm_response" && text !== undefined) {
    return detail?.chunk === true ? lines.append("relay", text) : lines.fullTurn(text);
  }
  if (field(payload, "step") === "llm_delta" && field(detail, "kind") === "text") {
    const fragment = field(detail, "fragment");
    return fragment === undefined ? false : lines.append("delta", fragment);
  }
  return false;
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
