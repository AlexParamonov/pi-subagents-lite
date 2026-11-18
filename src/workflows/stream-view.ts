/**
 * stream-view.ts — One SSE connection's display state.
 *
 * Each connection rebuilds this from the frames that connection delivers (ADR-0013: the server
 * replays its whole log per connection and this client never resumes by id), so nothing carries
 * over. Text is tracked per channel and one channel is shown, never concatenated across channels.
 */

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
    const payload = parseRecord(frame.data);
    const named = frame.event !== null ? field(payload, "node_id") : undefined;
    if (named !== undefined) this.source = named;
    const node = named ?? this.source;
    const lines = this.linesFor(node);
    const lifecycle = frame.event !== null ? LIFECYCLE[frame.event] : undefined;
    const effect: FrameEffect = {
      lifecycle: lifecycle !== undefined,
      reconcile: frame.event !== null && RECONCILE.has(frame.event),
      changed: false,
    };

    if (lifecycle !== undefined && frame.event !== null) {
      lines.status = lifecycle;
      effect.changed = true;
    } else if (frame.event === null) {
      effect.changed = lines.append("raw", frame.data);
    } else if (frame.event === "node_progress") {
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
