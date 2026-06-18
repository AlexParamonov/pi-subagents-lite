import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for completed status", () => {
    expect(getStatusNote("completed")).toBe("");
  });

  it("returns empty string for queued status", () => {
    expect(getStatusNote("queued")).toBe("");
  });

  it("returns empty string for running status", () => {
    expect(getStatusNote("running")).toBe("");
  });

  it("returns empty string for unknown status", () => {
    expect(getStatusNote("unknown")).toBe("");
  });

  it("returns explicit note for stopped status", () => {
    expect(getStatusNote("stopped")).toBe(
      " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)",
    );
  });

  it("returns explicit note for aborted status", () => {
    expect(getStatusNote("aborted")).toBe(
      " (hit the turn limit before completion; output may be incomplete)",
    );
  });

  it("returns explicit note for turn_limited status", () => {
    expect(getStatusNote("turn_limited")).toBe(
      " (wrapped up at the turn limit — output may be partial)",
    );
  });

  it("note appends cleanly to result text", () => {
    const result = "Task completed partially.";
    const note = getStatusNote("aborted");
    expect(result + note).toBe(
      "Task completed partially. (hit the turn limit before completion; output may be incomplete)",
    );
  });

  it("empty note is no-op when appended", () => {
    const result = "Task done.";
    const note = getStatusNote("completed");
    expect(result + note).toBe("Task done.");
  });
});
