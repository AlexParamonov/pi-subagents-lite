/**
 * state.ts — Shared module state for the subagents extension.
 *
 * Extracted from index.ts to break circular dependencies between
 * index.ts ↔ menus.ts, tool-execution.ts, renderer.ts, and stop-agent-tool.ts.
 *
 * This module owns the mutable singleton state that multiple modules need.
 * Consuming modules import from state.ts instead of index.ts.
 *
 * index.ts uses setter functions for reassignment (ESM live bindings are
 * read-only from the importer's perspective).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionModelOverrides, SubagentsConfig } from "./model-precedence.js";
import { DEFAULT_CONFIG } from "./config-io.js";
import { AgentManager } from "./agent-manager.js";
import { AgentWidget, type AgentActivity } from "./ui/agent-widget.js";

// ============================================================================
// Module-level state
// ============================================================================

/** Session-only model overrides — not persisted, cleared on session_start. */
export let sessionOverrides: SessionModelOverrides = { default: null };

/** Config cache — loaded at session_start, updated by /agents menu mutations. */
export let __config: SubagentsConfig = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent }, concurrency: { ...DEFAULT_CONFIG.concurrency } };

/** Agent manager singleton — module-level, no globalThis access. */
export let manager: AgentManager;

/** Live activity state per agent, keyed by agent ID. Read by AgentWidget and tool-execution. */
export const agentActivity = new Map<string, AgentActivity>();

/** Live TUI widget showing running/completed agents above the editor. Used by tool-execution. */
export let widget: AgentWidget | undefined;

/** ExtensionAPI reference — stored at init for execute callbacks. */
export let piInstance: ExtensionAPI;

// ============================================================================
// Setters — used by index.ts to reassign state (ESM live bindings are read-only)
// ============================================================================

export function setConfig(config: SubagentsConfig): void {
  __config = config;
}

export function resetSessionOverrides(): void {
  sessionOverrides = { default: null };
}

export function setManager(m: AgentManager): void {
  manager = m;
  // Use globalThis as fallback since ESM live bindings don't propagate reassignments in PI runtime
  (globalThis as any).__subagentsManager = m;
}

export function clearManager(): void {
  manager = undefined as unknown as AgentManager;
  (globalThis as any).__subagentsManager = undefined;
}

export function setWidget(w: AgentWidget | undefined): void {
  widget = w;
  (globalThis as any).__subagentsWidget = w;
}

export function setPiInstance(pi: ExtensionAPI): void {
  piInstance = pi;
}

// Getters that read from globalThis (bypasses ESM live binding issues)
export function getManager(): AgentManager {
  return (globalThis as any).__subagentsManager ?? manager;
}

export function getWidget(): AgentWidget | undefined {
  return (globalThis as any).__subagentsWidget ?? widget;
}

// ============================================================================
// State mutation helpers
// ============================================================================

/** Update the cost display toggle in config and sync to widget. */
export function setShowCostEnabled(enabled: boolean): void {
  __config.agent.showCost = enabled;
  widget?.setShowCost(enabled);
}

/** Sync widget display settings from config to the widget instance. */
export function syncWidgetSettings(): void {
  if (!widget) return;
  widget.setForceCompact(__config.agent.widgetCompact === true);
  widget.setWidgetShortcut(__config.agent.widgetShortcut === true);
  widget.setMaxLines(__config.agent.widgetMaxLines ?? 12);
  widget.setMaxLinesCompact(
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
    widget?.setCompactMode(!expanded);
  }
  lastToolsExpanded = expanded;
}
