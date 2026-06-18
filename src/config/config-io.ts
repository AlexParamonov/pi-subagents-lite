/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SubagentsConfig } from "../models/model-precedence.js";

const CONFIG_DIR = path.join(process.env.HOME || "", ".pi", "agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");

/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Default configuration — used when config file doesn't exist or is invalid. */
export const DEFAULT_CONFIG: SubagentsConfig = {
  agent: {
    default: null,
    forceBackground: false,
    graceTurns: DEFAULT_GRACE_TURNS,
    widgetMaxLines: 12,
    // widgetMaxLinesCompact intentionally omitted — derives from widgetMaxLines
    widgetDescLengthFull: 50,
    widgetDescLengthCompact: 30,
    widgetCompact: false,
    widgetShortcut: false,
    systemPromptMode: "replace",
    includeContextFiles: true,
    disableDefaultAgents: false,
    showTools: true,
    showTurns: true,
    showInput: true,
    showOutput: true,
    showContext: true,
    showCost: false,
    showTime: true,
  },
  concurrency: { default: 4 },
};

/**
 * Read config from disk. Returns defaults if file doesn't exist or is invalid.
 */
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
