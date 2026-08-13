/**
 * context.test.ts — Tests for conversation context helpers.
 */

import { describe, it, expect } from "vitest";
import { extractText } from "../../src/prompt/context.js";

/* ------------------------------------------------------------------ */
/*  extractText                                                        */
/* ------------------------------------------------------------------ */

describe("extractText", () => {
  it("extracts text from a simple content array", () => {
    const content = [{ type: "text", text: "Hello world" }];
    expect(extractText(content)).toBe("Hello world");
  });

  it("joins multiple text blocks with newlines", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];
    expect(extractText(content)).toBe("First line\nSecond line");
  });

  it("filters out non-text blocks", () => {
    const content = [
      { type: "text", text: "Visible" },
      { type: "image", data: "base64...", mimeType: "image/png" },
      { type: "toolCall", id: "tc1", name: "read", arguments: {} },
    ];
    expect(extractText(content)).toBe("Visible");
  });

  it("returns empty string for empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("handles null/undefined text fields", () => {
    const content = [
      { type: "text", text: null },
      { type: "text", text: "Valid" },
    ];
    expect(extractText(content)).toBe("\nValid");
  });
});
