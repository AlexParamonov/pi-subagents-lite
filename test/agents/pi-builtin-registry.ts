/**
 * pi-builtin-registry.ts — the one sanctioned pi package-internal import.
 *
 * pi does not export `builtInExtensions`, so reading it means importing from
 * the installed package's dist. This helper is that single place; it exists
 * in test code only, never src (constraint in the issue).
 */

import { fileURLToPath } from "node:url";

/** pi's private built-in extension registry, as factory-shaped entries. */
export async function importPiBuiltInExtensions<T = unknown>(): Promise<T[]> {
  const registryPath = fileURLToPath(
    new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js", import.meta.url),
  );
  const registry: { builtInExtensions: T[] } = await import(registryPath);
  return registry.builtInExtensions;
}
