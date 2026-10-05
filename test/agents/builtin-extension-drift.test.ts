/**
 * builtin-extension-drift.test.ts — Drift pin against pi's private built-in
 * registry (via the shared test-only import in pi-builtin-registry.ts).
 *
 * When pi ships a built-in our creator list does not cover, the test fails
 * with its name, converting silent staleness into a loud failure at
 * dependency bumps we control. llama.cpp is the documented exclusion (pi
 * sanctions no creator for it).
 */

import { describe, it, expect } from "vitest";
import { BUILTIN_EXTENSION_FACTORIES } from "../../src/agents/builtin-extensions.js";
import { importPiBuiltInExtensions } from "./pi-builtin-registry.js";

/** Built-ins pi ships that need no coverage: no sanctioned creator exists. */
const DOCUMENTED_EXCLUSIONS = new Set(["llama.cpp"]);

describe("built-in extension drift", () => {
  it("covers every pi built-in except the documented exclusions, by name", async () => {
    const piBuiltIns = await importPiBuiltInExtensions<{ name: string; builtin?: boolean }>();
    const covered = new Set(BUILTIN_EXTENSION_FACTORIES.map((factory) => factory.name));

    const uncovered = piBuiltIns
      .filter((extension) => extension.builtin === true)
      .map((extension) => extension.name)
      .filter((name) => !covered.has(name) && !DOCUMENTED_EXCLUSIONS.has(name));

    expect(uncovered).toEqual([]);
  });
});
