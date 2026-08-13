/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Project-level config: when created with a project's `.pi` directory,
 * `.pi/subagents-lite.json` merges over the global file per field (project
 * wins, global fills, hardcoded defaults fill). Saves with a project file
 * present write only the project-origin diff back to it, so the project file
 * keeps overriding only what it sets; the global file is hand-edited.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.js";

const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lite.json");
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

/** Raw file contents captured at load; the save path diffs against these. */
interface LoadedFiles {
  globalRaw: SubagentsConfig;
  /** null when the project file is absent or malformed (then saves go global). */
  projectRaw: SubagentsConfig | null;
  projectPath: string | null;
}

/**
 * Create a ConfigIO. With a project's `.pi` directory, the project's
 * `subagents-lite.json` merges over the global file on load, and saves with a
 * project file present write the project-origin diff to it (never the global
 * file). Without one, behaves exactly like the global-only functions.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  let files: LoadedFiles | null = null;
  return {
    load: () => {
      files = loadFiles(projectDir);
      return mergeDefaults(mergeRawFiles(files.globalRaw, files.projectRaw));
    },
    save: (config) => {
      if (files?.projectPath && files.projectRaw) {
        writeJsonAtomic(files.projectPath, diffProjectContent(config, files.globalRaw, files.projectRaw));
      } else {
        saveConfigAtomic(config);
      }
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

function loadFiles(projectDir?: string): LoadedFiles {
  const globalRaw = readGlobalRaw();
  if (!projectDir) return { globalRaw, projectRaw: null, projectPath: null };
  const projectPath = path.join(projectDir, "subagents-lite.json");
  const projectRaw = readProjectRaw(projectPath);
  return { globalRaw, projectRaw, projectPath: projectRaw ? projectPath : null };
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

/**
 * Merge the project agent object over the global one. A null project value
 * means the key is removed (overrides the global entry with nothing) — except
 * `default`, where null means "inherit parent" and stays a real value.
 */
function mergeAgent(global: SubagentsConfig["agent"], project: SubagentsConfig["agent"]): SubagentsConfig["agent"] {
  const merged = { ...global };
  for (const [key, value] of Object.entries(project ?? {})) {
    if (value === null && key !== "default") delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Merge a numeric map over the global one. A null project entry means the
 * entry is removed, overriding the global entry with nothing.
 */
function mergeMap(
  global: Record<string, number> | undefined,
  project: Record<string, number | null> | undefined,
): Record<string, number> {
  const merged = { ...(global ?? {}) };
  for (const [key, value] of Object.entries(project ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Per-field merge of the two raw files: project wins, global fills the rest. */
function mergeRawFiles(globalRaw: SubagentsConfig, projectRaw: SubagentsConfig | null): SubagentsConfig {
  if (!projectRaw) return globalRaw;
  return {
    agent: mergeAgent(globalRaw.agent, projectRaw.agent),
    concurrency: {
      default: projectRaw.concurrency?.default ?? globalRaw.concurrency?.default ?? DEFAULT_CONCURRENCY.default,
      providers: mergeMap(globalRaw.concurrency?.providers, projectRaw.concurrency?.providers),
      models: mergeMap(globalRaw.concurrency?.models, projectRaw.concurrency?.models),
    },
  };
}

/** Bake hardcoded defaults into the merged result; normalize legacy keys on it. */
function mergeDefaults(raw: SubagentsConfig): SubagentsConfig {
  const concurrency = {
    // @ts-expect-error TS2783: spread may override 'default', which is intentional (loaded value wins)
    default: DEFAULT_CONCURRENCY.default,
    ...(raw.concurrency ?? {}),
  } as SubagentsConfig["concurrency"];
  const agent = { ...DEFAULT_AGENT, ...raw.agent };
  // Legacy pre-ADR-0006 key: normalize without error, touching no other keys (US-15).
  delete agent.finishedEvictTurns;
  return {
    agent,
    concurrency,
  };
}

// ── Save ─────────────────────────────────────────────────────────────

/**
 * Compute the project-file content that reproduces the merged config when
 * merged over the global file: keys the project file already sets (updated to
 * the merged value) plus keys whose merged value differs from the global file.
 * A key deleted from the merged config that the global file defines is written
 * as a null tombstone (null project entries mean "removed" at load), so
 * removals outlive the reload. Defaults and global-only keys are never copied,
 * so the project file stays a small hand-editable diff.
 */
function diffProjectContent(
  merged: SubagentsConfig,
  globalRaw: SubagentsConfig,
  projectRaw: SubagentsConfig,
): Record<string, unknown> {
  const mergedGlobal = mergeDefaults(globalRaw);
  const content: Record<string, unknown> = {};
  const agent = diffAgent(merged.agent, projectRaw.agent ?? {}, mergedGlobal.agent);
  if (Object.keys(agent).length > 0) content.agent = agent;
  const concurrency = diffConcurrency(merged.concurrency, projectRaw.concurrency ?? {}, mergedGlobal.concurrency);
  if (Object.keys(concurrency).length > 0) content.concurrency = concurrency;
  return content;
}

function diffAgent(
  merged: SubagentsConfig["agent"],
  project: SubagentsConfig["agent"],
  global: SubagentsConfig["agent"],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(project), ...Object.keys(merged), ...Object.keys(global)])) {
    const value = merged[key];
    if (value === undefined) {
      // Deleted from the merged config: tombstone keys the global file defines
      // so the removal outlives the reload; drop keys only the project had.
      if (global[key] !== undefined) result[key] = null;
      continue;
    }
    if (value !== global[key]) result[key] = value;
  }
  return result;
}

function diffConcurrency(
  merged: SubagentsConfig["concurrency"],
  project: Partial<SubagentsConfig["concurrency"]>,
  global: SubagentsConfig["concurrency"],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (merged.default !== global.default) result.default = merged.default;
  const providers = diffMap(merged.providers, project.providers, global.providers);
  if (Object.keys(providers).length > 0) result.providers = providers;
  const models = diffMap(merged.models, project.models, global.models);
  if (Object.keys(models).length > 0) result.models = models;
  return result;
}

/** Per-key diff for a nested string→number map (concurrency providers/models). */
function diffMap(
  merged: Record<string, number> | undefined,
  project: Record<string, number> | undefined,
  global: Record<string, number> | undefined,
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const key of new Set([
    ...Object.keys(project ?? {}),
    ...Object.keys(merged ?? {}),
    ...Object.keys(global ?? {}),
  ])) {
    const value = merged?.[key];
    if (value === undefined) {
      // Deleted from the merged config: tombstone entries the global file
      // defines so the removal outlives the reload; drop entries only the
      // project had.
      if (global?.[key] !== undefined) result[key] = null;
      continue;
    }
    if (value !== global?.[key]) result[key] = value;
  }
  return result;
}

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
