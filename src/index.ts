/**
 * index.ts — Local subagents extension entry point.
 *
 * Registers tools, commands, and event listeners at init time.
 *
 * Stealth tool registration:
 *   - All tools register at extension init (not runtime)
 *   - No description, no promptSnippet, no promptGuidelines
 *   - Parameters without .description()
 *   - Model parameter removed from schema — injected via tool_call listener
 *
 * Config:
 *   - Loaded from ~/.pi/agent/subagents-lite.json at session_start
 *   - ConfigStore owns config + session overrides + persistence + side effects
 *   - Tool execution and menus read/write through store
 *
 * Commands:
 *   - /agents: Management menu (model settings, concurrency, running agents, debug)
 *
 * Events:
 *   - tool_call: Inject model into Agent tool calls
 *   - session_start: Load config, register agents, initialise manager
 *   - session_shutdown: Abort all, dispose manager
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setPiInstance, isInsideSubagentSpawn } from "./shell.js";
import { registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";

export default function (pi: ExtensionAPI) {
  // Subagents re-load this extension under their own pi/runtime. Stay inert so
  // we never overwrite the parent-owned shell (pi, sessionCtx, manager, ...).
  // The completion nudge relies on those still pointing at the parent session.
  if (isInsideSubagentSpawn()) return;
  setPiInstance(pi);
  registerTools(pi);
  setupEventListeners(pi);
}
