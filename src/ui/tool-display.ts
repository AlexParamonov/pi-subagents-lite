/**
 * tool-display.ts — Wires the conversation viewer to its hosts: pi's global
 * tool-output flag and the saved viewer presentation preferences.
 *
 * The viewer holds keyboard focus, so pi's own `app.tools.expand` handler never
 * sees the key. Toggling through `ctx.ui.setToolsExpanded` makes pi refresh its
 * own rows; the extension's widget compact mode follows via the config store.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "../shell.ts";
import type { ConfigStore } from "../config/config-store.ts";
import type { AgentManager } from "../agents/agent-manager.ts";
import type { ConversationViewerOptions, ToolDisplayOptions } from "./conversation-viewer.ts";

/** The viewer's presentation prefs, read once when it opens: both entry points must agree on them. */
export function viewerPresentation(
  store: ConfigStore,
): Pick<ConversationViewerOptions, "compactToolCalls" | "ungroupedTools"> {
  return { compactToolCalls: store.agent.compactToolCalls, ungroupedTools: store.agent.ungroupedTools };
}

/** The viewer's tool-display wiring: live timings for the agent's calls, plus pi's global expand flag. */
export function viewerToolDisplay(
  ctx: Pick<ExtensionContext, "ui">,
  manager: AgentManager | null | undefined,
  agentId: string,
): ToolDisplayOptions {
  return {
    // Calls already running when the viewer opened: their start was recorded by the watchdog.
    getToolStartedAt: (toolCallId: string) => manager?.getToolStartedAt(agentId, toolCallId),
    isExpanded: () => ctx.ui.getToolsExpanded(),
    toggleExpanded: () => {
      const expanded = !ctx.ui.getToolsExpanded();
      ctx.ui.setToolsExpanded(expanded);
      getStore().notifyToolsExpanded(expanded);
    },
  };
}
