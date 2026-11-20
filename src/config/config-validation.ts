/**
 * config-validation.ts — Load-time validation for config files.
 *
 * One runtime schema per known key (single source of truth for rules and
 * warning text). Each invalid value is dropped from the effective config so
 * built-in defaults apply, valid keys are kept, file bytes are untouched, and
 * one loud warning per bad value names the file, key, got, expected,
 * and fix hint. A Workflow endpoint target is the exception: an unusable URL
 * is kept so the run naming that endpoint is refused instead of being sent to
 * another endpoint (US-34), and that refusal is promised only by the layer
 * whose value decides the target. Never migrates fork shapes or throws.
 */
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { RawConfig, RawWorkflowEndpoint } from "./config-io.ts";
import { PARENT_THINKING_CHOICE } from "../models/thinking-resolution.ts";

/** One known key's runtime rule plus its human-readable expected shape. */
interface KeySpec {
  schema: TSchema;
  expected: string;
}

const MODEL_KEY: KeySpec = { schema: Type.Union([Type.String(), Type.Null()]), expected: "string or null" };
const BOOL: KeySpec = { schema: Type.Boolean(), expected: "boolean" };
const NUM: KeySpec = { schema: Type.Number(), expected: "number" };
const SYSTEM_PROMPT_MODE: KeySpec = {
  schema: Type.Union([Type.Literal("replace"), Type.Literal("inherit"), Type.Literal("custom")]),
  expected: '"replace" | "inherit" | "custom"',
};
const THINKING: KeySpec = {
  schema: Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
    Type.Literal(PARENT_THINKING_CHOICE),
  ]),
  expected:
    '"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | ' +
    `"${PARENT_THINKING_CHOICE}" (follow the parent session)`,
};
const MODEL_DISPLAY: KeySpec = {
  schema: Type.Union([Type.Literal("id"), Type.Literal("name")]),
  expected: '"id" | "name"',
};
const THINKING_PLACEMENT: KeySpec = {
  schema: Type.Union([Type.Literal("header"), Type.Literal("metadata")]),
  expected: '"header" | "metadata"',
};
const STATUS_BAR: KeySpec = {
  schema: Type.Union([Type.Literal("full"), Type.Literal("compact")]),
  expected: '"full" | "compact"',
};
const TOOL_NAMES: KeySpec = { schema: Type.Array(Type.String()), expected: "array of tool names" };

/** Runtime schema for every known agent key. Unknown keys are per-type model keys. */
const AGENT_KEY_SPECS: Record<string, KeySpec> = {
  default: MODEL_KEY,
  forceBackground: BOOL,
  graceTurns: NUM,
  toolTimeoutMinutes: NUM,
  idleTimeoutMinutes: NUM,
  showCost: BOOL,
  showTools: BOOL,
  showTurns: BOOL,
  showInput: BOOL,
  showOutput: BOOL,
  showContext: BOOL,
  showTime: BOOL,
  widgetMaxLines: NUM,
  widgetMaxLinesCompact: NUM,
  widgetCompact: BOOL,
  showCompletionCards: BOOL,
  widgetShortcut: BOOL,
  widgetShowModel: BOOL,
  widgetShowThinking: BOOL,
  widgetNavHint: BOOL,
  systemPromptMode: SYSTEM_PROMPT_MODE,
  includeContextFiles: BOOL,
  defaultThinking: THINKING,
  defaultMaxTurns: NUM,
  loadSkillsImplicitly: BOOL,
  loadExtensionsImplicitly: BOOL,
  loadToolsImplicitly: BOOL,
  disableDefaultAgents: BOOL,
  agentToolStrictMode: BOOL,
  exposeDescriptions: BOOL,
  outputThinkingBufferSize: NUM,
  finishedRetentionMinutes: NUM,
  agentStatusLimit: NUM,
  modelDisplayStyle: MODEL_DISPLAY,
  modelThinkingPlacement: THINKING_PLACEMENT,
  statusBarFormat: STATUS_BAR,
  outputTranscript: BOOL,
  showAgentColors: BOOL,
  widgetShowBashPrograms: BOOL,
  compactToolCalls: BOOL,
  ungroupedTools: TOOL_NAMES,
};

/** Legacy key normalized silently, never warned about. */
const SILENTLY_DROPPED_KEYS = new Set(["finishedEvictTurns"]);

