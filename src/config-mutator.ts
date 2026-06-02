/**
 * config-mutator.ts — Typed setters for all __config mutations.
 *
 * Every setter saves (saveConfigAtomic) and syncs internally.
 * menus.ts calls setters instead of directly mutating __config.
 *
 * Sync responsibilities:
 *   - Widget settings (compact, maxLines, shortcut) → syncWidgetSettings
 *   - Cost display → setShowCostEnabled (syncs to widget)
 *   - Agent bulk replace → syncWidgetSettings
 *   - Concurrency → getManager().setConcurrency()
 *   - All others → saveConfigAtomic only
 */

import {
  __config,
  getManager,
  setShowCostEnabled,
  syncWidgetSettings,
} from "./state.js";
import { saveConfigAtomic, DEFAULT_CONFIG } from "./config-io.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";

// ============================================================================
// Local helpers
// ============================================================================

/**
 * Persist concurrency config to disk and apply to the running manager.
 * Defined locally so concurrency setters don't double-save.
 */
function applyConcurrencyConfig(): void {
  saveConfigAtomic(__config);
  getManager()?.setConcurrency(__config.concurrency);
}

// ============================================================================
// Model override setters
// ============================================================================

/** Set or update a model override for a type (or "default" for global). */
export function setModelOverride(type: string, value: string | null): void {
  __config.agent[type] = value;
  saveConfigAtomic(__config);
}

/** Set the global default model. */
export function setDefaultModel(value: string | null): void {
  __config.agent.default = value;
  saveConfigAtomic(__config);
}

/** Clear a single per-type model override. */
export function clearModelOverride(type: string): void {
  delete __config.agent[type];
  saveConfigAtomic(__config);
}

/** Clear all model overrides, preserving non-model settings. */
export function clearAllModelOverrides(): void {
  const preserved: Record<string, unknown> = {};
  for (const key of CONFIG_AGENT_NON_MODEL_KEYS) {
    const val = __config.agent[key];
    if (val != null || key === "default" || key === "forceBackground") {
      preserved[key] = val;
    }
  }
  __config.agent = preserved as typeof __config.agent;
  saveConfigAtomic(__config);
  syncWidgetSettings();
}

// ============================================================================
// Simple agent settings
// ============================================================================

/** Toggle force-background mode. */
export function setForceBackground(enabled: boolean): void {
  __config.agent.forceBackground = enabled;
  saveConfigAtomic(__config);
}

/** Set the cost display toggle (syncs to widget via setShowCostEnabled). */
export function setShowCost(enabled: boolean): void {
  setShowCostEnabled(enabled);
  saveConfigAtomic(__config);
}

/** Set grace turns (number of turns after timeout before hard kill). */
export function setGraceTurns(n: number): void {
  __config.agent.graceTurns = n;
  saveConfigAtomic(__config);
}

// ============================================================================
// Widget settings (sync via syncWidgetSettings)
// ============================================================================

/** Toggle force-compact widget mode. */
export function setWidgetCompact(enabled: boolean): void {
  __config.agent.widgetCompact = enabled;
  saveConfigAtomic(__config);
  syncWidgetSettings();
}

/**
 * Set max lines for full widget mode.
 * Auto-derives widgetMaxLinesCompact if not explicitly set.
 */
export function setWidgetMaxLines(lines: number): void {
  __config.agent.widgetMaxLines = lines;
  if (__config.agent.widgetMaxLinesCompact === undefined) {
    __config.agent.widgetMaxLinesCompact = Math.floor(lines / 2);
  }
  saveConfigAtomic(__config);
  syncWidgetSettings();
}

/** Set max lines for compact widget mode. */
export function setWidgetMaxLinesCompact(lines: number): void {
  __config.agent.widgetMaxLinesCompact = lines;
  saveConfigAtomic(__config);
  syncWidgetSettings();
}

/** Toggle ctrl+o widget shortcut. */
export function setWidgetShortcut(enabled: boolean): void {
  __config.agent.widgetShortcut = enabled;
  saveConfigAtomic(__config);
}

/** Replace the entire agent config object (used by "clear all overrides"). */
export function setAgent(agent: typeof __config.agent): void {
  __config.agent = agent;
  saveConfigAtomic(__config);
  syncWidgetSettings();
}

// ============================================================================
// Concurrency setters (save + sync via getManager().setConcurrency)
// ============================================================================

/** Set the global concurrency default. */
export function setConcurrencyDefault(n: number): void {
  __config.concurrency.default = n;
  applyConcurrencyConfig();
}

/** Set or update a per-provider concurrency limit. */
export function setConcurrencyProvider(key: string, n: number): void {
  const current = __config.concurrency.providers ?? {};
  __config.concurrency.providers = { ...current, [key]: n };
  applyConcurrencyConfig();
}

/** Set or update a per-model concurrency limit. */
export function setConcurrencyModel(key: string, n: number): void {
  const current = __config.concurrency.models ?? {};
  __config.concurrency.models = { ...current, [key]: n };
  applyConcurrencyConfig();
}

/** Remove a per-provider concurrency limit. */
export function removeConcurrencyProvider(key: string): void {
  if (__config.concurrency.providers) {
    delete __config.concurrency.providers[key];
  }
  applyConcurrencyConfig();
}

/** Remove a per-model concurrency limit. */
export function removeConcurrencyModel(key: string): void {
  if (__config.concurrency.models) {
    delete __config.concurrency.models[key];
  }
  applyConcurrencyConfig();
}

/** Reset all concurrency settings to defaults. */
export function resetConcurrency(): void {
  __config.concurrency = { ...DEFAULT_CONFIG.concurrency };
  applyConcurrencyConfig();
}
