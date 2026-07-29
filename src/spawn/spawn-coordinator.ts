import { getPiInstance, getSessionCtx, getWidget } from "../shell.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { normalizeThinkingLevel } from "../models/thinking.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, SpawnConfig, ToolActivity } from "../types.js";
import type { AgentConfig } from "../agents/types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import { getAgentConfig } from "../agents/agent-types.js";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.js";

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

// ============================================================================
// Types
// ============================================================================

/** Coordinator-owned per-agent live display state. Only transient UI state. */
export interface LiveView {
  activeTools: Map<string, string>;  // keyed by toolName_timestamp
  responseText: string;
}

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
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

/** Copy array-valued fields so queued work cannot observe later config mutation. */
function snapshotAgentConfig(config: AgentConfig | undefined): AgentConfig | undefined {
  if (!config) return undefined;
  return {
    ...config,
    registeredTools: config.registeredTools && [...config.registeredTools],
    tools: Array.isArray(config.tools) ? [...config.tools] : config.tools,
    excludeTools: config.excludeTools && [...config.excludeTools],
    extensions: Array.isArray(config.extensions) ? [...config.extensions] : config.extensions,
    excludeExtensions: config.excludeExtensions && [...config.excludeExtensions],
    skills: Array.isArray(config.skills) ? [...config.skills] : config.skills,
    preloadSkills: Array.isArray(config.preloadSkills) ? [...config.preloadSkills] : config.preloadSkills,
  };
}

// ============================================================================
// SpawnCoordinator
// ============================================================================

export class SpawnCoordinator {
  /** Per-agent live display state. Widget reads from here + record for stats. */
  private liveViews = new Map<string, LiveView>();

  /** Agent IDs spawned as background — only these trigger a nudge on completion. */
  private backgroundAgentIds = new Set<string>();

  /** Captured ExtensionContext per background agent, bound to the spawning session. */
  private backgroundContexts = new Map<string, ExtensionContext>();

  /** Pending nudge agent IDs, batched within the delay window. */
  private pendingNudges = new Set<string>();

  /** Active nudge timer. */
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for LLM tool executor and menu wizard.
   */
  async spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    intent: SpawnIntent,
  ): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // This is the shared spawn boundary for tool and menu paths. Normalize
    // thinking here so the manager, record, runner, and UI all receive the
    // level the effective model will actually use.
    const model = intent.model ?? ctx.model;
    const thinkingLevel = normalizeThinkingLevel(
      model,
      intent.thinkingLevel ?? ctx.thinkingLevel,
    );
    const modelKey = intent.modelKey ?? (model ? `${model.provider}/${model.id}` : undefined);
    // Callers that discover a worktree pass its config explicitly. The fallback
    // keeps every other coordinator caller safe too.
    const agentConfig = snapshotAgentConfig(intent.agentConfig ?? getAgentConfig(intent.type));

    // Shared config fields (SpawnConfig) pass through unchanged; only the
    // intent-only fields (type/prompt/runInBackground) need translation.
    const { type, prompt, runInBackground, invocation, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      model,
      modelKey,
      thinkingLevel,
      agentConfig,
      invocation: { ...invocation, thinkingLevel },
      isBackground: runInBackground,
      ...liveViewCallbacks,
    };

    const agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);

    // Register live view
    this.liveViews.set(agentId, liveView);

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget();
    if (widget) {
      widget.ensureTimer();
    }

    // Track background agents + capture ctx for fallback notification
    if (intent.runInBackground) {
      this.backgroundAgentIds.add(agentId);
      this.backgroundContexts.set(agentId, ctx);
    }

    const record = this.manager.getRecord(agentId)!;

    if (!intent.runInBackground) {
      // Foreground: await completion
      await record.execution.promise;

      // Foreground tool handler reads the result inline on return — mark it
      // consumed so the cleanup timer may evict the record once it ages out.
      record.lifecycle.resultConsumed = true;

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
    this.backgroundContexts.clear();
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

      // Full result delivered to the LLM — record is now safe for the cleanup
      // timer to evict once it ages out.
      record.lifecycle.resultConsumed = true;
    } catch (error) {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      const spawnCtx = this.backgroundContexts.get(agentId);
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(
            `[Subagent "${record.display.type}" ${record.lifecycle.status}] Result available`,
            "info",
          );
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    } finally {
      this.backgroundContexts.delete(agentId);
    }
  }
}
