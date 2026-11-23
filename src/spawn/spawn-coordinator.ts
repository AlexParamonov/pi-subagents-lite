import { getPiInstance, getSessionCtx, getWidget } from "../shell.ts";
import { SHORT_ID_LENGTH } from "../types.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, AgentStatus, LiveView, SpawnConfig, ToolActivity } from "../types.ts";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.ts";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.ts";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: Nudge system (build/batch/emit), background agent tracking. Live-view
 * state rides on the record (attached here at spawn) so continuations re-feed it.
 * The batch owns the message it delivers: it is built while the record is alive.
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

/**
 * One settlement's delivery, composed while the record is still there to read. The flush sends
 * this and reads no record, so a Clear inside the batch window cannot retract a promised outcome.
 */
interface NudgeMessage {
  agentId: string;
  /** The card's box label and the message header's word; never a rendering mode. */
  kind: "agent" | "workflow";
  /** The agent type or workflow name the header and the notify fallback name. */
  label: string;
  status: AgentStatus;
  content: string;
  details: Record<string, unknown>;
  /** Captured at settlement: the UI-notify fallback needs a live context, not the gone session. */
  spawnCtx?: ExtensionContext;
}

// --- Constants ---

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

/** The word each kind wears: the message header's, the card's box label, the notify fallback's. */
const KIND_LABEL = { agent: "Subagent", workflow: "Workflow" } as const;

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  /** Agent IDs spawned as background — the one-shot first-settlement nudge gate; also backs isBackground(). */
  private backgroundAgentIds = new Set<string>();

  /** Pending settlement deliveries, one per agent (the latest wins), batched within the delay window. */
  private pendingNudges = new Map<string, NudgeMessage>();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking; await completion unless background was requested
   * or the child's active tools enable parent communication.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = { activeTools: new Map(), responseText: "" };
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
   * Enrol a run in the one-shot settlement notification, and nothing else. A workflow run reaches
   * its outcome as a Nudge either at launch (`run_in_background`) or at a hand-back; neither is a
   * background spawn, so the launch posture and the interrupt detach `markBackground` performs
   * would both be lies about how the run was started.
   */
  enrollForNudge(agentId: string): void {
    this.backgroundAgentIds.add(agentId);
  }

  /**
   * Queue a settlement for delivery. Batches with NUDGE_DELAY_MS window to coalesce rapid
   * completions, and keeps only the latest message per agent.
   */
  private scheduleNudge(message: NudgeMessage): void {
    this.pendingNudges.set(message.agentId, message);

    if (this.nudgeTimer) return;

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      const batch = [...this.pendingNudges.values()];
      this.pendingNudges.clear();

      for (const message of batch) {
        this.emitIndividualNudge(message);
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
      this.scheduleNudge(this.settlementMessage(record));
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
          // Parallel tool calls can start within the same millisecond, so the call id keeps their keys distinct.
          view.activeTools.set(activity.toolCallId ?? `${activity.toolName}_${Date.now()}`, activity.toolName);
        } else if (activity.toolCallId) {
          view.activeTools.delete(activity.toolCallId);
        } else {
          // Synthetic end events (e.g. extension-error) carry no call id: clear the oldest call of that tool.
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

  private emitIndividualNudge(message: NudgeMessage): void {
    // Skip if disposed — prevents stale pi usage after session replacement
    if (this.disposed) return;

    // Read pi from shell at call time so we get a fresh reference after reload.
    const pi = getPiInstance();
    if (!pi) return;

    try {
      // Explicit triggerTurn and no deliverAs: pi's streaming queue branch (triggerTurn !== false) is emptied by an ordinary Esc.
      const ctx = getSessionCtx();
      const parentIdle = ctx?.isIdle?.() ?? true;

      pi.sendMessage(
        { customType: "subagent-result", content: message.content, details: message.details, display: true },
        parentIdle ? { triggerTurn: true } : { triggerTurn: false },
      );
    } catch {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      const spawnCtx = message.spawnCtx;
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(
            `[${KIND_LABEL[message.kind]} "${message.label}" ${message.status}] Result available`,
            "info",
          );
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    }
  }

  /**
   * The one message a settlement delivers, for either kind: the run's own header over the text its
   * owner published. A workflow run has no usage accounting, so its details carry no stats.
   */
  private settlementMessage(record: AgentRecord): NudgeMessage {
    const workflow = record.workflow;
    const kind: NudgeMessage["kind"] = workflow ? "workflow" : "agent";
    const label = workflow?.name ?? record.display.type;
    const status = record.lifecycle.status;
    const body = workflow ? (record.result ?? record.error ?? "") : formatResultContent(record);
    // A remote run has no usage accounting: its snapshot asks for none rather than carrying zeros.
    const details = buildAgentDetails(record, { includeStatus: true, includeStats: !workflow });
    details.kind = kind;
    return {
      agentId: record.id,
      kind,
      label,
      status,
      content: `[${KIND_LABEL[kind]} "${label}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${status}]\n\n${body}`,
      details,
      spawnCtx: record.execution.spawnCtx,
    };
  }
}
