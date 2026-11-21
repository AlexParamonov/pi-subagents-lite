/**
 * config-validation.ts — Load-time validation for config files.
 *
 * One runtime schema per known key (single source of truth for rules and
 * warning text). Each invalid value is dropped from the effective config so
 * built-in defaults apply, valid keys are kept, file bytes are untouched, and
 * one loud warning per bad value names the file, key, got, expected,
 * and fix hint. A Workflow endpoint target and credential are the exception: an unusable URL or
 * `apiKey` is kept so every run naming that endpoint is refused, rather than falling back to another
 * endpoint or going out unauthenticated (US-34, US-8), and that refusal is promised only where the
 * layer's value decides the target. `projectWorkflowRule` is that decision for a project
 * file, and the layer merge and the load warning read it too. Diagnostics go to
 * a sink the caller supplies, so a read that must stay silent gets silence.
 * Never migrates fork shapes or throws.
 */
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { RawConfig, RawWorkflowEndpoint, RawWorkflows } from "./config-io.ts";
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
function warnIncompatible(reader: LayerReader, keyPath: string, value: unknown, expected: string): void {
  reader.warn(formatIncompatibleWarning(reader.filePath, keyPath, value, expected));
}

/**
 * Warning for a Workflow endpoint setting whose value is kept: the target stays configured so every
 * run naming it is refused, rather than falling back to another endpoint (US-34).
 */
function warnUnusableTarget(reader: LayerReader, keyPath: string, value: unknown, expected: string): void {
  reader.warn(
    `${formatIncompatibleWarning(reader.filePath, keyPath, value, expected)} ` +
      "It stays configured, so a run naming this endpoint is refused instead of sent to another endpoint.",
  );
}

/**
 * The same kept-and-refused warning for a credential path, without the value's own description: a
 * configured key is never echoed, not even as the shape it came in (US-35).
 */
function warnUnusableCredential(reader: LayerReader, keyPath: string): void {
  reader.warn(
    `[subagents] Unusable value in ${reader.filePath}: "${keyPath}" must hold a text API key. ` +
      "It stays configured, so a run naming this endpoint is refused instead of sent without a credential.",
  );
}

/**
 * Where a read's diagnostics go. A read that reports prints them; the bootstrap read hands in a sink that
 * hears nothing, so one config file is spoken about by exactly one load per startup.
 */
export type WarningSink = (message: string) => void;

/** The sink a read uses when its caller did not say otherwise: print. */
function printWarning(message: string): void {
  console.warn(message);
}

/** One file a read is validating, and where its diagnostics go. */
interface LayerReader {
  filePath: string;
  warn: WarningSink;
}

/**
 * What a project's `workflows` section is allowed to change, decided against the global layer's
 * declarations: only the `url` of an endpoint the global file names (US-6, ADR-0008).
 */
export interface ProjectWorkflowRule {
  /** The endpoint urls this layer decides - what the effective merge applies. */
  urls: Array<{ name: string; url: unknown }>;
  /** A name this layer may set whose entry is not an object: nothing is declared, so the global entry inherits. */
  malformedEntries: Array<{ name: string; value: unknown }>;
  /** Every other setting the section carries, as the file spells it: no effect, named by the load warning. */
  ignored: string[];
}

/**
 * Decide a project's Workflow settings against what the global file declares. One walk of the section as
 * the file wrote it, and the one answer three consumers read: the merge applies `urls`, this file's
 * validation warns only at the paths the layer owns, and the load names `ignored`. Membership uses own
 * keys: inherited names such as `constructor` do not count unless the global file declares them itself.
 */
export function projectWorkflowRule(global: RawWorkflows | undefined, project: unknown): ProjectWorkflowRule {
  const rule: ProjectWorkflowRule = { urls: [], malformedEntries: [], ignored: [] };
  if (!isPlainObject(project)) return rule;
  for (const [key, value] of Object.entries(project)) {
    if (key === "endpoints") collectProjectEndpoints(rule, global?.endpoints, value);
    else rule.ignored.push(`workflows.${key}`);
  }
  return rule;
}

