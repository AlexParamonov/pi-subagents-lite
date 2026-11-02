/**
 * index.ts — Local subagents extension entry point.
 *
 * Tool schemas stay concise; the child-only MessageAgent description carries
 * routing guidance only when that tool is available. The model param is injected
 * via the tool_call listener. Config lives in ConfigStore (loaded from
 * ~/.pi/agent/subagents-lite.json at session_start); tool execution and
 * menus read/write through it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPiInstance } from "./shell.ts";
import { getSubagentParent } from "./agents/subagent-context.ts";
import { registerTools, registerCommunicationTools } from "./registration.ts";
import { setupEventListeners } from "./events.ts";

export default function (pi: ExtensionAPI) {
  // The child-session setup passes this capability across Pi's fresh module load.
  const parent = getSubagentParent();
  if (parent) {
    registerCommunicationTools(pi, parent);
    return;
  }
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
