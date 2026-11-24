/**
 * config-io.ts — Config persistence (read/write) with override layers.
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Two layers (ADR-0008): the global file ~/.pi/agent/subagents-lite.json and a
 * trusted project's .pi/subagents-lite.json. The project layer may carry model
 * keys, concurrency keys, and a Workflow endpoint's URL — never its key, its
 * name, or the default endpoint (US-6). The effective config merges project over
 * global over built-in defaults. Each file stores only its own keys; the merged
 * config is never written back. What a project setting may change is decided once
 * by `projectWorkflowRule`, which drives the merge, the project layer's validation
 * and the one load-time warning that names every key left out; the layer keeps the
 * file's own Workflow keys, so an inert setting is named rather than erased.
 * A malformed project file is never overwritten, and only a reporting read speaks.
 * See docs/adr/0008-project-config-as-override-layer.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.ts";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.ts";
import {
  isPlainObject,
  projectWorkflowRule,
  validateProjectLayer,
  validateRawLayer,
  workflowEndpointTable,
} from "./config-validation.ts";
import type { WarningSink } from "./config-validation.ts";

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
/** Tools the viewer leaves ungrouped until the user edits the list; `replace` matches only a custom or MCP tool of that name. */
export const DEFAULT_UNGROUPED_TOOLS: readonly string[] = [
  "write",
  "edit",
  "replace",
  "bash",
  "codemode",
  "Agent",
  "StopAgent",
  "MessageAgent",
];

export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

/** The Workflow endpoint a user who configured nothing gets: a local anagen-x. */
export const DEFAULT_WORKFLOW_ENDPOINT = "anagen-x.local";
export const DEFAULT_WORKFLOW_ENDPOINTS: SubagentsConfig["workflows"]["endpoints"] = {
  [DEFAULT_WORKFLOW_ENDPOINT]: { url: "http://localhost:4001" },
};

/** Endpoint names the built-in layer declares, so a file may name them without declaring them itself. */
const BUILT_IN_ENDPOINT_NAMES = Object.keys(DEFAULT_WORKFLOW_ENDPOINTS);

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
  exposeDescriptions: false,
  showTools: false,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
  outputTranscript: false,
  finishedRetentionMinutes: 1,
  /** 0 = auto: the AgentStatus settled limit derives as 2 × default concurrency at read time. */
  agentStatusLimit: 0,
  modelDisplayStyle: "name",
  modelThinkingPlacement: "header",
  statusBarFormat: "full",
  showAgentColors: true,
  widgetShowBashPrograms: false,
  compactToolCalls: true,
  ungroupedTools: [...DEFAULT_UNGROUPED_TOOLS],
};

/**
 * Stored form of agentStatusLimit: an explicit value ≥ 1 passes through;
 * anything below 1 (or unset) becomes 0, the auto marker — the effective
 * limit then derives as 2 × default concurrency at read time.
 */
export function canonicalAgentStatusLimit(raw: number | undefined): number {
  return raw != null && raw >= 1 ? raw : 0;
}

/** A layer a persisted mutation can target. */
export type ConfigTarget = "session" | "global" | "project";

/** State of the project layer for the current IO instance. */
export type ProjectLayerStatus = "untrusted" | "absent" | "loaded" | "malformed";

