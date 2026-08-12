/**
 * watchdog.ts — Time-based stuck-agent detection state machine.
 *
 * Tracks per-agent in-flight tool calls and last-activity timestamps, fed by
 * existing session events (`tool_execution_start` / `tool_execution_end` and
 * streamed response text). A manager-owned interval drives `check()`; the
 * manager performs the abort for each returned decision.
 *
 * Pure and clock-injectable: no timers, no I/O, no config access — the
 * thresholds and the running-status predicate are passed in per check.
 */
import type { ToolActivity, WatchdogStopDetail } from "../types.js";

/** Start info for one in-flight tool call, keyed by SDK toolCallId. */
interface WatchdogToolCall {
  toolName: string;
  startedAt: number;
}

interface WatchdogAgentState {
  toolCalls: Map<string, WatchdogToolCall>;
  lastActivityAt: number;
}

export class Watchdog {
  private agents = new Map<string, WatchdogAgentState>();

  /** Clock, injectable for tests. Defaults to wall-clock time. */
  constructor(private now: () => number = Date.now) {}

  /** Begin watching an agent (called when it starts running). The idle clock starts here. */
  start(agentId: string): void {
    this.agents.set(agentId, { toolCalls: new Map(), lastActivityAt: this.now() });
  }

  /** Feed a tool activity event. Any event resets the idle clock. */
  recordActivity(agentId: string, activity: ToolActivity): void {
    const state = this.touch(agentId);
    if (!state) return;

    if (activity.type === "start") {
      // Start events always carry a toolCallId in the SDK; without one there is
      // no stable key to track the call by, so it is not watched.
      if (activity.toolCallId) {
        state.toolCalls.set(activity.toolCallId, { toolName: activity.toolName, startedAt: state.lastActivityAt });
      }
    } else if (activity.toolCallId) {
      state.toolCalls.delete(activity.toolCallId);
    } else {
      // Synthetic end events (e.g. extension-error) carry no toolCallId:
      // clear the first matching call by name, mirroring the live-view bridge.
      for (const [callId, info] of state.toolCalls) {
        if (info.toolName === activity.toolName) {
          state.toolCalls.delete(callId);
          break;
        }
      }
    }
  }

  /** Reset the idle clock on streamed response text. */
  recordText(agentId: string): void {
    this.touch(agentId);
  }

  /** Reset the idle clock; returns state or undefined for unwatched agents. */
  private touch(agentId: string): WatchdogAgentState | undefined {
    const state = this.agents.get(agentId);
    if (!state) return undefined;
    state.lastActivityAt = this.now();
    return state;
  }

  /**
   * Check every watched agent against the thresholds (ms; 0 disables a check).
   * Returns one stop decision per violating agent, keyed by agent id.
   *
   * Tool checks win over idle: a tool call past its timeout is reported as a
   * tool kill so the reason carries the tool name and elapsed duration.
   * State for agents that are no longer running is dropped (self-healing if a
   * completion path ever forgets to stop watching).
   */
  check(
    toolTimeoutMs: number,
    idleTimeoutMs: number,
    isRunning: (agentId: string) => boolean,
  ): Map<string, WatchdogStopDetail> {
    const now = this.now();
    const decisions = new Map<string, WatchdogStopDetail>();

    for (const [agentId, state] of this.agents) {
      if (!isRunning(agentId)) {
        this.agents.delete(agentId);
        continue;
      }

      if (toolTimeoutMs > 0) {
        for (const info of state.toolCalls.values()) {
          const elapsedMs = now - info.startedAt;
          if (elapsedMs >= toolTimeoutMs) {
            decisions.set(agentId, { kind: "tool", toolName: info.toolName, elapsedMs });
            break;
          }
        }
        if (decisions.has(agentId)) continue;
      }

      if (idleTimeoutMs > 0) {
        const elapsedMs = now - state.lastActivityAt;
        if (elapsedMs >= idleTimeoutMs) {
          decisions.set(agentId, { kind: "idle", elapsedMs });
        }
      }
    }

    return decisions;
  }
}
