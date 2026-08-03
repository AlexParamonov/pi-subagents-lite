import type { AgentLifecycle, AgentStatus, StopInitiator } from "./types.js";

const STATUS_NOTES: Partial<Record<AgentStatus, string>> = {
  aborted: "hit the turn limit before completion; output may be incomplete",
  turn_limited: "wrapped up at the turn limit — output may be partial",
};

const STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before completion — output is partial; the task was NOT finished",
  agent: "STOPPED BY YOU before completion — output is partial; the task was NOT finished",
  watchdog: "STOPPED BY WATCHDOG — no activity for longer than the idle timeout",
};

/** Compact elapsed duration: "30s", "45m", "2h 5m". */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Full stop reason for a watchdog kill: which check fired, and for tool
 * kills the offending tool name and elapsed duration. Undefined for any
 * non-watchdog stop, so callers fall back to the generic note.
 */
export function formatStopReason(lifecycle: AgentLifecycle): string | undefined {
  if (lifecycle.stoppedBy !== "watchdog" || lifecycle.status !== "stopped") return undefined;
  const detail = lifecycle.stopDetail;
  if (detail?.kind === "tool") {
    return `STOPPED BY WATCHDOG — tool ${detail.toolName} exceeded ${formatElapsed(detail.elapsedMs)}`;
  }
  return STOP_NOTES.watchdog;
}

/**
 * Compact one-line watchdog summary for the widget's finished line,
 * e.g. "watchdog: bash >45m" or "watchdog: idle". Undefined for non-watchdog stops.
 */
export function formatWatchdogSummary(lifecycle: AgentLifecycle): string | undefined {
  if (lifecycle.stoppedBy !== "watchdog") return undefined;
  const detail = lifecycle.stopDetail;
  if (detail?.kind === "tool") return `watchdog: ${detail.toolName} >${formatElapsed(detail.elapsedMs)}`;
  return "watchdog: idle";
}

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      ? // A stopped agent with no recorded initiator reads as an agent stop.
        (formatStopReason(lifecycle) ?? STOP_NOTES[lifecycle.stoppedBy ?? "agent"])
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
