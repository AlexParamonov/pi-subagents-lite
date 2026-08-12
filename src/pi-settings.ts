/**
 * pi-settings.ts — Read pi's settings.json, decoupling consumers from pi's
 * file format and path.
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
