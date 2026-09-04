/**
 * config-validation.ts — Load-time validation for config files.
 *
 * One runtime schema per known key (single source of truth for rules and
 * warning text). Each invalid value is dropped from the effective config so
 * built-in defaults apply, valid keys are kept, file bytes are untouched,
 * and one loud warning per bad value names the file, key, got, expected,
 * and fix hint. Never migrates fork shapes or throws.
 */
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RawConfig } from "./config-io.js";

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
  ]),
  expected: '"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"',
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
  disableDefaultAgents: BOOL,
  agentToolStrictMode: BOOL,
  outputThinkingBufferSize: NUM,
  finishedRetentionMinutes: NUM,
  agentStatusLimit: NUM,
  modelDisplayStyle: MODEL_DISPLAY,
  modelThinkingPlacement: THINKING_PLACEMENT,
  statusBarFormat: STATUS_BAR,
  outputTranscript: BOOL,
  showAgentColors: BOOL,
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

/** Plain-object guard, shared with config-io for its project malformed checks. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return Value.Check(spec.schema, value);
  } catch {
    return false;
  }
}

/**
 * Validate one raw file layer, dropping invalid values from the result.
 * Pure except for one console.warn per dropped value. Never throws on
 * bad input: unknown shapes fall back to empty sections.
 */
export function validateRawLayer(raw: unknown, filePath: string): RawConfig {
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
