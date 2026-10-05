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
  it("covers exactly codemode, tool-search, and mcp by pi's own names (llama.cpp excluded: no sanctioned creator)", () => {
    expect(BUILTIN_EXTENSION_FACTORIES.map((f) => f.name)).toEqual(["codemode", "tool-search", "mcp"]);
  });

  it("marks every entry builtin and replaceable, with a callable factory from pi's SDK", () => {
    for (const entry of BUILTIN_EXTENSION_FACTORIES) {
      expect(entry.builtin).toBe(true);
      expect(entry.replaceable).toBe(true);
      expect(typeof entry.factory).toBe("function");
    }
  });
});
