/**
 * index.ts — Local subagents extension entry point.
 *
 * Stealth tool registration: all tools register at init with no description,
 * promptSnippet, or promptGuidelines; the model param is injected via the
 * tool_call listener. Config lives in ConfigStore (loaded from
 * ~/.pi/agent/subagents-lite.json at session_start); tool execution and
 * menus read/write through it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPiInstance, isInsideSubagentSpawn } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI) {
  // Subagents re-load this extension under their own pi/runtime. Stay inert
  // so we never clobber the parent-owned shell (the completion nudge relies on it).
  if (isInsideSubagentSpawn()) return;
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
