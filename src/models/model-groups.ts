/**
 * model-groups.ts — Group Agent types by Resolved model for the Model
 * settings menu.
 *
 * Pure function — no store access, no file I/O, no pi SDK imports (pi-ai's
 * clampThinkingLevel is a pure helper). The menu assembles the snapshot input
 * from ConfigStore + the extension context and maps the result to
 * SettingsList items.
 *
 * A type gets a row iff it has an explicit per-type Model override at the
 * session, project, or global layer (the anti-spam rule: frontmatter and
 * inherited models are never listed, regardless of the model they resolve
 * to). The row is grouped under the model the type actually
 * resolves to and tagged with the layer that won: [session] when the
 * session per-type override or the session default won; [project] for a
 * project per-type win with no session default; untagged for a global
 * per-type win with no session default. Groups are ordered alphabetically
 * by model id.
 *
 * Exports:
 *   - buildModelGroups: types + config snapshot → model groups with
 *     clamped thinking levels and provenance tags
 *   - hasExplicitPerTypeOverride: the anti-spam listing rule (shared with
 *     the menu's "Override another type..." list)
 */

import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { SubagentsConfig, SessionModelOverrides } from "./model-precedence.js";
import { resolveModelSource } from "./model-precedence.js";
import type { ThinkingLevel } from "../types.js";

/** Frontmatter fields the group builder reads per type. */
export interface AgentTypeModelConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelGroupsInput {
  /** All registered Agent type names (UI listing order). */
  types: readonly string[];
  /** Frontmatter config per type (undefined = no config). */
  agentConfigs: Readonly<Record<string, AgentTypeModelConfig | undefined>>;
  /** Merged config.agent (project over global): default, per-type model keys, defaultThinking. */
  config: SubagentsConfig["agent"];
  /** Session-layer Model overrides: "default" + per-type. */
  sessionOverrides: SessionModelOverrides;
  /** Whether the project layer carries the key (provenance for [project] tags). */
  hasProjectModelKey: (key: string) => boolean;
  /** Parent session model id; "(inherits parent)" when unknown. */
  parentModelId: string;
  /** pi's defaultThinkingLevel setting (project over global). */
  piDefaultThinking?: ThinkingLevel;
  /** Registry lookup for clamping; undefined model = no clamp. */
  findModel: (modelId: string) => Model<any> | undefined;
}

/** One Agent type listed under a model group. */
export interface ModelGroupRow {
  type: string;
  /** Effective thinking level, clamped to the group model's supported levels. */
  thinking: ThinkingLevel;
  /** Provenance tag of the winning layer: "[session]" (session per-type or session default), "[project]"; "" when the global per-type layer won without a session default. */
  tag: string;
}

export interface ModelGroup {
  modelId: string;
  rows: ModelGroupRow[];
}

/** Groups ordered alphabetically by model id; each type appears in at most one row. */
export type ModelGroups = ModelGroup[];

/** pi's fallback when defaultThinkingLevel is unset (mirrors pi's DEFAULT_THINKING_LEVEL). */
const PI_FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

export function buildModelGroups(input: ModelGroupsInput): ModelGroups {
  const { types, agentConfigs, config, sessionOverrides, hasProjectModelKey, parentModelId } = input;

  const byModel = new Map<string, ModelGroupRow[]>();
  for (const type of types) {
    const cfg = agentConfigs[type];
    const { model: resolved, source } = resolveModelSource({
      subagentType: type,
      agentConfig: cfg,
      config: { agent: config },
      parentModelId,
      sessionOverrides,
    });
    // Anti-spam: only explicit per-type overrides are listed — frontmatter-
    // only and inheriting types stay hidden regardless of the model they resolve
    // to. An explicit per-type key — including an empty one — is listed with a
    // clear path.
    if (!hasExplicitPerTypeOverride(sessionOverrides, config, type)) continue;

    // Tag = the layer that won, straight from the chain: [session] for a
    // session-layer win (per-type override, or the session default shadowing
    // the config per-type key); [project] for a project per-type win without
    // a session default; untagged for a global per-type win. A listed row
    // resolves at a per-type position, at the session default above it, or —
    // for an empty-string key — at the next chain layer.
    const tag =
      source === "session-per-type" || source === "session-default"
        ? "[session]"
        : hasProjectModelKey(type)
          ? "[project]"
          : "";

    const rows = byModel.get(resolved) ?? [];
    rows.push({
      type,
      thinking: displayThinking(cfg, resolved, input),
      tag,
    });
    byModel.set(resolved, rows);
  }

  return [...byModel.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([modelId, modelRows]) => ({ modelId, rows: modelRows }));
}

/**
 * True when the type carries an explicit per-type model override at the
 * session or config layer (including an empty-string key). The anti-spam
 * listing rule shared with the menu's "Override another type..." list:
 * frontmatter-only and inheriting types are never listed.
 */
export function hasExplicitPerTypeOverride(
  sessionOverrides: SessionModelOverrides,
  agentConfig: SubagentsConfig["agent"],
  type: string,
): boolean {
  return sessionOverrides[type] != null || typeof agentConfig[type] === "string";
}

/**
 * The thinking level a spawn under `modelId` would actually run with:
 * frontmatter thinking > defaultThinking > pi's defaultThinkingLevel > medium,
 * clamped to the model's supported levels (unclamped when the model is not
 * in the registry).
 */
function displayThinking(
  cfg: AgentTypeModelConfig | undefined,
  modelId: string,
  input: ModelGroupsInput,
): ThinkingLevel {
  const base =
    cfg?.thinkingLevel ?? input.config.defaultThinking ?? input.piDefaultThinking ?? PI_FALLBACK_THINKING_LEVEL;
  const model = input.findModel(modelId);
  return model ? clampThinkingLevel(model, base) : base;
}