/** Raw concurrency section as stored in a config file. */
export interface RawConcurrency {
  default?: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

/**
 * One named Workflow endpoint as stored. `url` and `apiKey` are whatever the file declared, usable or
 * not: an unusable configured target or key keeps its name so the run that selects it is refused
 * instead of being sent to another endpoint or going out unauthenticated (US-34, US-8).
 */
export interface RawWorkflowEndpoint {
  url?: unknown;
  apiKey?: unknown;
}

/**
 * Raw workflows section as stored in a config file. A project's own section keeps every key the file
 * carried, so it can carry names nothing applies - `projectWorkflowRule` decides what takes effect and
 * the load warning names the rest.
 */
export interface RawWorkflows {
  /** Global-only: decides whether the `Workflow` tool is registered. A project layer cannot set it. */
  enabled?: unknown;
  endpoints?: Record<string, RawWorkflowEndpoint>;
  defaultEndpoint?: unknown;
}

/** Raw config file contents: only the keys that file carries. */
export interface RawConfig {
  agent?: Record<string, unknown>;
  concurrency?: RawConcurrency;
  workflows?: RawWorkflows;
}

/** Result of a load: the two raw layers plus the project layer's status. */
export interface LoadedConfig {
  global: RawConfig;
  project: RawConfig | null;
  projectStatus: ProjectLayerStatus;
}

/** Persistence port consumed by ConfigStore. */
export interface ConfigIO {
  load(options?: ConfigLoadOptions): LoadedConfig;
  saveGlobal(config: RawConfig): void;
  saveProject(config: RawConfig): void;
}

/**
 * How a read treats what it found. Every read reports what it warns about except the one that builds the
 * shell's store at extension load, which session_start reads again - so a config file's diagnostics are
 * printed once per Pi start rather than twice.
 */
export interface ConfigLoadOptions {
  report?: boolean;
}

/** Agent keys a project file may set: the model family plus per-type overrides. */
export const MODEL_FAMILY_KEYS = new Set(["default", "defaultThinking", "defaultMaxTurns"]);

/** True when a project file may carry this agent key (model keys only, ADR-0008). */
export function isProjectAllowedAgentKey(key: string): boolean {
  return MODEL_FAMILY_KEYS.has(key) || !CONFIG_AGENT_NON_MODEL_KEYS.includes(key);
}

/** Appended only when a Workflow key is listed, so an agent-only warning keeps the wording it has had. */
const WORKFLOW_KEYS_ARE_GLOBAL =
  "A project may override only the url of an endpoint the global file names: an endpoint's key, " +
  "its name and the default endpoint are global settings.";

/** A read that reports: the diagnostics reach the operator. */
const logWarning: WarningSink = (message) => {
  console.warn(message);
};

/** The bootstrap read's sink: session_start loads the same layers again and reports them there. */
const silent: WarningSink = () => {};

/** A project layer's settings that the effective config cannot use, spelled as the file spells them. */
interface IgnoredProjectKeys {
  /** Agent keys by bare name, as the long-standing warning has always listed them. */
  agentKeys: string[];
  /** Dotted Workflow paths, e.g. `workflows.endpoints.release.apiKey`. */
  workflowKeys: string[];
}

/**
 * One warning naming every project key with no effect, never a value. True when it warned, which is
 * how the loader keeps it to one per load rather than one per merge that happens to drop the key. A silent
 * read neither warns nor consumes that state, so the read that reports still names the keys.
 */
function warnIgnoredProjectKeys(projectPath: string, ignored: IgnoredProjectKeys, warn: WarningSink): boolean {
  const listed = [...ignored.agentKeys, ...ignored.workflowKeys];
  if (listed.length === 0) return false;
  const explanation = ignored.workflowKeys.length > 0 ? ` ${WORKFLOW_KEYS_ARE_GLOBAL}` : "";
  warn(`[subagents] Ignoring unknown keys in project config ${projectPath}: ${listed.join(", ")}${explanation}`);
  return true;
}

/**
 * Project settings the effective config cannot use. One rule with `mergeLayers`, which applies exactly
 * the keys this leaves out: `projectWorkflowRule` is asked against the global layer's declarations and
 * reads the section as the file wrote it, so a key the layer's own cleaning does not apply is still named
 * (ADR-0008).
 */
function ignoredProjectKeys(global: RawConfig, project: RawConfig): IgnoredProjectKeys {
  const agentKeys = Object.keys(project.agent ?? {}).filter((key) => !isProjectAllowedAgentKey(key));
  return { agentKeys, workflowKeys: projectWorkflowRule(global.workflows, project.workflows).ignored };
}

/** Read + validate the project file. null = absent, "malformed" = invalid. */
type ProjectRead = RawConfig | "malformed" | null;

/**
 * Create a ConfigIO. With a trusted project's `.pi` directory the project file
 * (when present and valid) is an override layer over the global file; each
 * save touches only its own layer. A malformed project file is never written;
 * without a project dir the project layer is untrusted and unavailable.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  const projectPath = projectDir ? path.join(projectDir, CONFIG_FILE_NAME) : null;
  let projectStatus: ProjectLayerStatus = projectDir ? "absent" : "untrusted";
  let projectRaw: RawConfig | null = null;
  let ignoredKeysWarned = false;

  return {
    load: ({ report = true }: ConfigLoadOptions = {}) => {
      const warn = report ? logWarning : silent;
      const global = readGlobalRaw(warn);
      if (projectPath) {
        const read = readProjectRaw(projectPath, global.workflows, warn);
        if (read === null) {
          projectRaw = null;
          projectStatus = "absent";
        } else if (read === "malformed") {
          projectRaw = null;
          projectStatus = "malformed";
        } else {
          projectRaw = read;
          projectStatus = "loaded";
          if (
            report &&
            !ignoredKeysWarned &&
            warnIgnoredProjectKeys(projectPath, ignoredProjectKeys(global, read), warn)
          ) {
            ignoredKeysWarned = true;
          }
        }
      } else {
        projectRaw = null;
        projectStatus = "untrusted";
      }
      return { global, project: projectRaw, projectStatus };
    },
    saveGlobal: (config) => {
      writeJsonAtomic(CONFIG_PATH, config);
    },
    saveProject: (config) => {
      if (!projectPath || projectStatus === "malformed" || projectStatus === "untrusted") {
        console.warn(`[subagents] Refusing to write project config (${projectStatus}); change not saved`);
        return;
      }
      writeJsonAtomic(projectPath, config);
    },
  };
}

/**
 * Read config from disk (global file only). Merges loaded values over
 * defaults so the result is always a complete SubagentsConfig. Used outside
 * the store (events.ts); the store loads both layers via ConfigIO.
 */
export function loadConfig(): SubagentsConfig {
  return mergeDefaults(readGlobalRaw(logWarning));
}

/**
 * Merge the two raw layers into one raw config: project keys win, absent keys
 * inherit from global. Project keys the layer cannot set are dropped here and
 * named once by the load warning (`ignoredProjectKeys`). Concurrency merges per
 * entry: default wins, providers/models combine. Workflows merge per endpoint and
 * only the URL may be overridden. Pure — no I/O, and no warning of its own: the
 * store merges again after every mutation, and only a load may report.
 */
export function mergeLayers(global: RawConfig, project: RawConfig | null): RawConfig {
  const agent = { ...global.agent };
  if (project?.agent) {
    for (const [key, value] of Object.entries(project.agent)) {
      if (isProjectAllowedAgentKey(key)) agent[key] = value;
    }
  }
  const merged: RawConfig = {
    agent,
    concurrency: mergeRawConcurrency(global.concurrency, project?.concurrency),
  };
  if (global.workflows || project?.workflows)
    merged.workflows = mergeRawWorkflows(global.workflows, project?.workflows);
  return merged;
}

/**
 * Merge the workflow layers. A trusted project may override only the URL of an endpoint the global
 * file names: endpoint names, keys and the default stay global (US-6, ADR-0008 as amended). A declared
 * URL wins even when unusable, so a broken project target is refused rather than silently replaced by
 * the global URL (US-34); an absent URL inherits, and an unsupported key cannot erase the global value.
 * `projectWorkflowRule` drives both this merge and the load warning for settings it excludes.
 */
function mergeRawWorkflows(global: RawWorkflows | undefined, project: RawWorkflows | undefined): RawWorkflows {
  const { urls } = projectWorkflowRule(global, project);
  const overridden = urls.map(({ name, url }): [string, RawWorkflowEndpoint] => [
    name,
    { ...global?.endpoints?.[name], url },
  ]);
  const merged: RawWorkflows = {
    endpoints: workflowEndpointTable([...Object.entries(global?.endpoints ?? {}), ...overridden]),
  };
  if (global?.enabled !== undefined) merged.enabled = global.enabled;
  if (global?.defaultEndpoint !== undefined) merged.defaultEndpoint = global.defaultEndpoint;
  return merged;
}

/**
 * Merge raw concurrency layers, highest priority last. Never emits an explicit
 * undefined default: an explicit `default: undefined` would override the baked
 * default in mergeDefaults' spread.
 */
function mergeRawConcurrency(...layers: Array<RawConcurrency | undefined>): RawConcurrency {
  const out: RawConcurrency = {};
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.default !== undefined) out.default = layer.default;
    Object.assign(providers, layer.providers ?? {});
    Object.assign(models, layer.models ?? {});
  }
  if (Object.keys(providers).length > 0) out.providers = providers;
  if (Object.keys(models).length > 0) out.models = models;
  return out;
}

