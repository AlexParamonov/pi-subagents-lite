import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for unknown status", () => {
    expect(getStatusNote("completed")).toBe("");
    expect(getStatusNote("queued")).toBe("");
    expect(getStatusNote("running")).toBe("");
    expect(getStatusNote("bogus")).toBe("");
  });

  it("wraps known notes with space-parentheses", () => {
    const stopped = getStatusNote("stopped");
    expect(stopped).toMatch(/^ \(.+\)$/);

    const aborted = getStatusNote("aborted");
    expect(aborted).toMatch(/^ \(.+\)$/);

    const turnLimited = getStatusNote("turn_limited");
    expect(turnLimited).toMatch(/^ \(.+\)$/);
  });

  it("empty note is no-op when appended", () => {
    const note = getStatusNote("completed");
    expect("Task done." + note).toBe("Task done.");
  });
});
