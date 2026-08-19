/**
 * menu-model-settings.ts — Model settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * Model overrides use target-level submenus (session/global/project, plus
 * nested per-level clear) per ADR-0008. Agent types are grouped by their
 * Resolved model (one group per listed model, alphabetical); each row
 * shows the type name, the spawn-effective (clamped) thinking level, and
 * provenance tag ([session] for a session-layer win — per-type override or
 * session default; [project]; untagged for a global-layer win).
 *
 *   - showModelSettingsMenu: model settings with global default and model
 *     groups for types carrying an explicit per-type override
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { Theme } from "../types.js";
import { SEPARATOR_ID, buildSettingsListTheme, createSearchableSelect, headerItem } from "./helpers.js";
import { agentBulletPrefix } from "../format.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createClearAllSubmenu, type AvailableLevels, type TargetChoice } from "./submenus/target-select.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getSessionCtx, getStore } from "../../shell.js";
import { buildModelGroups, hasExplicitPerTypeOverride, type AgentTypeModelConfig } from "../../models/model-groups.js";
import { findModelInRegistry } from "../../utils.js";
import { getPiDefaultThinkingLevel } from "../../pi-settings.js";
import type { SessionModelOverrides } from "../../models/model-precedence.js";

/**
 * Thinking levels pad to this width so every row's tag starts at the same
 * column. "minimal" (7 chars) is the longest level label in the ThinkingLevel
 * union.
 */
const THINKING_COLUMN_WIDTH = 7;

/**
 * Display value for the "Global default model" row. Tag precedence:
 * session > project; the global layer is the default source and is never
 * tagged, so an untagged value means the global layer won. A null default
 * key means "unset" (null-skip in resolveModel), so a tag requires a
 * usable value.
 */
function defaultRowValue(
  sessionDefault: string | null,
  effectiveDefault: string | null,
  hasProjectDefault: boolean,
): string {
  if (sessionDefault != null) return `${sessionDefault} [session]`;
  if (effectiveDefault == null) return "(inherits parent)";
  return hasProjectDefault ? `${effectiveDefault} [project]` : effectiveDefault;
}