/** Received-kind label for warnings: arrays and null get their own names. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

/** One loud warning naming file, key, got, expected, and the fix path. */
function formatIncompatibleWarning(filePath: string, keyPath: string, value: unknown, expected: string): string {
  return (
    `[subagents] Incompatible value in ${filePath}: "${keyPath}" is ${describeValue(value)}, ` +
    `expected ${expected}. Set it again in the /agents menu, or edit or delete the file to fix it.`
  );
}

/** Emit one loud warning for a dropped value. Pure formatting stays in formatIncompatibleWarning. */
function warnIncompatible(filePath: string, keyPath: string, value: unknown, expected: string): void {
  console.warn(formatIncompatibleWarning(filePath, keyPath, value, expected));
}

/**
 * Warning for a Workflow endpoint setting whose value is kept: the target stays configured so every
 * run naming it is refused, rather than falling back to another endpoint (US-34).
 */
function warnUnusableTarget(filePath: string, keyPath: string, value: unknown, expected: string): void {
  console.warn(
    `${formatIncompatibleWarning(filePath, keyPath, value, expected)} ` +
      "It stays configured, so a run naming this endpoint is refused instead of sent to another endpoint.",
  );
}

/**
 * Which file a layer came from. Only the global layer configures an endpoint or its default; a project
 * layer overrides one endpoint's URL and nothing else, so the same bad value means something different
 * in each (ADR-0008).
 */
export type ConfigLayer = "global" | "project";

/**
 * Warn about a Workflow value this layer cannot turn into a usable target. A global value is what a run
 * is refused against; a project value the layer cannot set is ignored, so only the global warning may
 * promise a refusal (ADR-0008).
 */
function warnUnusableForLayer(filePath: string, keyPath: string, value: unknown, expected: string, layer: ConfigLayer) {
  if (layer === "global") warnUnusableTarget(filePath, keyPath, value, expected);
  else warnIncompatible(filePath, keyPath, value, expected);
}

/** Plain-object guard, shared with config-io for its project malformed checks. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The endpoint table as data: assignment writes through a `__proto__` setter and `in` finds
 * `Object.prototype`, so a configured endpoint name is built from entries and read with `Object.hasOwn`.
 * Shared by validation, the layer merge and anything else that keys a table by an endpoint name.
 */
export function workflowEndpointTable(
  entries: Iterable<[string, RawWorkflowEndpoint]>,
): Record<string, RawWorkflowEndpoint> {
  return Object.fromEntries(entries);
}

/** Expected-shape label for JSON-object sections. */
const EXPECTED_OBJECT = "object";

/**
 * Check a value against one known key's rule. Never throws: TypeBox is an
 * external call at a file-load boundary, so a missed check warns and drops
 * instead of crashing the load.
 */
function isValidValue(spec: KeySpec, value: unknown): boolean {
  try {
    return Check(spec.schema, value);
  } catch {
    return false;
  }
}

/**
 * Validate one global file layer, dropping invalid values from the result.
 * Pure except for one console.warn per dropped value. Never throws on
 * bad input: unknown shapes fall back to empty sections.
 */
export function validateRawLayer(raw: unknown, filePath: string): RawConfig {
  return validateLayer(raw, filePath, "global");
}

/**
 * Validate one trusted project's override layer. Model, concurrency and an endpoint's URL are its own;
 * a Workflow value it cannot set is dropped or ignored, and no warning promises a refusal it cannot
 * cause (ADR-0008).
 */
export function validateProjectLayer(raw: unknown, filePath: string): RawConfig {
  return validateLayer(raw, filePath, "project");
}

function validateLayer(raw: unknown, filePath: string, layer: ConfigLayer): RawConfig {
  const cleaned: RawConfig = {};
  if (!isPlainObject(raw)) {
    warnIncompatible(filePath, "(config)", raw, EXPECTED_OBJECT);
    return cleaned;
  }

  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      warnIncompatible(filePath, "agent", raw.agent, EXPECTED_OBJECT);
    } else {
      const agent = cleanAgentEntries(raw.agent, filePath);
      if (Object.keys(agent).length > 0) cleaned.agent = agent;
    }
  }

  if (raw.concurrency !== undefined) {
    const concurrency = cleanConcurrencySection(raw.concurrency, filePath);
    if (Object.keys(concurrency).length > 0) cleaned.concurrency = concurrency;
  }

  if (raw.workflows !== undefined) {
    const workflows = cleanWorkflowsSection(raw.workflows, filePath, layer);
    if (Object.keys(workflows).length > 0) cleaned.workflows = workflows;
  }

  return cleaned;
}