/** Bake hardcoded defaults into a raw config; normalize legacy keys on it. */
export function mergeDefaults(raw: RawConfig): SubagentsConfig {
  // Spread form (not an explicit default key) so the loaded value wins
  // without triggering TS2783; identical runtime semantics. Values come from
  // JSON, so the casts are honest at this boundary.
  const concurrency = {
    ...DEFAULT_CONCURRENCY,
    ...raw.concurrency,
  } as SubagentsConfig["concurrency"];
  const agent = { ...DEFAULT_AGENT, ...raw.agent } as SubagentsConfig["agent"];
  // Legacy pre-ADR-0006 key: normalize without error, touching no other keys (US-15).
  delete agent.finishedEvictTurns;
  return {
    agent,
    concurrency,
    workflows: {
      // A flip that needs a restart is read straight from the merged layer: nothing normalises it here,
      // because validation already refused a non-boolean in the only layer allowed to carry it.
      enabled: raw.workflows?.enabled === true,
      // A name the files configured keeps its own entry, usable or not: the built-ins are only for
      // a name nobody configured (US-34).
      endpoints: workflowEndpointTable([
        ...Object.entries(DEFAULT_WORKFLOW_ENDPOINTS),
        ...Object.entries(raw.workflows?.endpoints ?? {}),
      ]),
      defaultEndpoint:
        raw.workflows?.defaultEndpoint === undefined ? DEFAULT_WORKFLOW_ENDPOINT : raw.workflows.defaultEndpoint,
    },
  };
}

