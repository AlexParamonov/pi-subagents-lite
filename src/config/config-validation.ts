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
export function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

/** One loud warning naming file, key, got, expected, and the fix path. */
export function formatIncompatibleWarning(filePath: string, keyPath: string, value: unknown, expected: string): string {
  return (
    `[subagents] Incompatible value in ${filePath}: "${keyPath}" is ${describeValue(value)}, ` +
    `expected ${expected}. Set it again in the /agents menu, or edit or delete the file to fix it.`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one raw file layer, dropping invalid values from the result.
 * Pure except for one console.warn per dropped value. Never throws on
 * bad input: unknown shapes fall back to empty sections.
 */
export function validateRawLayer(raw: unknown, filePath: string): RawConfig {
  const cleaned: RawConfig = {};
  if (!isPlainObject(raw)) {
    console.warn(formatIncompatibleWarning(filePath, "(config)", raw, "object"));
    return cleaned;
  }

  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      console.warn(formatIncompatibleWarning(filePath, "agent", raw.agent, "object"));
    } else {
      const agent: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw.agent)) {
        if (SILENTLY_DROPPED_KEYS.has(key)) continue;
        if (value === undefined) continue;
        const spec = AGENT_KEY_SPECS[key] ?? MODEL_KEY;
        let ok = false;
        try {
          ok = Value.Check(spec.schema, value);
        } catch {
          ok = false;
        }
        if (ok) agent[key] = value;
        else console.warn(formatIncompatibleWarning(filePath, `agent.${key}`, value, spec.expected));
      }
      if (Object.keys(agent).length > 0) cleaned.agent = agent;
      else if (raw.agent && Object.keys(raw.agent).length === 0) cleaned.agent = {};
    }
  }

  if (raw.concurrency !== undefined) {
    if (!isPlainObject(raw.concurrency)) {
      console.warn(formatIncompatibleWarning(filePath, "concurrency", raw.concurrency, "object"));
    } else {
      const concurrency: NonNullable<RawConfig["concurrency"]> = {};
      const src = raw.concurrency;
      if (src.default !== undefined) {
        if (typeof src.default === "number") concurrency.default = src.default;
        else console.warn(formatIncompatibleWarning(filePath, "concurrency.default", src.default, "number"));
      }
      for (const section of ["providers", "models"] as const) {
        const entries = src[section];
        if (entries === undefined) continue;
        if (!isPlainObject(entries)) {
          console.warn(formatIncompatibleWarning(filePath, `concurrency.${section}`, entries, "object"));
          continue;
        }
        const kept: Record<string, number> = {};
        for (const [key, value] of Object.entries(entries)) {
          if (typeof value === "number") kept[key] = value;
          else console.warn(formatIncompatibleWarning(filePath, `concurrency.${section}.${key}`, value, "number"));
        }
        if (Object.keys(kept).length > 0) concurrency[section] = kept;
      }
      if (Object.keys(concurrency).length > 0) cleaned.concurrency = concurrency;
    }
  }

  return cleaned;
}