export async function showModelSettingsMenu(ctx: ExtensionCommandContext, modelOptions: string[]): Promise<void> {
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];
    const projectOffered = store.projectTargetOffered;

    // Shared onSet for model override submenus: applies the model to the given
    // config key at the picked layer, with `label` used in notify messages.
    // The picker returns the literal "(inherits parent)" sentinel string (never
    // null); selecting it means "clear this key at the picked layer" so the
    // value falls through to the next layer (ADR-0008 delete semantics).
    const modelOverrideOnSelect =
      (key: string, label: string): ((target: "session" | "global" | "project", model: string | null) => void) =>
      (target, model) => {
        const inherits = model === null || model === "(inherits parent)";
        if (inherits) store.mutate.agent.clearModelOverride(key, target);
        else store.mutate.agent.setModelOverride(key, model, target);
        ctx.ui.notify(
          inherits ? `${label} inherits parent model` : `${label} model set to ${model} (${target})`,
          "info",
        );
      };

    // Shared onClear: deletes the key at the picked layer, falling through to
    // the next layer. "all" clears every layer.
    const clearOverrideOnSelect =
      (key: string, label: string): ((target: TargetChoice) => void) =>
      (target) => {
        store.mutate.agent.clearModelOverride(key, target);
        ctx.ui.notify(`${label} override cleared (${target})`, "info");
      };

    // Shared submenu factory: target + model picker for one config key.
    // availableLevels filters the nested clear picker (the default and per-type
    // rows pass the levels where the key exists); set entries are never filtered.
    const modelSubmenuFor = (
      typeName: string,
      effectiveModel: string | null,
      showClear: boolean,
      availableLevels?: AvailableLevels,
    ) =>
      createModelSelectSubmenu({
        modelOptions,
        showClear,
        projectOffered,
        theme,
        currentModel: effectiveModel,
        availableLevels,
        onSet: modelOverrideOnSelect(typeName, typeName),
        onClear: clearOverrideOnSelect(typeName, typeName),
      });

    // Per-key level availability: which layers carry a config key, driving the
    // nested clear picker and the default row's Clear entry.
    const sessionOverrides: SessionModelOverrides = { default: store.sessionDefaultModel };
    const levelsFor = (key: string): AvailableLevels => ({
      session: sessionOverrides[key] != null,
      global: store.hasGlobalModelKey(key),
      project: store.hasProjectModelKey(key),
    });

    // Global default model
    const agentConfigSnapshot = store.agentConfigSnapshot();
    const sessionDefault = store.sessionDefaultModel;
    const effectiveDefault = agentConfigSnapshot.default;
    const globalDisplayValue = defaultRowValue(sessionDefault, effectiveDefault, store.hasProjectModelKey("default"));
    const defaultLevels = levelsFor("default");

    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: globalDisplayValue,
      description: "Model used when no session default, per-type override, or frontmatter model applies.",
      submenu: modelSubmenuFor(
        "default",
        effectiveDefault,
        defaultLevels.session || defaultLevels.global || defaultLevels.project,
        defaultLevels,
      ),
    });

    // Model groups: one group per Resolved model with a listed row (an
    // explicit per-type override, including one pointing at the effective
    // default), alphabetical by model id. Rows show the type name, the
    // spawn-effective (clamped) thinking level, and the winning layer's
    // provenance tag.
    const session = getSessionCtx();
    const parentModel = session?.model ?? ctx.model;
    const parentModelId = parentModel ? `${parentModel.provider}/${parentModel.id}` : "(inherits parent)";
    const registry = session?.modelRegistry ?? ctx.modelRegistry;
    const types = getAllTypes();

    const agentConfigs: Record<string, AgentTypeModelConfig | undefined> = {};
    for (const type of types) {
      // Null entries read as absent downstream, so every type is recorded.
      sessionOverrides[type] = store.sessionModelOverride(type);
      agentConfigs[type] = getAgentConfig(type);
    }

    const groups = buildModelGroups({
      types,
      agentConfigs,
      config: agentConfigSnapshot,
      sessionOverrides,
      hasProjectModelKey: (key) => store.hasProjectModelKey(key),
      parentModelId,
      piDefaultThinking: getPiDefaultThinkingLevel(ctx.cwd),
      findModel: (modelId) => findModelInRegistry(modelId, registry, undefined),
    });

    for (const group of groups) {
      // Blank spacer above each block: pre-groups spacer and between-groups
      // separator are the same row; the long rule divides after the last group.
      items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
      // Section title: bare model id in bold accent, matching the menu title
      items.push(headerItem(theme, group.modelId));
      for (const row of group.rows) {
        items.push({
          id: `type:${row.type}`,
          label: `${agentBulletPrefix(row.type)}${row.type}`,
          currentValue: `${row.thinking.padEnd(THINKING_COLUMN_WIDTH)} ${row.tag}`,
          description: `Model for the ${row.type} agent type. Select to set or clear its override.`,
          // Every listed row carries an explicit per-type override, so Clear is always offered.
          submenu: modelSubmenuFor(row.type, group.modelId, true, levelsFor(row.type)),
        });
      }
    }

    // "Override another type..." lists types without an explicit per-type
    // override: frontmatter-only and inheriting types.
    items.push({ id: SEPARATOR_ID, label: "─────────────────────────", currentValue: "────────" });
    const nonOverridden = types.filter(
      (type) => !hasExplicitPerTypeOverride(sessionOverrides, agentConfigSnapshot, type),
    );
    if (nonOverridden.length > 0) {
      items.push({
        id: "overrideType",
        label: "Override another type...",
        currentValue: "",
        description: "Add a model override for an agent type that currently inherits.",
        submenu: (_currentValue, subDone) =>
          createSearchableSelect(
            nonOverridden.map((typeName) => ({ value: typeName, label: `${agentBulletPrefix(typeName)}${typeName}` })),
            {
              onSelect: (typeName) => {
                const effectiveModel = store.modelFor(typeName, parentModelId, getAgentConfig(typeName));
                return modelSubmenuFor(typeName, effectiveModel, false)(effectiveModel, subDone);
              },
              onCancel: () => subDone(),
            },
            theme,
          ),
      });
    }

    items.push({ id: SEPARATOR_ID, label: " ", currentValue: "" });
    // Clear-all per target: nested level picker, then confirm. Each level is
    // offered only when it has model settings (project additionally requires
    // the project target to be offered); the entry itself is hidden when no
    // level is offered.
    const availableLevels: AvailableLevels = {
      session: store.hasSessionModelSettings,
      global: store.hasGlobalModelSettings,
      project: store.hasProjectModelSettings && projectOffered,
    };
    if (availableLevels.session || availableLevels.global || availableLevels.project) {
      items.push({
        id: "clearAll",
        label: "Clear all model overrides...",
        currentValue: "",
        description: "Discard model overrides at the chosen level (session, global, project, or all).",
        submenu: createClearAllSubmenu({
          theme,
          projectOffered,
          availableLevels,
          message: (target) => `Clear all model overrides at the ${target} level?`,
          onConfirm: (target) => {
            store.mutate.agent.clearAllModelOverrides(target);
            ctx.ui.notify(`Model overrides cleared (${target})`, "info");
          },
        }),
      });
    }

    return items;
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const store = getStore();
    const items = buildItems(store, theme);

    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (_id, _v) => rebuild?.(buildItems(getStore(), theme)),
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Model Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
