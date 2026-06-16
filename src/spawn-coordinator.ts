/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: LiveView store, Nudge system (schedule/batch/emit), background agent tracking.
 * Delegates concurrency and record lifecycle to AgentManager (peers, not ownership).
 *
 * Decision refs: D3 (forward events to live-view), D4 (stats on record only),
 * D6 (Nudge owned here), D2 (peers with AgentManager).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, ThinkingLevel, AgentInvocation } from "./types.js";
import type { AgentManager, SpawnOptions } from "./agent-manager.js";
import type { Model } from "@earendil-works/pi-ai";
import { buildAgentDetails } from "./tool-execution.js";

// ============================================================================
// Types
// ============================================================================

/** Coordinator-owned per-agent live display state. Only transient UI state. */
export interface LiveView {
  activeTools: Map<string, string>;  // keyed by toolName_timestamp
  responseText: string;
}

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent {
  type: string;
  prompt: string;
  description: string;
  model?: Model<any>;
  modelKey?: string;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns: number;
  worktreePath?: string;
  worktreeLabel?: string;
  invocation?: AgentInvocation;
  runInBackground: boolean;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

// ============================================================================
// Constants
// ============================================================================

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

// ============================================================================
// SpawnCoordinator
// ============================================================================

export class SpawnCoordinator {
  /** Per-agent live display state. Widget reads from here + record for stats. */
  private liveViews = new Map<string, LiveView>();

  /** Agent IDs spawned as background — only these trigger a nudge on completion. */
  private backgroundAgentIds = new Set<string>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  /** Active nudge timer. */
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** The pi API reference for sending messages. */
  private pi: ExtensionAPI | null = null;

  constructor(private manager: AgentManager, pi?: ExtensionAPI) {
    if (pi) this.pi = pi;
  }

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for LLM tool executor and menu wizard.
   */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    // Store pi for nudge emission
    this.pi = pi;

    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    const spawnOptions: SpawnOptions = {
      description: intent.description,
      model: intent.model,
      maxTurns: intent.maxTurns,
      thinkingLevel: intent.thinkingLevel,
      modelKey: intent.modelKey,
      invocation: intent.invocation,
      graceTurns: intent.graceTurns,
      worktreePath: intent.worktreePath,
      worktreeLabel: intent.worktreeLabel,
      isBackground: intent.runInBackground,
      ...liveViewCallbacks,
    };

    const agentId = this.manager.spawn(pi, ctx, intent.type, intent.prompt, spawnOptions);

    // Register live view
    this.liveViews.set(agentId, liveView);

    // Track background agents
    if (intent.runInBackground) {
      this.backgroundAgentIds.add(agentId);
    }

    const record = this.manager.getRecord(agentId)!;

    if (!intent.runInBackground) {
      // Foreground: await completion
      await record.execution.promise;

      // Clean up live view (foreground completion handled inline)
      this.liveViews.delete(agentId);
    }

    return { agentId, record };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.liveViews.get(id);
  }

  /** Check if an agent was spawned as background. */
  isBackground(agentId: string): boolean {
    return this.backgroundAgentIds.has(agentId);
  }

  /**
   * Schedule a nudge for a background agent.
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
   * Owns the completion side-effects: nudge scheduling, live-view cleanup.
   */
  onAgentComplete(record: AgentRecord): void {
    // Schedule nudge for background agents
    if (this.backgroundAgentIds.has(record.id)) {
      this.scheduleNudge(record.id);
      this.backgroundAgentIds.delete(record.id);
    }

    // Clean up live view
    this.liveViews.delete(record.id);
  }

  /** Dispose: clear timer, live views, and background tracking. */
  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.pendingNudges.clear();
    this.liveViews.clear();
    this.backgroundAgentIds.clear();
    this.pi = null;
  }

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
        if (activity.type === "start") {
          view.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
        } else {
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) { view.activeTools.delete(key); break; }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => {
        view.responseText = fullText;
      },
    };
  }

  /** Emit an individual nudge for a completed background agent. */
  private emitIndividualNudge(agentId: string): void {
    const record = this.manager.getRecord(agentId);
    if (!record || !this.pi) return;

    const details = buildAgentDetails(record, {
      includeStats: true,
      includeStatus: true,
    });

    this.pi.sendMessage(
      {
        customType: "subagent-result",
        content: `[Subagent "${record.display.type}" ${record.lifecycle.status}]\n\n${record.result ?? ""}`,
        details,
        display: true,
      },
      {
        deliverAs: "steer",
        triggerTurn: true,
      },
    );
  }
}
