/**
 * workflow-notices.ts — Where Workflow discovery warnings are shown.
 *
 * Same policy as the spawn-target warnings: a session notice when there is a UI, the log when not.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowWarning } from "./workflow-discovery.ts";

export function workflowWarningSink(ctx: ExtensionContext): WorkflowWarning {
  return (message) => {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${message}`, "warning");
    else console.warn(`[pi-subagents-lite] ${message}`);
  };
}
