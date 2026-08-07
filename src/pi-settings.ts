/**
 * pi-settings.ts — Read pi's settings file.
 *
 * Wraps reading ~/.pi/agent/settings.json to decouple consumers
 * from pi's file format and path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getPiSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export interface PiSettings {
  hideThinkingBlock?: boolean;
}

/**
 * Read pi's settings.json and return the parsed settings.
 * Returns undefined if the file doesn't exist or can't be parsed.
 */
export function readPiSettings(): PiSettings | undefined {
  try {
    const content = fs.readFileSync(getPiSettingsPath(), "utf-8");
    return JSON.parse(content) as PiSettings;
  } catch {
    return undefined;
  }
}

/**
 * Get the hideThinkingBlock setting from pi's settings.
 * Returns false if the setting is not present or can't be read.
 */
export function getHideThinkingBlock(): boolean {
  const settings = readPiSettings();
  return settings?.hideThinkingBlock ?? false;
}
