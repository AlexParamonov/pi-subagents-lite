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
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Valid system prompt modes. */
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  widgetMaxLines: 12,
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
  deltaInputTokens: false,
};

/**
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to handle.
 */
export function loadConfig(): SubagentsConfig {
  let raw: SubagentsConfig;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as SubagentsConfig;
  } catch {
    raw = {} as SubagentsConfig;
  }

  // @ts-expect-error TS2783: spread may override 'default', which is intentional (loaded value wins)
  const concurrency = { default: 4, ...(raw.concurrency ?? {}) } as SubagentsConfig["concurrency"];
  return {
    agent: { ...DEFAULT_AGENT, ...raw.agent },
    concurrency,
  };
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
