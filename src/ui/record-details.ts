/**
 * record-details.ts — The one "open this record's details" entry point every surface calls.
 *
 * A Workflow run has no session, so its details are the display snapshot the monitor last published:
 * one entry per node status, activity line and text chunk, followed while the run is live. A run's
 * pane is read-only: it offers no steering and no stop, because a remote run is neither steered nor
 * aborted here. Every other record has a session, and its conversation is the viewer's.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getManager, getStore } from "../shell.ts";
import { SHORT_ID_LENGTH, type AgentRecord } from "../types.ts";
import { displayRows } from "../workflows/stream-view.ts";
import { ConversationViewer } from "./conversation-viewer.ts";
import { getDisplayName, recordDisplayName } from "./format.ts";
import { viewerPresentation, viewerToolDisplay } from "./tool-display.ts";
import { showTextPane } from "./text-pane.ts";

/** How often a run's pane re-reads the record. The run writes its snapshot whenever its stream says
 * anything, and a node takes seconds to change, so this is a repaint cadence, not a data source. */
const RUN_REFRESH_MS = 250;

/** Show this record's details over the conversation, and answer when the reader closes them. */
export async function openRecordDetails(ui: ExtensionUIContext, record: AgentRecord): Promise<void> {
  const run = record.workflow;
  if (run) {
    return showRunDetails(ui, record, run);
  }
  const session = record.execution.session;
  if (!session) {
    throw new Error(`agent ${record.id.slice(0, SHORT_ID_LENGTH)} has no session to show`);
  }
  return showConversation(ui, record, session);
}

/** The run's own entries, read from the record on every frame: what this client saw, and no more. */
function showRunDetails(
  ui: ExtensionUIContext,
  record: AgentRecord,
  run: NonNullable<AgentRecord["workflow"]>,
): Promise<void> {
  const name = recordDisplayName(record, getDisplayName(record.display.type));
  return showTextPane(ui, {
    title: `${name} \u00b7 ${record.id.slice(0, SHORT_ID_LENGTH)}`,
    rows: (theme) => displayRows(run.items ?? [], theme),
    refreshMs: RUN_REFRESH_MS,
  });
}

function showConversation(
  ui: ExtensionUIContext,
  record: AgentRecord,
  session: NonNullable<AgentRecord["execution"]["session"]>,
): Promise<void> {
  const manager = getManager();
  return ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const viewer = new ConversationViewer(tui, session, record, theme, done, {
        onStop: () => manager?.abort(record.id, "user"),
        keybindings,
        onSteer: (message: string) => manager?.steer(record.id, message),
        toolDisplay: viewerToolDisplay({ ui }, manager, record.id),
        ...viewerPresentation(getStore()),
      });
      viewer.setModelDisplayStyle(getStore().agent.modelDisplayStyle);
      return viewer;
    },
    { overlay: true },
  );
}
