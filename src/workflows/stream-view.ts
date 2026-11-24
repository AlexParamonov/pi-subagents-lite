/**
 * stream-view.ts — One SSE connection's display state, and the lines it shows.
 *
 * Each connection rebuilds this from the frames that connection delivers (ADR-0013: the server
 * replays its whole log per connection and this client never resumes by id), so nothing carries
 * over. Text is tracked per node, attempt and turn: one channel of a turn is shown, never
 * concatenated, and a full-turn frame closes the turn it arrives on. `progressLines` spells the
 * state as the run's stored and published snapshot, `displayRows` as the flat rows its tool-result
 * card paints, `detailRows` as the rows its details view paints.
 */

import { plainText } from "../ui/sanitize.ts";
import type { Theme } from "../ui/types.ts";
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

const LIFECYCLE = new Map<string, WorkflowNodeStatus>([
  ["node_dispatched", "dispatched"],
  ["node_retry", "retry"],
  ["node_complete", "completed"],
  ["node_failed", "failed"],
]);

/** Frames that mean "this connection has nothing more to say; read GET". */
const RECONCILE = new Set(["workflow_engine_finished", "workflow_failed", "reconnect"]);

/** The one named frame whose payload this view reads as text and tool activity. */
const PROGRESS = "node_progress";

/**
 * Every event name whose meaning this view knows. A Map/Set lookup matches no `Object.prototype`
 * member, so a name like `constructor` is an unknown event here and never a known one.
 */
const KNOWN_EVENTS = new Set([...LIFECYCLE.keys(), ...RECONCILE, PROGRESS]);

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
    return this.contribute((turn) => turn.append(channel, text));
  }

  /**
   * A full-turn frame is the turn it delivers: its text replaces whatever that turn's chunks
   * contributed, and the frame after it opens the next turn whatever its text says.
   */
  fullTurn(text: string): boolean {
    return this.contribute((turn) => {
      turn.full = text;
    });
  }

  /** A node dispatched again is a new attempt: what the last one streamed is not this one's prefix. */
  beginAttempt(): void {
    this.closed.length = 0;
    this.turn = new TurnText();
  }

  /**
   * The value a node's completion frame carries. A node whose own turns delivered text has delivered
   * this content once already, so the value is shown only when the node has shown none.
   */
  showResult(text: string): void {
    if (text === "" || this.closed.length > 0 || this.turn.text !== "") return;
    this.fullTurn(text);
  }

  showActivity(activity: string): boolean {
    if (this.activity.includes(activity)) return false;
    this.activity.push(activity);
    return true;
  }

  private contribute(update: (turn: TurnText) => void): boolean {
    // Moving a full turn into the closed prefix doesn't change what's shown; only the open turn can change it.
    if (this.turn.full !== null) {
      if (this.turn.full !== "") this.closed.push(this.turn.full);
      this.turn = new TurnText();
    }
    const before = this.turn.text;
    update(this.turn);
    return before !== this.turn.text;
  }
}

export class StreamView {
  private readonly order: (string | null)[] = [];
  private readonly lines = new Map<string | null, NodeLines>();
  /** The unnamed text channel names no node: it belongs to the node this connection last saw. */
  private source: string | null = null;

