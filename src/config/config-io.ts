/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Project-level config: when created with a project's `.pi` directory and a
 * valid `.pi/subagents-lite.json` exists, that file IS the entire config —
 * the global file is not read. Without a valid project file (absent or
 * malformed), the global file is used exactly as today. One file wins, wholly:
 * no merging, no diffs, no tombstones. See docs/adr/0007-project-level-config.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.js";

/** File name of the config in both the global agent dir and a project's .pi dir. */
const CONFIG_FILE_NAME = "subagents-lite.json";
const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;
/** Default watchdog timeout (tool and idle) in minutes. 0 disables a check. */
export const DEFAULT_WATCHDOG_TIMEOUT_MINUTES = 45;
/** Minimum finished retention: 1 second expressed in minutes. */
export const MIN_FINISHED_RETENTION_MINUTES = 1 / 60;

export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

/** Default agent settings — merged into loaded config so callers get a complete shape. */
export const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  widgetMaxLines: 12,
  toolTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
  idleTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,

  widgetCompact: false,
  showCompletionCards: true,
  widgetShortcut: false,
  widgetShowModel: true,
  widgetShowThinking: true,
  widgetNavHint: true,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  agentToolStrictMode: false,
  showTools: false,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
  outputTranscript: false,
  finishedRetentionMinutes: 1,
  modelDisplayStyle: "name",
  modelThinkingPlacement: "header",
  statusBarFormat: "full",
};

/** Persistence port consumed by ConfigStore. */
export interface ConfigIO {
  load(): SubagentsConfig;
  save(config: SubagentsConfig): void;
}

/** The file in use at load: its raw contents and the path saves go to. */
interface LoadedFile {
  raw: SubagentsConfig;
  path: string;
}

/**
 * Create a ConfigIO. With a project's `.pi` directory and a valid project
 * config file, that file is the entire config on load and the only save
 * target; otherwise the global file behaves exactly as today. One file wins,
 * wholly.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  let loadedFile: LoadedFile | null = null;
  return {
    load: () => {
      loadedFile = loadFileInUse(projectDir);
      return mergeDefaults(loadedFile.raw);
    },
    save: (config) => {
      // Before load there is no resolved file; ConfigStore always loads in its
      // constructor, so this only guards direct callers. Global is the fallback.
      writeJsonAtomic(loadedFile?.path ?? CONFIG_PATH, config);
    },
  };
}

/**
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to handle.
 */
export function loadConfig(): SubagentsConfig {
  return mergeDefaults(readGlobalRaw());
}

export function saveConfigAtomic(config: SubagentsConfig): void {
  writeJsonAtomic(CONFIG_PATH, config);
}

// ── Load ─────────────────────────────────────────────────────────────

/**
 * Pick the file in use: the project file when a valid one exists, else the
 * global file. A malformed project file is ignored with a warning.
 */
function loadFileInUse(projectDir?: string): LoadedFile {
  if (projectDir) {
    const projectPath = path.join(projectDir, CONFIG_FILE_NAME);
    const raw = readProjectRaw(projectPath);
    if (raw) return { raw, path: projectPath };
  }
  return { raw: readGlobalRaw(), path: CONFIG_PATH };
}

/** Read the global file; any failure (missing, malformed) reads as {} — as today. */
function readGlobalRaw(): SubagentsConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as SubagentsConfig;
  } catch {
    return {} as SubagentsConfig;
  }
}

/** Read the project file; missing = absent, unreadable/malformed = absent + warning. */
function readProjectRaw(projectPath: string): SubagentsConfig | null {
  if (!fs.existsSync(projectPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(projectPath, "utf-8")) as SubagentsConfig;
  } catch (err) {
    console.warn(`[subagents] Ignoring malformed project config ${projectPath}: ${err}`);
    return null;
  }
}

/** Bake hardcoded defaults into the loaded raw config; normalize legacy keys on it. */
function mergeDefaults(raw: SubagentsConfig): SubagentsConfig {
  // Spread form (not an explicit default key) so the loaded value wins
  // without triggering TS2783; identical runtime semantics.
  const concurrency: SubagentsConfig["concurrency"] = {
    ...DEFAULT_CONCURRENCY,
    ...(raw.concurrency ?? {}),
  };
  const agent = { ...DEFAULT_AGENT, ...raw.agent };
  // Legacy pre-ADR-0006 key: normalize without error, touching no other keys (US-15).
  delete agent.finishedEvictTurns;
  return {
    agent,
    concurrency,
  };
}

// ── Save ─────────────────────────────────────────────────────────────

/** Write JSON atomically: tmp file in the same directory, then rename. */
function writeJsonAtomic(filePath: string, config: unknown): void {
  const tmpPath = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[subagents] Failed to save config: ${err}`);
  }
}
