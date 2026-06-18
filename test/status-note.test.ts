import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for unknown status", () => {
    expect(getStatusNote("completed")).toBe("");
    expect(getStatusNote("running")).toBe("");
    expect(getStatusNote("foo")).toBe("");
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote("stopped")).toMatch(/^ \(.+\)$/);
    expect(getStatusNote("aborted")).toMatch(/^ \(.+\)$/);
    expect(getStatusNote("turn_limited")).toMatch(/^ \(.+\)$/);
  });

  it("empty note is no-op when appended", () => {
    expect("Task done." + getStatusNote("completed")).toBe("Task done.");
  });
});
