/**
 * pi-settings.ts — Read pi's settings.json, decoupling consumers from pi's
 * file format and path.
 */

import * as fs from "node:fs";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.js";
import * as os from "node:os";
import * as path from "node:path";

function getPiSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export interface PiSettings {
  hideThinkingBlock?: boolean;
}

/** Parse pi's settings.json; undefined if missing or unparseable. */
export function readPiSettings(): PiSettings | undefined {
  try {
    const content = fs.readFileSync(getPiSettingsPath(), "utf-8");
    return JSON.parse(content) as PiSettings;
  } catch {
    return undefined;
  }
}

/** True if hideThinkingBlock is set; false if absent or unreadable. */
export function getHideThinkingBlock(): boolean {
  const settings = readPiSettings();
  return settings?.hideThinkingBlock ?? false;
}

/**
 * pi's `defaultThinkingLevel` setting for `cwd` (project over global) — the
 * level a subagent session falls back to when frontmatter thinking and
 * `defaultThinking` are both unset. Reads pi's settings the same way the
 * spawn runtime does (SettingsManager over the agent dir + project dir).
 * agentDir is injectable for tests; defaults to pi's agent dir.
 */
export function getPiDefaultThinkingLevel(cwd: string, agentDir?: string): ThinkingLevel | undefined {
  return SettingsManager.create(cwd, agentDir ?? getAgentDir()).getDefaultThinkingLevel();
}
