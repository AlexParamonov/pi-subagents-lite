/**
 * pi-settings.ts — Read pi's settings.json, decoupling consumers from pi's
 * file format and path.
 */

import * as fs from "node:fs";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types.js";
import * as os from "node:os";
import * as path from "node:path";

/** How a read is scoped: which settings files it consults. */
export interface PiSettingsScope {
  /** pi's agent dir; defaults to pi's own. Injectable for tests. */
  agentDir?: string;
  /**
   * False for an untrusted project: its own layer is ignored while the global
   * one still applies — the same scope the untrusted target's child session is
   * created with. Omitted means trusted.
   */
  projectTrusted?: boolean;
}

function settingsFor(cwd: string, scope: PiSettingsScope): SettingsManager {
  return SettingsManager.create(cwd, scope.agentDir ?? getAgentDir(), { projectTrusted: scope.projectTrusted });
}

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
 */
export function getPiDefaultThinkingLevel(cwd: string, scope?: PiSettingsScope): ThinkingLevel | undefined {
  return settingsFor(cwd, scope ?? {}).getDefaultThinkingLevel();
}

/**
 * pi's per-model thinking level for one model (project layer over global),
 * keyed the way pi keys `modelThinkingLevels`: `provider/modelId`. Undefined
 * when the model has no entry.
 */
export function getPiModelThinkingLevel(
  cwd: string,
  provider: string,
  modelId: string,
  scope?: PiSettingsScope,
): ThinkingLevel | undefined {
  return settingsFor(cwd, scope ?? {}).getModelThinkingLevel(provider, modelId);
}

/**
 * pi's whole per-model thinking map (project over global), keyed
 * `provider/modelId`. For surfaces that look up many models (menus): one
 * settings read instead of one per row. Returns a copy.
 */
export function getPiModelThinkingLevels(cwd: string, scope?: PiSettingsScope): Record<string, ThinkingLevel> {
  return settingsFor(cwd, scope ?? {}).getAllModelThinkingLevels();
}
