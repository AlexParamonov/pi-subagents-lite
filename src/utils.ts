/**
 * utils.ts — Security helpers and general utilities.
 *
 * Security helpers (isUnsafeName, isSymlink, safeReadFile) protect against
 * path traversal and symlink attacks in agent/skill name resolution.
 */

import { lstatSync, readFileSync } from "node:fs";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.js";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  return !name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/**
 * Returns true if the given path is a symlink (defense against symlink attacks).
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a file, rejecting symlinks.
 * Returns undefined if the file doesn't exist, is a symlink, or can't be read.
 */
export function safeReadFile(filePath: string): string | undefined {
  try {
    if (isSymlink(filePath)) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** All valid thinking levels. */
export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

/**
 * Validate and narrow a raw string value to ThinkingLevel.
 * Returns undefined if the value is not a valid thinking level.
 */
export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  return VALID_THINKING_LEVELS.includes(raw as ThinkingLevel) ? (raw as ThinkingLevel) : undefined;
}

/**
 * Safely extract a human-readable error message from an unknown exception.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a "provider/model-id" string into { provider, modelId }.
 * Returns null if the format is invalid (no slash or empty provider).
 */
export function parseModelKey(modelStr: string): { provider: string; modelId: string } | null {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx <= 0) return null;
  return { provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
}

/**
 * Find a model in the registry by "provider/model-id" string.
 * Returns the found model, or the fallback if the string is unparseable or not in registry.
 */
export function findModelInRegistry(
  modelStr: string | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined },
  fallback: Model<any> | undefined,
): Model<any> | undefined {
  if (!modelStr) return fallback;
  const parsed = parseModelKey(modelStr);
  if (!parsed) return fallback;
  return registry.find(parsed.provider, parsed.modelId) ?? fallback;
}
/** Timeout for git commands (ms). Shared by agent-runner and worktree-validator. */
export const GIT_EXEC_TIMEOUT_MS = 5000;