/**
 * Keep valid agent entries, warn and drop the rest. Unknown keys are
 * per-type model keys; legacy keys in SILENTLY_DROPPED_KEYS vanish quietly.
 */
function cleanAgentEntries(agent: Record<string, unknown>, filePath: string): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent)) {
    if (SILENTLY_DROPPED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const spec = AGENT_KEY_SPECS[key] ?? MODEL_KEY;
    if (isValidValue(spec, value)) kept[key] = value;
    else warnIncompatible(filePath, `agent.${key}`, value, spec.expected);
  }
  return kept;
}

/**
 * Keep valid workflow settings. An endpoint entry keeps its name whatever its URL holds, and so does an
 * unusable default name: dropping either would let another target answer for a configuration that named
 * one (US-34). The refusal warning is made only where the layer's value decides the run's target.
 */
function cleanWorkflowsSection(
  workflows: unknown,
  filePath: string,
  layer: ConfigLayer,
): NonNullable<RawConfig["workflows"]> {
  const kept: NonNullable<RawConfig["workflows"]> = {};
  if (!isPlainObject(workflows)) {
    warnIncompatible(filePath, "workflows", workflows, EXPECTED_OBJECT);
    return kept;
  }
  const endpoints = cleanWorkflowEndpoints(workflows.endpoints, filePath, layer);
  if (endpoints) kept.endpoints = endpoints;
  const name = workflows.defaultEndpoint;
  if (name !== undefined) {
    if (typeof name !== "string" || name === "") {
      warnUnusableForLayer(filePath, "workflows.defaultEndpoint", name, "non-empty endpoint name", layer);
    }
    kept.defaultEndpoint = name;
  }
  return kept;
}

function cleanWorkflowEndpoints(
  endpoints: unknown,
  filePath: string,
  layer: ConfigLayer,
): Record<string, RawWorkflowEndpoint> | undefined {
  if (endpoints === undefined) return undefined;
  if (!isPlainObject(endpoints)) {
    warnIncompatible(filePath, "workflows.endpoints", endpoints, EXPECTED_OBJECT);
    return undefined;
  }
  const kept: Array<[string, RawWorkflowEndpoint]> = [];
  for (const [name, entry] of Object.entries(endpoints)) {
    const keyPath = `workflows.endpoints.${name}`;
    if (!isPlainObject(entry)) {
      warnUnusableForLayer(filePath, keyPath, entry, EXPECTED_OBJECT, layer);
      kept.push([name, {}]);
      continue;
    }
    const endpoint: RawWorkflowEndpoint = {};
    if ("url" in entry) {
      endpoint.url = entry.url;
      if (typeof entry.url !== "string" || entry.url === "") {
        warnUnusableTarget(filePath, `${keyPath}.url`, entry.url, "non-empty URL string");
      }
    } else if (layer === "global") {
      warnUnusableTarget(filePath, `${keyPath}.url`, entry.url, "non-empty URL string");
    }
    if (entry.apiKey !== undefined) {
      if (typeof entry.apiKey === "string") endpoint.apiKey = entry.apiKey;
      else warnIncompatible(filePath, `${keyPath}.apiKey`, entry.apiKey, "string");
    }
    kept.push([name, endpoint]);
  }
  return kept.length > 0 ? workflowEndpointTable(kept) : undefined;
}

/**
 * Keep valid concurrency entries, warn and drop the rest. Plain typeof
 * checks: every value here is a bare number, so TypeBox adds nothing.
 */
function cleanConcurrencySection(concurrency: unknown, filePath: string): NonNullable<RawConfig["concurrency"]> {
  const kept: NonNullable<RawConfig["concurrency"]> = {};
  if (!isPlainObject(concurrency)) {
    warnIncompatible(filePath, "concurrency", concurrency, EXPECTED_OBJECT);
    return kept;
  }
  if (concurrency.default !== undefined) {
    if (typeof concurrency.default === "number") kept.default = concurrency.default;
    else warnIncompatible(filePath, "concurrency.default", concurrency.default, NUM.expected);
  }
  for (const section of ["providers", "models"] as const) {
    const entries = concurrency[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      warnIncompatible(filePath, `concurrency.${section}`, entries, EXPECTED_OBJECT);
      continue;
    }
    const keptEntries: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "number") keptEntries[key] = value;
      else warnIncompatible(filePath, `concurrency.${section}.${key}`, value, NUM.expected);
    }
    if (Object.keys(keptEntries).length > 0) kept[section] = keptEntries;
  }
  return kept;
}
