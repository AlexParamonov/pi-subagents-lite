/**
 * record-details.ts — The one "open this record's details" entry point every surface calls.
 *
 * Both surfaces reach the same viewer, shown the same way: a wide overlay over whatever opened it. A
 * session's own transcript, or a Workflow run's display snapshot as rows. A run is read-only — nothing
 * here steers it or aborts it — and it never gets a session, so no session-keyed capability switches on
 * for it.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getManager, getStore } from "../shell.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import { detailRows, type WorkflowNodeStatus } from "../workflows/stream-view.ts";
import {
  ConversationViewer,
  type ConversationViewerOptions,
  type TranscriptEntry,
  type TranscriptNodeState,
  type TranscriptSource,
} from "./conversation-viewer.ts";
import { viewerExpandFlag, viewerPresentation, viewerToolDisplay } from "./tool-display.ts";
import { DETAILS_OVERLAY_COLUMNS } from "./overlay.ts";
import type { Theme } from "./types.ts";

/** Show this record's details over the surface that opened them, and answer when the reader closes them. */
export async function openRecordDetails(ui: ExtensionUIContext, record: AgentRecord): Promise<void> {
  const session = record.execution.session;
  if (record.workflow || (!session && !!record.error)) {
    // A run has no session; neither does a record that failed before one was created. Both are shown
    // from the record's own rows, and only a run is folded by the reader's tool-output flag.
    const wiring: ConversationViewerOptions = record.workflow ? { toolDisplay: viewerExpandFlag({ ui }) } : {};
    return showTranscript(ui, record, (theme) => recordTranscript(record, theme), wiring);
  }
  if (!session) {
    throw new Error(`agent ${record.id.slice(0, SHORT_ID_LENGTH)} has nothing to show`);
  }
  return showTranscript(ui, record, () => session, sessionWiring(ui, record));
}

/** Hand the viewer this record's transcript source, with the presentation both surfaces share. */
function showTranscript(
  ui: ExtensionUIContext,
  record: AgentRecord,
  makeSource: (theme: Theme) => TranscriptSource,
  wiring: ConversationViewerOptions,
): Promise<void> {
  const store = getStore();
  return ui.custom(
    (tui, theme, keybindings, done) => {
      const viewer = new ConversationViewer(tui, makeSource(theme), record, theme, done, {
        keybindings,
        ...viewerPresentation(store),
        ...wiring,
      });
      viewer.setModelDisplayStyle(store.agent.modelDisplayStyle);
      return viewer;
    },
    { overlay: true, overlayOptions: { width: DETAILS_OVERLAY_COLUMNS } },
  );
}

/** The record's own agent is this session's to steer and to stop; a remote run is nobody's here. */
function sessionWiring(ui: ExtensionUIContext, record: AgentRecord): ConversationViewerOptions {
  const manager = getManager();
  return {
    onStop: () => manager?.abort(record.id, "user"),
    onSteer: (message: string) => manager?.steer(record.id, message),
    toolDisplay: viewerToolDisplay({ ui }, manager, record.id),
  };
}

/**
 * The record's own rows as a transcript: one row per node, its entries folded under it, and its
 * failure reason last. A new snapshot replaces the rows whole, so a reconnect replaces what is shown
 * rather than appending to it; the run's publish path is what says a snapshot arrived, and what the
 * record holds now is what is rebuilt then.
 */
function recordTranscript(record: AgentRecord, theme: Theme): TranscriptSource {
  let rows = rowsOf(record, theme);
  return {
    get messages() {
      return rows;
    },
    // A record left by a session that ended has no run left to watch it.
    subscribe: (listener) =>
      record.execution.watchSnapshot?.(() => {
        rows = rowsOf(record, theme);
        listener();
      }) ?? (() => {}),
  };
}

/** How a node's own row is coloured: the state it reports, in the three the viewer paints. */
const NODE_STATE: Record<WorkflowNodeStatus, TranscriptNodeState> = {
  dispatched: "running",
  retry: "running",
  completed: "done",
  failed: "failed",
};

/** What the record has to show: one row per node, one for every entry nothing groups, and its reason. */
function rowsOf(record: AgentRecord, theme: Theme): TranscriptEntry[] {
  const rows: TranscriptEntry[] = detailRows(record.workflow?.items ?? []).map((row): TranscriptEntry =>
    row.kind === "entry"
      ? { role: "row", text: theme.fg("toolOutput", row.line) }
      : { role: "node", title: row.title, state: NODE_STATE[row.state], body: row.body },
  );
  // A node table stops at the last dispatch, so the reason a run settled badly has no other row here.
  if (record.error) {
    for (const line of record.error.split("\n").filter((one) => one !== "")) {
      rows.push({ role: "row", text: theme.fg("error", line) });
    }
  }
  if (rows.length > 0 || isActive(record)) return rows;
  // A settled run is waiting for nothing, so its empty view says so in the record's own words.
  return [{ role: "row", text: theme.fg("dim", "(this run delivered no entries)") }];
}

/** Running or queued - the only non-terminal statuses (ADR-0006: active work is never cleared). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}