function collectProjectEndpoints(
  rule: ProjectWorkflowRule,
  declared: Record<string, RawWorkflowEndpoint> | undefined,
  endpoints: unknown,
): void {
  if (!isPlainObject(endpoints)) return;
  for (const [name, entry] of Object.entries(endpoints)) {
    const keyPath = `workflows.endpoints.${name}`;
    if (!declared || !Object.hasOwn(declared, name)) {
      // The entry is inert as a whole, so its own keys are not listed a second time.
      rule.ignored.push(keyPath);
      continue;
    }
    if (!isPlainObject(entry)) {
      rule.malformedEntries.push({ name, value: entry });
      continue;
    }
    for (const [field, value] of Object.entries(entry)) {
      if (field === "url") rule.urls.push({ name, url: value });
      else rule.ignored.push(`${keyPath}.${field}`);
    }
  }
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
 * Validate one global file layer, dropping invalid values from the result. The global file owns its whole
 * `workflows` section, so every value there is one a run can be refused against (US-34). `declaredBelow`
 * names the endpoints a lower layer already declares (the built-in table), which this file's default may
 * name without warning. Pure except for the diagnostics it hands to `warn`. Never throws on bad input:
 * unknown shapes fall back to empty sections.
 */
export function validateRawLayer(
  raw: unknown,
  filePath: string,
  warn: WarningSink = printWarning,
  declaredBelow: readonly string[] = [],
): RawConfig {
  const reader: LayerReader = { filePath, warn };
  return validateSections(raw, reader, (workflows) => cleanGlobalWorkflows(workflows, reader, declaredBelow));
}

/**
 * Validate one trusted project's override layer against the global layer's declarations. Only the `url` of
 * an endpoint the global file names can take effect, so that is the only Workflow value this file's
 * warnings speak of; everything else the section carries keeps its bytes in the layer and is named by the
 * load warning (`projectWorkflowRule`, ADR-0008).
 */
export function validateProjectLayer(
  raw: unknown,
  filePath: string,
  global: RawWorkflows | undefined,
  warn: WarningSink = printWarning,
): RawConfig {
  const reader: LayerReader = { filePath, warn };
  return validateSections(raw, reader, (workflows) =>
    cleanProjectWorkflows(workflows, projectWorkflowRule(global, workflows), reader),
  );
}

/** One layer's `workflows` section, cleaned the way the layer that wrote it can be cleaned. */
type WorkflowCleaner = (workflows: unknown) => RawWorkflows;

function validateSections(raw: unknown, reader: LayerReader, cleanWorkflows: WorkflowCleaner): RawConfig {
  const cleaned: RawConfig = {};
  if (!isPlainObject(raw)) {
    warnIncompatible(reader, "(config)", raw, EXPECTED_OBJECT);
    return cleaned;
  }

  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      warnIncompatible(reader, "agent", raw.agent, EXPECTED_OBJECT);
    } else {
      const agent = cleanAgentEntries(raw.agent, reader);
      if (Object.keys(agent).length > 0) cleaned.agent = agent;
    }
  }

  if (raw.concurrency !== undefined) {
    const concurrency = cleanConcurrencySection(raw.concurrency, reader);
    if (Object.keys(concurrency).length > 0) cleaned.concurrency = concurrency;
  }

  if (raw.workflows !== undefined) {
    const workflows = cleanWorkflows(raw.workflows);
    if (Object.keys(workflows).length > 0) cleaned.workflows = workflows;
  }

  return cleaned;
}

/**
 * Keep valid agent entries, warn and drop the rest. Unknown keys are
 * per-type model keys; legacy keys in SILENTLY_DROPPED_KEYS vanish quietly.
 */
function cleanAgentEntries(agent: Record<string, unknown>, reader: LayerReader): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent)) {
    if (SILENTLY_DROPPED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const spec = AGENT_KEY_SPECS[key] ?? MODEL_KEY;
    if (isValidValue(spec, value)) kept[key] = value;
    else warnIncompatible(reader, `agent.${key}`, value, spec.expected);
  }
  return kept;
}

/**
 * The global file's workflow settings: an endpoint entry keeps its name whatever its URL holds, and so does
 * an unusable default name, because dropping either would let another target answer for a configuration
 * that named one (US-34). Here - and only here - the value is what a run is refused against, so here the
 * warning says so.
 */
function cleanGlobalWorkflows(workflows: unknown, reader: LayerReader, declaredBelow: readonly string[]): RawWorkflows {
  const kept: RawWorkflows = {};
  if (!isPlainObject(workflows)) {
    warnIncompatible(reader, "workflows", workflows, EXPECTED_OBJECT);
    return kept;
  }
  const endpoints = cleanGlobalWorkflowEndpoints(workflows.endpoints, reader);
  if (endpoints) kept.endpoints = endpoints;
  const name = workflows.defaultEndpoint;
  if (name !== undefined) {
    if (typeof name !== "string" || name === "") {
      warnUnusableTarget(reader, "workflows.defaultEndpoint", name, "non-empty endpoint name");
    } else if (!canAnswerForADefault(name, endpoints, declaredBelow)) {
      warnUnusableTarget(reader, "workflows.defaultEndpoint", name, "an endpoint this file declares");
    }
    kept.defaultEndpoint = name;
  }
  return kept;
}

