import { describe, expect, it } from "vitest";
import { getStatusNote, formatStopReason, formatWatchdogSummary } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for status without a note", () => {
    expect(getStatusNote({ status: "completed", startedAt: 0 })).toBe("");
  });

  it("returns user stop message when stoppedBy is user", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/STOPPED BY THE USER/);
  });

  it("returns agent stop message when stoppedBy is agent", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "agent" })).toMatch(/STOPPED BY YOU/);
  });

  it("returns agent stop message when stoppedBy is undefined", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0 })).toMatch(/STOPPED BY YOU/);
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/^ \(.+\)$/);
  });
});

describe("formatStopReason", () => {
  it("identifies a tool-timeout kill with the tool name and elapsed duration", () => {
    const reason = formatStopReason({
      status: "stopped",
      startedAt: 0,
      stoppedBy: "watchdog",
      stopDetail: { kind: "tool", toolName: "bash", elapsedMs: 46 * 60_000 },
    });
    expect(reason).toMatch(/STOPPED BY WATCHDOG/);
    expect(reason).toContain("bash");
    expect(reason).toContain("46m");
  });

  it("identifies an idle-timeout kill", () => {
    const reason = formatStopReason({
      status: "stopped",
      startedAt: 0,
      stoppedBy: "watchdog",
      stopDetail: { kind: "idle", elapsedMs: 46 * 60_000 },
    });
    expect(reason).toMatch(/STOPPED BY WATCHDOG/);
    expect(reason).not.toContain("bash");
  });

  it("returns undefined for non-watchdog stops and non-stopped statuses", () => {
    expect(formatStopReason({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toBeUndefined();
    expect(formatStopReason({ status: "stopped", startedAt: 0, stoppedBy: "agent" })).toBeUndefined();
    expect(formatStopReason({ status: "completed", startedAt: 0, stoppedBy: "watchdog" })).toBeUndefined();
  });
});

describe("getStatusNote — watchdog", () => {
  it("surfaces the watchdog reason with tool name for tool kills", () => {
    const note = getStatusNote({
      status: "stopped",
      startedAt: 0,
      stoppedBy: "watchdog",
      stopDetail: { kind: "tool", toolName: "bash", elapsedMs: 45 * 60_000 },
    });
    expect(note).toMatch(/^ \(STOPPED BY WATCHDOG/);
    expect(note).toContain("bash");
    expect(note).toContain("45m");
  });

  it("falls back to the generic watchdog note when no detail is recorded", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "watchdog" })).toMatch(/STOPPED BY WATCHDOG/);
  });
});

describe("formatWatchdogSummary", () => {
  it("renders a compact tool-kill summary for the widget", () => {
    expect(
      formatWatchdogSummary({
        status: "stopped",
        startedAt: 0,
        stoppedBy: "watchdog",
        stopDetail: { kind: "tool", toolName: "bash", elapsedMs: 45 * 60_000 },
      }),
    ).toBe("watchdog: bash >45m");
  });

  it("renders a compact idle-kill summary for the widget", () => {
    expect(
      formatWatchdogSummary({
        status: "stopped",
        startedAt: 0,
        stoppedBy: "watchdog",
        stopDetail: { kind: "idle", elapsedMs: 0 },
      }),
    ).toBe("watchdog: idle");
  });

  it("returns undefined for non-watchdog stops", () => {
    expect(formatWatchdogSummary({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toBeUndefined();
  });
});
