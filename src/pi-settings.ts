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

/**
 * pi's defaultTools setting for a SettingsManager.
 *
 * pi >= 0.84.2 exposes SettingsManager.getDefaultTools(); older pi has no
 * accessor but still carries the key on its merged settings object, so
 * the feature degrades to the same value instead of crashing. Returns a
 * copy of the setting when configured (including []), undefined when
 * unconfigured — the two must stay distinct.
 */
export function readDefaultTools(settingsManager: SettingsManager): string[] | undefined {
  // Cast through unknown: on pi >= 0.84.2 `settings` is private in the type
  // declarations, so an intersection would collapse to never.
  const sm = settingsManager as unknown as {
    getDefaultTools?: () => string[] | undefined;
    settings?: { defaultTools?: string[] };
  };
  const tools = sm.getDefaultTools ? sm.getDefaultTools() : sm.settings?.defaultTools;
  // Only undefined means "unconfigured": an explicitly empty array is a valid
  // zero-tool set, and anything else (e.g. null in raw settings JSON) degrades
  // to the hardcoded fallback instead of crashing.
  return Array.isArray(tools) ? [...tools] : undefined;
}