/**
 * Whether this name can answer for a run: one this file declares, or one a lower layer declares and
 * nothing here replaces.
 */
function canAnswerForADefault(
  name: string,
  endpoints: Record<string, RawWorkflowEndpoint> | undefined,
  declaredBelow: readonly string[],
): boolean {
  return (endpoints != null && Object.hasOwn(endpoints, name)) || declaredBelow.includes(name);
}

/**
 * The project's section as the file wrote it: `projectWorkflowRule` decides what takes effect, so an inert
 * setting stays in the layer (a later save writes the layer back) and is named by the load warning. Only a
 * value at a path this layer owns is warned about here: a url it declares is the target a run is refused
 * against, an entry that is not an object declares nothing and inherits.
 */
function cleanProjectWorkflows(workflows: unknown, rule: ProjectWorkflowRule, reader: LayerReader): RawWorkflows {
  if (!isPlainObject(workflows)) {
    warnIncompatible(reader, "workflows", workflows, EXPECTED_OBJECT);
    return {};
  }
  for (const { name, url } of rule.urls) {
    if (typeof url !== "string" || url === "") {
      warnUnusableTarget(reader, `workflows.endpoints.${name}.url`, url, "non-empty URL string");
    }
  }
  for (const { name, value } of rule.malformedEntries) {
    warnIncompatible(reader, `workflows.endpoints.${name}`, value, EXPECTED_OBJECT);
  }
  const kept = { ...workflows };
  if (kept.endpoints !== undefined && !isPlainObject(kept.endpoints)) delete kept.endpoints;
  return kept as RawWorkflows;
}

function cleanGlobalWorkflowEndpoints(
  endpoints: unknown,
  reader: LayerReader,
): Record<string, RawWorkflowEndpoint> | undefined {
  if (endpoints === undefined) return undefined;
  if (!isPlainObject(endpoints)) {
    warnIncompatible(reader, "workflows.endpoints", endpoints, EXPECTED_OBJECT);
    return undefined;
  }
  const kept: Array<[string, RawWorkflowEndpoint]> = [];
  for (const [name, entry] of Object.entries(endpoints)) {
    const keyPath = `workflows.endpoints.${name}`;
    if (!isPlainObject(entry)) {
      warnUnusableTarget(reader, keyPath, entry, EXPECTED_OBJECT);
      kept.push([name, {}]);
      continue;
    }
    const endpoint: RawWorkflowEndpoint = {};
    if ("url" in entry) endpoint.url = entry.url;
    if (typeof entry.url !== "string" || entry.url === "") {
      warnUnusableTarget(reader, `${keyPath}.url`, entry.url, "non-empty URL string");
    }
    if ("apiKey" in entry) {
      // A declared key is a configured credential: keeping it is what makes the run refused instead
      // of sent without one, and only resolution decides usability (US-8).
      endpoint.apiKey = entry.apiKey;
      if (typeof entry.apiKey !== "string" || entry.apiKey === "") warnUnusableCredential(reader, `${keyPath}.apiKey`);
    }
    kept.push([name, endpoint]);
  }
  return kept.length > 0 ? workflowEndpointTable(kept) : undefined;
}

/**
 * Keep valid concurrency entries, warn and drop the rest. Plain typeof
 * checks: every value here is a bare number, so TypeBox adds nothing.
 */
function cleanConcurrencySection(concurrency: unknown, reader: LayerReader): NonNullable<RawConfig["concurrency"]> {
  const kept: NonNullable<RawConfig["concurrency"]> = {};
  if (!isPlainObject(concurrency)) {
    warnIncompatible(reader, "concurrency", concurrency, EXPECTED_OBJECT);
    return kept;
  }
  if (concurrency.default !== undefined) {
    if (typeof concurrency.default === "number") kept.default = concurrency.default;
    else warnIncompatible(reader, "concurrency.default", concurrency.default, NUM.expected);
  }
  for (const section of ["providers", "models"] as const) {
    const entries = concurrency[section];
    if (entries === undefined) continue;
    if (!isPlainObject(entries)) {
      warnIncompatible(reader, `concurrency.${section}`, entries, EXPECTED_OBJECT);
      continue;
    }
    const keptEntries: Record<string, number> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "number") keptEntries[key] = value;
      else warnIncompatible(reader, `concurrency.${section}.${key}`, value, NUM.expected);
    }
    if (Object.keys(keptEntries).length > 0) kept[section] = keptEntries;
  }
  return kept;
}
