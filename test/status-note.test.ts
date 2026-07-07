import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for unknown status", () => {
    expect(getStatusNote({ status: "foo", startedAt: 0 })).toBe("");
  });

  it("returns user stop message when stoppedBy is user", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/STOPPED BY THE USER/);
  });

  it("returns agent stop message when stoppedBy is agent", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "agent" })).toMatch(/stopped before completion/);
  });

  it("returns agent stop message when stoppedBy is undefined", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0 })).toMatch(/stopped before completion/);
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "user" })).toMatch(/^ \(.+\)$/);
  });
});
