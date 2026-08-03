import { formatMs } from "./ui/format.js";
import type { AgentLifecycle, AgentStatus, StopInitiator, WatchdogStopDetail } from "./types.js";

const STATUS_NOTES: Partial<Record<AgentStatus, string>> = {
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

const STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent: "STOPPED BY YOU before completion — output is partial; the task was NOT finished",
  watchdog: "STOPPED BY WATCHDOG — no activity for longer than the idle timeout",
};
/** The recorded detail when a lifecycle records a watchdog kill; undefined for other stops. */
function watchdogStopDetail(lifecycle: AgentLifecycle): WatchdogStopDetail | undefined {
  return lifecycle.stoppedBy === "watchdog" ? lifecycle.stopDetail : undefined;
}

/**
 * Full stop reason for a watchdog kill: which check fired, and for tool
 * kills the offending tool name and elapsed duration. Undefined for any
 * non-watchdog stop, so callers fall back to the generic note.
 */
export function formatStopReason(lifecycle: AgentLifecycle): string | undefined {
  if (lifecycle.status !== "stopped") return undefined;
  const detail = watchdogStopDetail(lifecycle);
  if (!detail) return undefined;
  return detail.kind === "tool"
    ? `STOPPED BY WATCHDOG — tool ${detail.toolName} exceeded ${formatMs(detail.elapsedMs)}`
    : STOP_NOTES.watchdog;
}

/**
 * Compact one-line watchdog summary for the widget's finished line,
 * e.g. "watchdog: bash >45m" or "watchdog: idle". Undefined for non-watchdog stops.
 */
export function formatWatchdogSummary(lifecycle: AgentLifecycle): string | undefined {
  const detail = watchdogStopDetail(lifecycle);
  if (!detail) return undefined;
  return detail.kind === "tool" ? `watchdog: ${detail.toolName} >${formatMs(detail.elapsedMs)}` : "watchdog: idle";
}

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      ? // A stopped agent with no recorded initiator reads as an agent stop.
        (formatStopReason(lifecycle) ?? STOP_NOTES[lifecycle.stoppedBy ?? "agent"])
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
