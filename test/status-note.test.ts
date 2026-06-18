import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for unknown status", () => {
    expect(getStatusNote("foo")).toBe("");
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote("stopped")).toMatch(/^ \(.+\)$/);
  });
});
