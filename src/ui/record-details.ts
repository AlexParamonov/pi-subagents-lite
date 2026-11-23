/**
 * record-details.ts — The one "open this record's details" entry point every surface calls.
 *
 * Both surfaces reach the same viewer: a session's own transcript, or a Workflow run's display
 * snapshot as rows. A run is read-only — nothing here steers it or aborts it — and it never gets a
 * session, so no session-keyed capability switches on for it.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getManager, getStore } from "../shell.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import { displayRows } from "../workflows/stream-view.ts";
import {
  ConversationViewer,
  type ConversationViewerOptions,
  type TranscriptEntry,
  type TranscriptSource,
} from "./conversation-viewer.ts";
import { viewerPresentation, viewerToolDisplay } from "./tool-display.ts";
import type { Theme } from "./types.ts";

export interface RecordDetailsOptions {
  /** Show the details over the surface that opened them, as `/agents` does, instead of in its place. */
  overlay?: boolean;
}

/** Show this record's details, and answer when the reader closes them. */
export async function openRecordDetails(
  ui: ExtensionUIContext,
  record: AgentRecord,
  { overlay = false }: RecordDetailsOptions = {},
): Promise<void> {
  const run = record.workflow;
  if (run) {
    return showTranscript(ui, record, (theme) => runTranscript(record, theme), {}, overlay);
  }
  const session = record.execution.session;
  if (!session) {
    throw new Error(`agent ${record.id.slice(0, SHORT_ID_LENGTH)} has nothing to show`);
  }
  return showTranscript(ui, record, () => session, sessionWiring(ui, record), overlay);
}

/** Hand the viewer this record's transcript source, with the presentation both surfaces share. */
function showTranscript(
  ui: ExtensionUIContext,
  record: AgentRecord,
  makeSource: (theme: Theme) => TranscriptSource,
  wiring: ConversationViewerOptions,
  overlay: boolean,
): Promise<void> {
  const store = getStore();
  return ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const viewer = new ConversationViewer(tui, makeSource(theme), record, theme, done, {
        keybindings,
        ...viewerPresentation(store),
        ...wiring,
      });
      viewer.setModelDisplayStyle(store.agent.modelDisplayStyle);
      return viewer;
    },
    overlay ? { overlay: true } : undefined,
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
 * A run's display snapshot as a transcript: one row per entry, each naming its node and coloured by
 * that node's state. A new snapshot replaces the rows whole, so a reconnect replaces what is shown
 * rather than appending to it; the run's publish path is what says a snapshot arrived, and what the
 * record holds now is what is rebuilt then.
 */
function runTranscript(record: AgentRecord, theme: Theme): TranscriptSource {
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

/** What the record has to show: one row per entry. */
function rowsOf(record: AgentRecord, theme: Theme): TranscriptEntry[] {
  const rows: TranscriptEntry[] = displayRows(record.workflow?.items ?? [], theme).map((text) => ({
    role: "row",
    text,
  }));
  if (rows.length > 0 || isActive(record)) return rows;
  // A settled run is waiting for nothing, so its empty view says so in the record's own words.
  return [{ role: "row", text: theme.fg("dim", "(this run delivered no entries)") }];
}

/** Running or queued - the only non-terminal statuses (ADR-0006: active work is never cleared). */
function isActive(record: AgentRecord): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}