// ── Load ─────────────────────────────────────────────────────────────

/** Read the global file; any failure (missing, malformed) reads as {} — as today. */
function readGlobalRaw(warn: WarningSink): RawConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
  // Per-value validation: drop bad values with a warning, keep valid keys.
  return validateRawLayer(parsed, CONFIG_PATH, warn, BUILT_IN_ENDPOINT_NAMES);
}

/**
 * Read the project file; missing = absent, unreadable/invalid = malformed + warning. The global layer's
 * declarations come along because they are what decides which of this file's Workflow settings can take
 * effect (`projectWorkflowRule`), and the cleaned layer keeps the file's own Workflow keys so the load
 * warning and this validation answer from that one decision. File bytes stay untouched.
 */
function readProjectRaw(
  projectPath: string,
  globalWorkflows: RawWorkflows | undefined,
  warn: WarningSink,
): ProjectRead {
  if (!fs.existsSync(projectPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
  } catch (err) {
    warn(`[subagents] Ignoring malformed project config ${projectPath}: ${String(err)}`);
    return "malformed";
  }
  if (!isPlainObject(parsed)) {
    warn(`[subagents] Ignoring malformed project config ${projectPath}: not a JSON object`);
    return "malformed";
  }
  const raw = parsed as RawConfig;
  if (raw.agent !== undefined && !isPlainObject(raw.agent)) return malformedSection(projectPath, "agent", warn);
  if (raw.concurrency !== undefined && !isPlainObject(raw.concurrency)) {
    return malformedSection(projectPath, "concurrency", warn);
  }
  if (raw.concurrency?.providers !== undefined && !isPlainObject(raw.concurrency.providers)) {
    return malformedSection(projectPath, "concurrency.providers", warn);
  }
  if (raw.concurrency?.models !== undefined && !isPlainObject(raw.concurrency.models)) {
    return malformedSection(projectPath, "concurrency.models", warn);
  }
  if (raw.workflows !== undefined && !isPlainObject(raw.workflows)) {
    return malformedSection(projectPath, "workflows", warn);
  }
  if (raw.workflows?.endpoints !== undefined && !isPlainObject(raw.workflows.endpoints)) {
    return malformedSection(projectPath, "workflows.endpoints", warn);
  }
  return validateProjectLayer(raw, projectPath, globalWorkflows, warn);
}

function malformedSection(projectPath: string, section: string, warn: WarningSink): "malformed" {
  warn(`[subagents] Ignoring malformed project config ${projectPath}: "${section}" is not a JSON object`);
  return "malformed";
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
    console.error(`[subagents] Failed to save config: ${String(err)}`);
  }
}
