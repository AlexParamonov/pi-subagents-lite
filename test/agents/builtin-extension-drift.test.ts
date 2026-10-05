/**
 * builtin-extension-drift.test.ts — Drift pin against pi's private built-in
 * registry.
 *
 * pi does not export `builtInExtensions`, so this test imports it from the
 * installed package's dist — the one place a pi package-internal import is
 * allowed (test code only, never src). When pi ships a built-in our creator
 * list does not cover, the test fails with its name, converting silent
 * staleness into a loud failure at dependency bumps we control. llama.cpp is
 * the documented exclusion (pi sanctions no creator for it).
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { BUILTIN_EXTENSION_FACTORIES } from "../../src/agents/builtin-extensions.js";

/** Built-ins pi ships that need no coverage: no sanctioned creator exists. */
const DOCUMENTED_EXCLUSIONS = new Set(["llama.cpp"]);

async function importPiBuiltInRegistry(): Promise<Array<{ name: string; builtin?: boolean }>> {
  const registryPath = fileURLToPath(
    new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js", import.meta.url),
  );
  const registry: { builtInExtensions: Array<{ name: string; builtin?: boolean }> } = await import(registryPath);
  return registry.builtInExtensions;
}

describe("built-in extension drift", () => {
  it("covers every pi built-in except the documented exclusions, by name", async () => {
    const piBuiltIns = await importPiBuiltInRegistry();
    const covered = new Set(BUILTIN_EXTENSION_FACTORIES.map((factory) => factory.name));

    const uncovered = piBuiltIns
      .filter((extension) => extension.builtin === true)
      .map((extension) => extension.name)
      .filter((name) => !covered.has(name) && !DOCUMENTED_EXCLUSIONS.has(name));

    expect(uncovered).toEqual([]);
  });
});
