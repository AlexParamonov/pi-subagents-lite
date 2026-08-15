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
    expect(reason).toBe("STOPPED BY WATCHDOG — tool bash exceeded 46m");
  });

  it("identifies an idle-timeout kill", () => {
    const reason = formatStopReason({
      status: "stopped",
      startedAt: 0,
      stoppedBy: "watchdog",
      stopDetail: { kind: "idle", elapsedMs: 46 * 60_000 },
    });
    expect(reason).toBe("STOPPED BY WATCHDOG — no activity for longer than the idle timeout");
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
    expect(note).toBe(" (STOPPED BY WATCHDOG — tool bash exceeded 45m)");
  });

  it("falls back to the generic watchdog note when no detail is recorded", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "watchdog" })).toBe(
      " (STOPPED BY WATCHDOG — no activity for longer than the idle timeout)",
    );
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

describe("getStatusNote — never-started stopped records", () => {
  it("renders the never-started note for a user stop that never started", () => {
    const note = getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user", started: false });
    expect(note).toContain("before the agent started");
    expect(note).toContain("NOT attempted");
    expect(note).not.toContain("output is partial");
  });

  it("renders the never-started note for an agent stop that never started", () => {
    const note = getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "agent", started: false });
    expect(note).toContain("STOPPED BY YOU");
    expect(note).toContain("before the agent started");
    expect(note).not.toContain("output is partial");
  });

  it("keeps the ran-then-stopped note once the record started", () => {
    const note = getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user", started: true });
    expect(note).toContain("before completion");
    expect(note).toContain("output is partial");
  });

  it("renders the never-started note for a watchdog stop that never started", () => {
    const note = getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "watchdog", started: false });
    expect(note).toContain("STOPPED BY WATCHDOG");
    expect(note).toContain("before the agent started");
    expect(note).not.toContain("output is partial");
  });
});
