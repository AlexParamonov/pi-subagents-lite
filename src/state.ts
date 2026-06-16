/**
 * state.ts — Shared module state. Extracted from index.ts to break circular deps.
 *
 * manager and widget use holders because they're reassigned after import and the
 * PI runtime doesn't propagate ESM live binding reassignments.
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.js";
import { AgentWidget, type AgentActivity } from "./ui/agent-widget.js";
import { ConfigStore } from "./config-store.js";

/** The single ConfigStore instance, constructed at module load time. */
export const store = new ConfigStore();

export const agentActivity = new Map<string, AgentActivity>();
export let piInstance: ExtensionAPI;
/** Stored ExtensionContext from session_start — used by menu spawn flow. */
export let sessionCtx: ExtensionContext;

// Holder objects — PI runtime doesn't propagate ESM live binding reassignments
const managerHolder: { current?: AgentManager } = {};
const widgetHolder: { current?: AgentWidget } = {};

export function setManager(m: AgentManager): void { managerHolder.current = m; }
export function clearManager(): void { managerHolder.current = undefined; }
export function setWidget(w: AgentWidget | undefined): void { widgetHolder.current = w; }
export function setPiInstance(pi: ExtensionAPI): void { piInstance = pi; }
export function setSessionCtx(ctx: ExtensionContext): void { sessionCtx = ctx; }
export function getManager(): AgentManager { return managerHolder.current!; }
export function getWidget(): AgentWidget | undefined { return widgetHolder.current; }
