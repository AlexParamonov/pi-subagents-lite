import { getPiInstance, getSessionCtx, getWidget } from "../shell.js";
import { SHORT_ID_LENGTH } from "../types.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, LiveView, SpawnConfig, ToolActivity } from "../types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.js";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: Nudge system (schedule/batch/emit), background agent tracking. Live-view
 * state rides on the record (attached here at spawn) so continuations re-feed it.
 * Delegates concurrency and record lifecycle to AgentManager (peers, not ownership).
 *
 * Decision refs: D3 (forward events to live-view), D4 (stats on record only),
 * D6 (Nudge owned here), D2 (peers with AgentManager).
 */

// --- Types ---

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /**
   * Parent run's interrupt signal, forwarded to the manager for foreground
   * spawns only. Background and menu-wizard spawns never carry one.
   */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

// --- Constants ---

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  /** Agent IDs spawned as background — the one-shot first-settlement nudge gate; also backs isBackground(). */
  private backgroundAgentIds = new Set<string>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for LLM tool executor and menu wizard.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are forwarded explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      signal,
      ...liveViewCallbacks,
    };

    const agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    const record = this.manager.getRecord(agentId)!;
    // Spawn-time state rides on the record so it survives settlement: the
    // live view is re-fed by continuations, and the ctx keeps the UI-notify
    // fallback reachable for any later nudge (continuations included).
    record.execution.liveView = liveView;
    record.execution.spawnCtx = ctx;

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget();
    if (widget) {
      widget.ensureTimer();
    }

    if (intent.runInBackground) {
      this.backgroundAgentIds.add(agentId);
    } else {
      await record.execution.promise;
    }

    return { agentId, record };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.manager.getRecord(id)?.execution.liveView;
  }

  isBackground(agentId: string): boolean {
    return this.backgroundAgentIds.has(agentId);
  }

  /**
   * Schedule a nudge for an agent.
   * Batches with NUDGE_DELAY_MS window to coalesce rapid completions.
   */
  scheduleNudge(agentId: string): void {
    this.pendingNudges.add(agentId);

    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.pendingNudges];
      this.pendingNudges.clear();

      for (const id of batch) {
        this.emitIndividualNudge(id);
      }
    }, NUDGE_DELAY_MS);
  }

  /**
   * Called by AgentManager's onComplete callback (wired at session_start).
   * Owns the completion side-effects: nudge scheduling. The live view stays
   * on the record — a settled agent can be continued and re-feeds it.
   */
  onAgentComplete(record: AgentRecord): void {
    // One-shot background gate: the first settlement of a background agent
    // nudges and consumes the set entry. Continuation settlements (ordinal
    // >= 2, written by the manager before this callback fires) nudge for both
    // spawn classes — the coordinator never observes steers itself.
    if (this.backgroundAgentIds.delete(record.id) || record.execution.settlementCount >= 2) {
      this.scheduleNudge(record.id);
    }
  }

  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();
    this.backgroundAgentIds.clear();
    this.disposed = true;
  }

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start") {
          view.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
        } else {
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) {
              view.activeTools.delete(key);
              break;
            }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => {
        view.responseText = fullText;
      },
    };
  }

  private emitIndividualNudge(agentId: string): void {
    // Skip if disposed — prevents stale pi usage after session replacement
    if (this.disposed) return;

    // Read pi from shell at call time so we get a fresh reference after reload.
    const pi = getPiInstance();
    if (!pi) return;

    const record = this.manager.getRecord(agentId);
    if (!record) return;

    const details = buildAgentDetails(record, {
      includeStats: true,
      includeStatus: true,
    });

    try {
      // Pick delivery mode based on parent session state:
      // - steer: queues while running, delivers before next LLM call
      // - followUp: waits for agent to finish, then delivers
      const ctx = getSessionCtx();
      const parentIdle = ctx?.isIdle?.() ?? true;
      const deliverAs = parentIdle ? "followUp" : "steer";

      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]\n\n${formatResultContent(record)}`,
          details,
          display: true,
        },
        {
          deliverAs,
          triggerTurn: true,
        },
      );
    } catch (error) {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      const spawnCtx = record.execution.spawnCtx;
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(`[Subagent "${record.display.type}" ${record.lifecycle.status}] Result available`, "info");
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    }
  }
}
