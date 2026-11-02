/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the single mutable container for all per-session state,
 * created at session_start, disposed at session_shutdown. Handler modules
 * read via getter functions — no module-level mutable globals.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.ts";
import type { AgentWidget } from "./ui/agent-widget.ts";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.ts";
import { ConfigStore } from "./config/config-store.ts";

// --- Shell type ---

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// --- Mutable module-level shell (populated by index.ts at session_start) ---

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  widget: null,
  store: new ConfigStore(),
  coordinator: null,
};

// --- Getter functions (read current state at call time) ---

/** Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** Null until created at session_start. */
export function getManager(): AgentManager | null {
  return shell.manager;
}

/** Null until created at session_start. */
export function getWidget(): AgentWidget | null {
  return shell.widget;
}

/** Lives for the lifetime of the extension. */
export function getStore(): ConfigStore {
  return shell.store;
}

/** Null until created at session_start. */
export function getCoordinator(): SpawnCoordinator | null {
  return shell.coordinator;
}

// --- Setter functions (called by index.ts to populate the shell) ---

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
