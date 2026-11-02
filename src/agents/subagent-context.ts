import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.ts";

export type SubagentAgentManager = Pick<AgentManager, "getRecord" | "listAgents" | "matchAgents" | "steer">;

export interface SubagentParentContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager?: SubagentAgentManager;
  agentId?: string;
  agentStatusLimit?: number;
  onBackgroundPromotion?: () => void;
}

const storageKey = Symbol.for("pi-subagents-lite:subagent-parent-context");
const storage = getStorage();

function getStorage(): AsyncLocalStorage<SubagentParentContext> {
  const globalState = globalThis as unknown as Record<symbol, unknown>;
  const existing = globalState[storageKey];
  if (existing) return existing as AsyncLocalStorage<SubagentParentContext>;

  const created = new AsyncLocalStorage<SubagentParentContext>();
  globalState[storageKey] = created;
  return created;
}

/** Pi loads a fresh extension module for a different cwd, so share only this scoped handoff. */
export function withSubagentParent<T>(parent: SubagentParentContext, callback: () => T): T {
  return storage.run(parent, callback);
}

export function getSubagentParent(): SubagentParentContext | undefined {
  return storage.getStore();
}
