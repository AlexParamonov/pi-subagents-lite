/**
 * tool-display.ts — Wires the conversation viewer to pi's global tool-output flag.
 *
 * The viewer holds keyboard focus, so pi's own `app.tools.expand` handler never
 * sees the key. Toggling through `ctx.ui.setToolsExpanded` makes pi refresh its
 * own rows; the extension's widget compact mode follows via the config store.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStore } from "../shell.ts";
import type { ToolDisplayOptions } from "./conversation-viewer.ts";

export function toolExpansionControls(
  ctx: Pick<ExtensionContext, "ui">,
): Pick<ToolDisplayOptions, "isExpanded" | "toggleExpanded"> {
  return {
    isExpanded: () => ctx.ui.getToolsExpanded(),
    toggleExpanded: () => {
      const expanded = !ctx.ui.getToolsExpanded();
      ctx.ui.setToolsExpanded(expanded);
      getStore().notifyToolsExpanded(expanded);
    },
  };
}