  apply(frame: SseFrame): FrameEffect {
    const { event, data } = frame;
    const effect: FrameEffect = { lifecycle: false, reconcile: false, changed: false };
    // A name this view does not know means something a newer producer decided, and this view cannot
    // guess what: it resets no silence window, asks for no read, and its payload names no node.
    if (event !== null && !KNOWN_EVENTS.has(event)) return effect;
    // A frame that only ends the connection carries the run's terminal payload. None of it is display
    // state, and the node it names is not the node this connection's unnamed text belongs to.
    if (event !== null && RECONCILE.has(event)) return { ...effect, reconcile: true };
    // Only a named frame carries a payload to read fields from: a raw frame's `data:` is text to
    // show, and a chunk that happens to look like JSON must not name a node.
    const payload = event === null ? null : parseRecord(data);
    const named = field(payload, "node_id");
    if (named !== undefined) this.source = named;
    const node = named ?? this.source;
    const lines = this.linesFor(node);
    const lifecycle = event === null ? undefined : LIFECYCLE.get(event);
    effect.lifecycle = lifecycle !== undefined;

    if (lifecycle !== undefined) {
      if (lifecycle === "dispatched" || lifecycle === "retry") lines.beginAttempt();
      lines.status = lifecycle;
      // The status change is the change; the completion value is taken for the entry it adds, if any.
      if (lifecycle === "completed") lines.showResult(completedText(payload));
      effect.changed = true;
    } else if (event === null) {
      effect.changed = lines.append("raw", data);
    } else if (event === PROGRESS) {
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

/**
 * The text a `node_complete` frame carries: `result.value.text`, the key path the captured journal and
 * live frames both write (`recorded/replay-completed.sse`, `recorded/live-stream.sse`). This is the
 * node's return value, and it is the only text the endpoint sends for a node that streams no progress
 * frame. A value of any other shape declares no text.
 */
function completedText(payload: Record<string, unknown> | null): string {
  return field(record(record(payload?.result)?.value), "text") ?? "";
}

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

/** The lines of one connection's display state as the run stores and publishes them (its record's
 * `progress` and the tool payload's), control sequences removed. The display surfaces are
 * `displayRows` (the call's card) and `detailRows` (its details view); this spelling is the fixed
 * wording their text must not change. */
export function progressLines(items: readonly WorkflowDisplayItem[]): string[] {
  return items.map((item) => plainText(lineFor(item))).filter((line) => line !== "");
}

/** The theme roles a run's rows are painted with. */
type RowRole = "accent" | "warning" | "dim" | "error" | "toolOutput";

/** One colour's stretch of a painted row. */
interface RowPart {
  text: string;
  role: RowRole;
}

/** The theme role each node state is painted with, as the widget paints an agent status. */
const NODE_STATE_COLOR: Record<WorkflowNodeStatus, RowRole> = {
  dispatched: "accent",
  retry: "warning",
  completed: "dim",
  failed: "error",
};

/**
 * One entry's parts, each painted in one role: a node's status row and its label carry that node's
 * state colour, and everything the node produced is ordinary tool output.
 */
function partsFor(item: WorkflowDisplayItem, state?: WorkflowNodeStatus): RowPart[] {
  const role = state === undefined ? "toolOutput" : NODE_STATE_COLOR[state];
  if (item.type === "node-status" || item.node === null) return [{ text: lineFor(item), role }];
  const label = item.type === "text" ? `  ${item.node}  ` : `  ${item.node} `;
  return [
    { text: label, role },
    { text: producedFor(item), role: "toolOutput" },
  ];
}

/**
 * What an entry produced, on its own: no node label and no indent. A flat row adds its label, and a
 * node's own row names the node above the lines it holds and insets every one of them.
 */
function producedFor(item: Exclude<WorkflowDisplayItem, { type: "node-status" }>): string {
  return item.type === "activity" ? `tool ${item.activity}` : item.text;
}

/** The entry's row as a display surface spells it: the stored line, its text entry naming its node too. */
function displayLineFor(item: WorkflowDisplayItem): string {
  return partsFor(item)
    .map((part) => part.text)
    .join("");
}

/**
 * The rows one connection's display state is shown as, each naming its node and coloured by that
 * node's state. An entry whose node reported no state, and one naming no node at all, carry no state
 * colour. Colour is applied here, after the text was sanitised, so the stored text is unchanged.
 */
export function displayRows(items: readonly WorkflowDisplayItem[], theme: Theme): string[] {
  const states = new Map<string, WorkflowNodeStatus>();
  for (const item of items) {
    if (item.type === "node-status" && item.node !== null) states.set(item.node, item.status);
  }
  return items.map((item) =>
    partsFor(item, item.node === null ? undefined : states.get(item.node))
      .map((part) => theme.fg(part.role, plainText(part.text)))
      .join(""),
  );
}

/** A node's own row of the details view, with the lines it produced folded under it. */
interface WorkflowNodeRow {
  kind: "node";
  state: WorkflowNodeStatus;
  title: string;
  body: string[];
}

/** One row of a run's details view: a node's own row and the lines it produced, or one entry. */
export type WorkflowDetailRow = WorkflowNodeRow | { kind: "entry"; line: string };

/**
 * The rows a run's details view shows: one per node that reported a state, holding the activity and
 * text it produced as its body (the node is named once, by its own row), plus a row of its own for
 * every entry nothing groups. Text is sanitised here, so the surface painting these rows owns colour.
 */
export function detailRows(items: readonly WorkflowDisplayItem[]): WorkflowDetailRow[] {
  const rows: WorkflowDetailRow[] = [];
  const groups = new Map<string, WorkflowNodeRow>();
  for (const item of items) {
    if (item.type === "node-status") {
      const row: WorkflowNodeRow = {
        kind: "node",
        state: item.status,
        title: plainText(displayLineFor(item)),
        body: [],
      };
      if (item.node !== null) groups.set(item.node, row);
      rows.push(row);
      continue;
    }
    const group = item.node === null ? undefined : groups.get(item.node);
    if (group === undefined) rows.push({ kind: "entry", line: plainText(displayLineFor(item)) });
    else group.body.push(plainText(producedFor(item)));
  }
  return rows;
}
