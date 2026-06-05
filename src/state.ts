/**
 * state.ts — Shared module state. Extracted from index.ts to break circular deps.
 *
 * manager and widget use holders because they're reassigned after import and the
 * PI runtime doesn't propagate ESM live binding reassignments.
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionModelOverrides, SubagentsConfig } from "./model-precedence.js";
import { DEFAULT_CONFIG } from "./config-io.js";
import { AgentManager } from "./agent-manager.js";
import { AgentWidget, type AgentActivity } from "./ui/agent-widget.js";

export let sessionOverrides: SessionModelOverrides = { default: null };
export let __config: SubagentsConfig = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent }, concurrency: { ...DEFAULT_CONFIG.concurrency } };
export const agentActivity = new Map<string, AgentActivity>();
export let piInstance: ExtensionAPI;
/** Stored ExtensionContext from session_start — used by menu spawn flow. */
export let sessionCtx: ExtensionContext;

// Holder objects — PI runtime doesn't propagate ESM live binding reassignments
const managerHolder: { current?: AgentManager } = {};
const widgetHolder: { current?: AgentWidget } = {};

export function setConfig(config: SubagentsConfig): void { __config = config; }
export function resetSessionOverrides(): void { sessionOverrides = { default: null }; }
export function setManager(m: AgentManager): void { managerHolder.current = m; }
export function clearManager(): void { managerHolder.current = undefined; }
export function setWidget(w: AgentWidget | undefined): void { widgetHolder.current = w; }
export function setPiInstance(pi: ExtensionAPI): void { piInstance = pi; }
export function setSessionCtx(ctx: ExtensionContext): void { sessionCtx = ctx; }
export function getManager(): AgentManager { return managerHolder.current!; }
export function getWidget(): AgentWidget | undefined { return widgetHolder.current; }

// State mutation helpers

/** Update the cost display toggle in config and sync to widget. */
export function setShowCostEnabled(enabled: boolean): void {
  __config.agent.showCost = enabled;
  getWidget()?.setShowCost(enabled);
}

/** Sync widget display settings from config to the widget instance. */
export function syncWidgetSettings(): void {
  const w = getWidget();
  if (!w) return;
  w.setForceCompact(__config.agent.widgetCompact === true);
  w.setWidgetShortcut(__config.agent.widgetShortcut === true);
  w.setMaxLines(__config.agent.widgetMaxLines ?? 12);
  w.setMaxLinesCompact(
    __config.agent.widgetMaxLinesCompact ?? Math.floor((__config.agent.widgetMaxLines ?? 12) / 2),
  );
}

/** Track previous tool expansion state to detect ctrl+o toggle. */
let lastToolsExpanded: boolean | undefined;

/** Reset lastToolsExpanded (called at session_start). */
export function resetLastToolsExpanded(): void {
  lastToolsExpanded = undefined;
}

/** Sync compact mode with the tool expansion state (ctrl+o toggle).
 *  Only syncs when widgetShortcut is enabled in config (opt-in behavior).
 *  Only triggers on state change (not every tool_execution_start).
 *  When forceCompact (widgetCompact) is ON, ignores ctrl+o state changes.
 */
export function syncCompactFromToolsExpanded(expanded: boolean): void {
  if (__config.agent.widgetShortcut !== true) {
    lastToolsExpanded = expanded;
    return;
  }
  // When forceCompact is ON, ignore ctrl+o state changes
  if (__config.agent.widgetCompact === true) {
    lastToolsExpanded = expanded;
    return;
  }
  // Tools expanded → widget full, tools collapsed → widget compact
  if (lastToolsExpanded !== undefined && lastToolsExpanded !== expanded) {
    getWidget()?.setCompactMode(!expanded);
  }
  lastToolsExpanded = expanded;
}
