/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the Shell is the single mutable container for all per-session
 * state. Created at session_start, disposed at session_shutdown. Handler
 * modules read from shell via the getter functions — no module-level mutable
 * globals.
 *
 * index.ts populates the shell at session_start; handler modules import
 * getManager() / getWidget() / etc.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { ConfigStore } from "./config/config-store.js";

// ============================================================================
// Shell type
// ============================================================================

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// ============================================================================
// Mutable module-level shell (populated by index.ts at session_start)
// ============================================================================

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  widget: null,
  store: new ConfigStore(),
  coordinator: null,
};

// ============================================================================
// Getter functions (read current state at call time)
// ============================================================================

/** The PI extension API instance. Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** The current session context. Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** The current AgentManager, or null if not yet created. */
export function getManager(): AgentManager | null {
  return shell.manager;
}

/** The current AgentWidget, or null if not yet created. */
export function getWidget(): AgentWidget | null {
  return shell.widget;
}

/** The ConfigStore (lives for the lifetime of the extension). */
export function getStore(): ConfigStore {
  return shell.store;
}

/** The current SpawnCoordinator, or null if not yet created. */
export function getCoordinator(): SpawnCoordinator | null {
  return shell.coordinator;
}

// ============================================================================
// Setter functions (called by index.ts to populate the shell)
// ============================================================================

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  shell.manager = m;
}

export function setWidget(w: AgentWidget | null): void {
  shell.widget = w;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  shell.coordinator = c;
}
