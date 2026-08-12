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

/** Never-started records have no partial output, so the note says the task was not attempted. */
const NEVER_STARTED_STOP_NOTES: Record<StopInitiator, string> = {
  user: "STOPPED BY THE USER before the agent started — the task was NOT attempted",
  agent: "STOPPED BY YOU before the agent started — the task was NOT attempted",
  watchdog: "STOPPED BY WATCHDOG before the agent started — the task was NOT attempted",
};
function watchdogStopDetail(lifecycle: AgentLifecycle): WatchdogStopDetail | undefined {
  return lifecycle.stoppedBy === "watchdog" ? lifecycle.stopDetail : undefined;
}

/** Watchdog stop detail: which check fired, offending tool + elapsed for tool kills. Undefined for non-watchdog stops. */
export function formatStopReason(lifecycle: AgentLifecycle): string | undefined {
  if (lifecycle.status !== "stopped") return undefined;
  const detail = watchdogStopDetail(lifecycle);
  if (!detail) return undefined;
  return detail.kind === "tool"
    ? `STOPPED BY WATCHDOG — tool ${detail.toolName} exceeded ${formatMs(detail.elapsedMs)}`
    : STOP_NOTES.watchdog;
}

/** Generic stop note; never-started records report the task was not attempted. */
function stopNote(lifecycle: AgentLifecycle): string {
  const initiator = lifecycle.stoppedBy ?? "agent";
  // === false: lifecycles without the marker (older test fixtures) read as started.
  return lifecycle.started === false ? NEVER_STARTED_STOP_NOTES[initiator] : STOP_NOTES[initiator];
}

/** One-line watchdog summary for the widget's finished line, e.g. "watchdog: bash >45m". Undefined for non-watchdog stops. */
export function formatWatchdogSummary(lifecycle: AgentLifecycle): string | undefined {
  const detail = watchdogStopDetail(lifecycle);
  if (!detail) return undefined;
  return detail.kind === "tool" ? `watchdog: ${detail.toolName} >${formatMs(detail.elapsedMs)}` : "watchdog: idle";
}

export function getStatusNote(lifecycle: AgentLifecycle): string {
  const note =
    lifecycle.status === "stopped"
      ? // A stopped agent with no recorded initiator reads as an agent stop.
        (formatStopReason(lifecycle) ?? stopNote(lifecycle))
      : STATUS_NOTES[lifecycle.status];
  return note ? ` (${note})` : "";
}
