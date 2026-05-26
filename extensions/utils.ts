/**
 * utils.ts — Security helpers: safe file access, name validation.
 *
 * Extracted from upstream memory.ts — pure implementations copied verbatim.
 */

import { lstatSync, readFileSync } from "node:fs";

/**
 * Returns true if a name contains characters not allowed in agent/skill names.
 * Uses a whitelist: only alphanumeric, hyphens, underscores, and dots (no leading dot).
 */
export function isUnsafeName(name: string): boolean {
  if (!name || name.length > 128) return true;
  return !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
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
    if (lstatSync(filePath).isSymbolicLink()) return undefined;
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}
