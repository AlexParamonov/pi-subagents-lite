/**
 * Reuse the CLI's complete built-in extension registry, without maintaining
 * a second list of extension/tool names in this package.
 *
 * Pi currently exports getPackageDir(), but not this registry from its public
 * SDK. Keep the distribution-path dependency isolated and contract-tested.
 */
import { getPackageDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

function isInlineExtension(value: unknown): value is InlineExtension {
  return (
    typeof value === "function" ||
    (typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string" &&
      "factory" in value &&
      typeof value.factory === "function")
  );
}

export async function loadPiBuiltinExtensions(packageDir = getPackageDir()): Promise<InlineExtension[]> {
  const registryPath = [
    join(packageDir, "dist", "extensions", "index.js"),
    join(packageDir, "extensions", "index.js"),
  ].find((candidate) => existsSync(candidate));
  if (!registryPath) {
    throw new Error(
      `This Pi installation does not expose its CLI built-in extension registry (${packageDir}). ` +
        "In-process subagents require a Pi npm distribution or built source checkout, not a standalone compiled binary.",
    );
  }
  const registryUrl = pathToFileURL(registryPath).href;
  const registry: { builtInExtensions?: unknown } = await import(registryUrl);
  const extensions = registry.builtInExtensions;
  if (!Array.isArray(extensions) || !extensions.every(isInlineExtension)) {
    throw new Error(`Pi's built-in extension registry has an unsupported format: ${registryUrl}`);
  }
  return [...extensions];
}
