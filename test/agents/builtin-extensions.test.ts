/**
 * builtin-extensions.test.ts — The child loader's built-in extension factory list.
 *
 * Pins the wrapped SDK creators (names, builtin/replaceable flags) that give
 * child sessions pi's built-in extensions. Coverage against pi's own private
 * registry is pinned separately by the drift test.
 */

import { describe, it, expect } from "vitest";
import { BUILTIN_EXTENSION_FACTORIES } from "../../src/agents/builtin-extensions.js";

describe("BUILTIN_EXTENSION_FACTORIES", () => {
  it("covers codemode, tool-search, and mcp by pi's own names", () => {
    expect(BUILTIN_EXTENSION_FACTORIES.map((f) => f.name)).toEqual(["codemode", "tool-search", "mcp"]);
  });

  it("marks every entry builtin so pi's loader applies settings selection", () => {
    for (const entry of BUILTIN_EXTENSION_FACTORIES) {
      expect(entry.builtin).toBe(true);
    }
  });

  it("marks replaceable entries so a user extension can take over", () => {
    for (const entry of BUILTIN_EXTENSION_FACTORIES) {
      expect(entry.replaceable).toBe(true);
    }
  });

  it("carries callable factories from pi's public SDK creators", () => {
    for (const entry of BUILTIN_EXTENSION_FACTORIES) {
      expect(typeof entry.factory).toBe("function");
    }
  });

  it("never exposes llama.cpp (no sanctioned creator, path loading banned)", () => {
    expect(BUILTIN_EXTENSION_FACTORIES.map((f) => f.name)).not.toContain("llama.cpp");
  });
});
