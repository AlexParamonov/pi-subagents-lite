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
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
 * Collapse newlines and carriage returns into single spaces and trim, so a
 * message renders on one line (line-based TUI output breaks on raw CR/LF).
 */
export function toSingleLine(msg: string): string {
  return msg.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Safely extract a human-readable error message from an unknown exception.
 */
export function errorMessage(err: unknown): string {
  return toSingleLine(err instanceof Error ? err.message : String(err));
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

/** Max length for a truncated command in tool arg summaries. */
const MAX_COMMAND_DISPLAY_LENGTH = 350;

/** Max length for a truncated string value in default tool arg summaries. */
const MAX_DEFAULT_STRING_DISPLAY_LENGTH = 350;

/**
 * Summarize tool arguments for log-friendly display.
 *
 * Heavy tools (read, write, edit, bash, grep, rg) get compact summaries.
 * Other tools fall back to the default JSON formatting.
 *
 * Layer-neutral: used by output-file logs, prompt snapshots, and the UI.
 */
export function summarizeToolArgs(name: string, rawArgs: Record<string, unknown> | undefined): string {
  if (!rawArgs || typeof rawArgs !== "object" || Object.keys(rawArgs).length === 0) return "";

  switch (name) {
    case "read": {
      // read("/path/to/file") — just the path
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(path)})`;
    }
    case "write": {
      // write("/path/to/file", <N> chars) — path + content size
      const path = typeof rawArgs.file_path === "string" ? rawArgs.file_path : "";
      const content = rawArgs.content;
      const size = typeof content === "string" ? content.length : 0;
      return `(${JSON.stringify(path)}, ${size} chars)`;
    }
    case "edit": {
      // edit("/path/to/file", <N> edits) — path + edit count
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      const edits = rawArgs.edits;
      const editCount = Array.isArray(edits) ? edits.length : 0;
      return `(${JSON.stringify(path)}, ${editCount} edits)`;
    }
    case "bash": {
      // bash("command") — just the command, strip heredoc, truncate long
      const cmd = typeof rawArgs.command === "string" ? rawArgs.command : "";
      // Strip heredoc: truncate at << followed by delimiter
      const heredocIdx = cmd.search(/<<\s*['"]?\w+['"]?/);
      const cleanCmd = heredocIdx >= 0 ? cmd.slice(0, heredocIdx).trim() : cmd.trim();
      // Truncate long commands
      const display =
        cleanCmd.length > MAX_COMMAND_DISPLAY_LENGTH ? cleanCmd.slice(0, MAX_COMMAND_DISPLAY_LENGTH) + "…" : cleanCmd;
      return `(${JSON.stringify(display)})`;
    }
    case "grep":
    case "rg": {
      // grep("pattern", "/path") — pattern + path
      const pattern = typeof rawArgs.pattern === "string" ? rawArgs.pattern : "";
      const path = typeof rawArgs.path === "string" ? rawArgs.path : "";
      return `(${JSON.stringify(pattern)}, ${JSON.stringify(path)})`;
    }
    default: {
      // Default behavior for other tools: single-arg shorthand or JSON dump
      const keys = Object.keys(rawArgs);
      if (keys.length === 1) {
        const val = rawArgs[keys[0]];
        const display =
          typeof val === "string" && val.length > MAX_DEFAULT_STRING_DISPLAY_LENGTH
            ? JSON.stringify(val.slice(0, MAX_DEFAULT_STRING_DISPLAY_LENGTH) + "...")
            : JSON.stringify(val);
        return `(${display})`;
      }
      return ` ${JSON.stringify(rawArgs)}`;
    }
  }
}
