/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentsConfig } from "./model-precedence.js";

const CONFIG_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");

/** Default configuration — used when config file doesn't exist or is invalid. */
export const DEFAULT_CONFIG: SubagentsConfig = {
  agent: {
    default: null,
    forceBackground: false,
    graceTurns: 6,
    widgetMaxLines: 12,
    // widgetMaxLinesCompact intentionally omitted — derives from widgetMaxLines
    widgetCompact: false,
    widgetShortcut: false,
  },
  concurrency: { default: 4 },
};

/** Read config from disk. Returns defaults if file doesn't exist or is invalid. */
export function loadConfig(): SubagentsConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as SubagentsConfig;
  } catch {
    return { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent }, concurrency: { ...DEFAULT_CONFIG.concurrency } };
  }
}

/** Write config to disk with atomic rename. */
export function saveConfigAtomic(config: SubagentsConfig): void {
  const tmpPath = CONFIG_PATH + ".tmp";
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${err}`);
  }
}
