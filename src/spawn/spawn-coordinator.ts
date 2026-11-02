import { getPiInstance, getSessionCtx, getStore, getWidget } from "../shell.ts";
import { SHORT_ID_LENGTH } from "../types.ts";

import { createProcessProbe } from "../agents/process-probe.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessProbe } from "../agents/process-probe.ts";
import type { AgentRecord, LiveView, SpawnConfig, ToolActivity } from "../types.ts";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.ts";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.ts";

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
   * Parent run's interrupt signal. The coordinator detaches it if the child
   * later promotes itself to background through MessageAgent.
   */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
  isBackground: boolean;
}

// --- Constants ---

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

/** How often a running `bash` call's process tree is sampled for the widget (ms). */
export const BASH_PROBE_INTERVAL_MS = 1000;

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  /** Agent IDs spawned as background — the one-shot first-settlement nudge gate; also backs isBackground(). */
  private backgroundAgentIds = new Set<string>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  /** Stop functions of the active bash-process pollers, so dispose() can end them. */
  private bashPollers = new Set<() => void>();

  constructor(
    private manager: AgentManager,
    /** Where the widget learns what a `bash` call is running; null where the platform has no probe. */
    private processProbe: ProcessProbe | null = createProcessProbe() ?? null,
  ) {}

  /**
   * Spawn + wire tracking; await completion unless background was requested
   * or the child's active tools enable parent communication.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      toolStartedAt: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are forwarded explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    let agentId: string | undefined;
    let isBackground = runInBackground;
    let promotionPending = false;
    let unsubscribeAgentStart: (() => void) | undefined;
    let resolveBackgroundReady!: () => void;
    const backgroundReady = new Promise<void>((resolve) => {
      resolveBackgroundReady = resolve;
    });
    const markBackground = (id: string) => {
      this.backgroundAgentIds.add(id);
      this.manager.detachParentInterrupt(id);
      const record = this.manager.getRecord(id);
      if (record) {
        record.display.invocation = { ...record.display.invocation, runInBackground: true };
      }
    };
    const clearAgentStartSubscription = () => {
      unsubscribeAgentStart?.();
      unsubscribeAgentStart = undefined;
    };
    const promoteToBackground = () => {
      if (isBackground) return;
      if (!agentId) {
        promotionPending = true;
        return;
      }
      const record = this.manager.getRecord(agentId);
      if (!record || record.lifecycle.status !== "running") return;
      isBackground = true;
      clearAgentStartSubscription();
      markBackground(agentId);
      resolveBackgroundReady();
    };
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      signal,
      ...liveViewCallbacks,
      onBackgroundPromotion: promoteToBackground,
      onSessionCreated: (session) => {
        if (runInBackground) return;
        unsubscribeAgentStart = session.subscribe((event) => {
          if (event.type === "agent_start" && session.getActiveToolNames().includes("MessageAgent")) {
            promoteToBackground();
          }
        });
      },
    };

    agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    const record = this.manager.getRecord(agentId)!;
    if (record.execution.promise) {
      void record.execution.promise.then(clearAgentStartSubscription, clearAgentStartSubscription);
    }
    if (promotionPending) {
      promotionPending = false;
      promoteToBackground();
    }
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

    if (runInBackground) {
      markBackground(agentId);
    } else if (!isBackground) {
      await Promise.race([record.execution.promise, backgroundReady]);
    }

    return { agentId, record, isBackground };
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
    for (const stop of this.bashPollers) stop();
    this.disposed = true;
  }

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    const hasActiveBash = () => [...view.activeTools.values()].includes("bash");
    let stopPolling: (() => void) | undefined;

    // Sample the process tree while a bash call is active; the widget's own
    // refresh timer repaints, so this only keeps view.bashPrograms current.
    const startPolling = (sessionId: string) => {
      const probe = this.processProbe;
      if (!probe || stopPolling || !getStore().agent.widgetShowBashPrograms) return;
      let stopped = false;
      let inFlight = false;
      const stop = () => {
        stopped = true;
        clearInterval(timer);
        view.bashPrograms = undefined;
        this.bashPollers.delete(stop);
        stopPolling = undefined;
      };
      const timer = setInterval(() => {
        if (!hasActiveBash()) return stop();
        if (inFlight) return;
        inFlight = true;
        probe
          .runningPrograms(sessionId)
          .then((programs) => {
            if (!stopped) view.bashPrograms = programs.length > 0 ? programs : undefined;
          })
          .catch(() => {
            if (!stopped) view.bashPrograms = undefined;
          })
          .finally(() => {
            inFlight = false;
          });
      }, BASH_PROBE_INTERVAL_MS);
      timer.unref?.();
      this.bashPollers.add(stop);
      stopPolling = stop;
    };

    return {
      onToolActivity: (activity: ToolActivity) => {
        if (activity.type === "start") {
          // Parallel tool calls can start within the same millisecond, so the call id keeps their keys distinct.
          const key = `${activity.toolName}_${activity.toolCallId ?? Date.now()}`;
          view.activeTools.set(key, activity.toolName);
          view.toolStartedAt?.set(key, Date.now());
          if (activity.toolName === "bash" && activity.sessionId) startPolling(activity.sessionId);
        } else {
          // Prefer the call's own entry; otherwise the oldest entry of that tool.
          const entries = [...view.activeTools].filter(([, name]) => name === activity.toolName);
          const own = activity.toolCallId
            ? entries.find(([key]) => key.endsWith(`_${activity.toolCallId}`))
            : undefined;
          const match = own ?? entries[0];
          if (match) {
            view.activeTools.delete(match[0]);
            view.toolStartedAt?.delete(match[0]);
          }
          if (activity.toolName === "bash" && !hasActiveBash()) stopPolling?.();
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
    } catch {
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
