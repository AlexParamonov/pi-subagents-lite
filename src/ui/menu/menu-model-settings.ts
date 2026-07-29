/** Combined global and per-agent model/thinking settings. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { ThinkingLevel } from "../../types.js";
import { findModelInRegistry } from "../../utils.js";
import { normalizeThinkingLevel, supportedThinkingLevels } from "../../models/thinking.js";
import type { SettingSource } from "../../models/model-precedence.js";
import type { Theme } from "../types.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../../config/types.js";
import { buildSettingsListTheme } from "./helpers.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createThinkingSelectSubmenu } from "./submenus/thinking-select.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

const SOURCE_LABELS: Record<SettingSource, string> = {
  spawn: "spawn",
  "session-agent": "session override",
  "config-agent": "saved override",
  "agent-md": "agent MD",
  "session-global": "session global",
  "config-global": "global default",
  parent: "parent",
};

function withSource(value: string | undefined, source: SettingSource): string {
  return `${value ?? "inherit"} (${SOURCE_LABELS[source]})`;
}

export async function showModelSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const buildItems = (store: ReturnType<typeof getStore>, theme: Theme): SettingItem[] => {
    const items: SettingItem[] = [];

    const modelOverride = (key: string, label: string) =>
      (mode: "session" | "permanent" | "clear", model: string | null): void => {
        if (mode === "clear") {
          store.mutate.session.clearOverride(key);
          if (key === "default") store.mutate.agent.setDefaultModel(null);
          else store.mutate.agent.clearModelOverride(key);
        } else {
          const value = model === "(inherits parent)" ? null : model;
          if (mode === "session") {
            if (value === null) store.mutate.session.clearOverride(key);
            else store.mutate.session.setOverride(key, value);
          } else if (key === "default") {
            store.mutate.agent.setDefaultModel(value);
          } else if (value === null) {
            store.mutate.agent.clearModelOverride(key);
          } else {
            store.mutate.agent.setModelOverride(key, value);
          }
        }
        ctx.ui.notify(`${label} model updated`, "info");
      };

    const thinkingOverride = (key: string, label: string) =>
      (mode: "session" | "permanent" | "clear", level: ThinkingLevel | undefined): void => {
        if (mode === "clear") {
          store.mutate.session.clearThinkingOverride(key);
          if (key === "default") store.mutate.agent.setDefaultThinking(undefined);
          else store.mutate.agent.clearThinkingOverride(key);
        } else if (mode === "session") {
          if (level === undefined) store.mutate.session.clearThinkingOverride(key);
          else store.mutate.session.setThinkingOverride(key, level);
        } else if (key === "default") {
          store.mutate.agent.setDefaultThinking(level);
        } else if (level === undefined) {
          store.mutate.agent.clearThinkingOverride(key);
        } else {
          store.mutate.agent.setThinkingOverride(key, level);
        }
        ctx.ui.notify(`${label} thinking updated`, "info");
      };

    const globalModel = store.sessionDefaultModel ?? store.agent.defaultModel;
    const globalModelSource: SettingSource = store.sessionDefaultModel
      ? "session-global"
      : store.agent.defaultModel
        ? "config-global"
        : "parent";
    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: withSource(globalModel ?? "inherit", globalModelSource),
      description: "Fallback model used only when an agent MD does not specify one.",
      submenu: createModelSelectSubmenu({
        modelOptions,
        showClear: globalModelSource !== "parent",
        theme,
        onSelect: modelOverride("default", "Global default"),
      }),
    });

    const globalThinking = store.sessionDefaultThinking ?? store.agent.defaultThinking;
    const globalThinkingSource: SettingSource = store.sessionDefaultThinking
      ? "session-global"
      : store.agent.defaultThinking
        ? "config-global"
        : "parent";
    items.push({
      id: "defaultThinking",
      label: "Global default thinking",
      currentValue: withSource(globalThinking, globalThinkingSource),
      description: "Fallback thinking used only when an agent MD does not specify one.",
      submenu: createThinkingSelectSubmenu({
        showClear: globalThinkingSource !== "parent",
        theme,
        onSelect: thinkingOverride("default", "Global default"),
      }),
    });

    items.push({ id: "__types__", label: "── Per-agent settings ──", currentValue: "────────" });
    for (const typeName of getAllTypes()) {
      const cfg = getAgentConfig(typeName);
      const model = store.modelSettingFor(typeName, "inherit", cfg);
      const thinking = store.thinkingSettingFor(typeName, undefined, cfg);
      // Some command contexts do not expose a lookup-capable registry (for
      // example during startup). In that case retain the full level list.
      const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { find?: unknown };
      const effectiveModel = typeof registry.find === "function"
        ? findModelInRegistry(model.value, registry as Parameters<typeof findModelInRegistry>[1], ctx.model)
        : ctx.model;
      const effectiveThinking = normalizeThinkingLevel(effectiveModel, thinking.value);
      const incompatibleThinking = thinking.value !== undefined && effectiveThinking !== thinking.value;
      const configModel = store.agentConfigSnapshot()[typeName];

      items.push({
        id: `model:${typeName}`,
        label: `${typeName} · model`,
        currentValue: withSource(model.value, model.source),
        description: `Model setting for ${typeName}. Agent-specific overrides take priority over its MD.`,
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: store.sessionModelOverride(typeName) !== null || typeof configModel === "string",
          theme,
          onSelect: modelOverride(typeName, typeName),
        }),
      });
      items.push({
        id: `thinking:${typeName}`,
        label: `${typeName} · thinking`,
        currentValue: withSource(effectiveThinking, thinking.source),
        description: incompatibleThinking
          ? `Using ${effectiveThinking}; requested ${thinking.value} from ${SOURCE_LABELS[thinking.source]} is unsupported by the effective model.`
          : `Thinking setting for ${typeName}. Agent-specific overrides take priority over its MD.`,
        submenu: createThinkingSelectSubmenu({
          showClear: store.sessionThinkingOverride(typeName) !== undefined
            || store.persistedThinkingOverride(typeName) !== undefined,
          levels: supportedThinkingLevels(effectiveModel),
          theme,
          onSelect: thinkingOverride(typeName, typeName),
        }),
      });
    }

    const hasSession = store.sessionDefaultModel !== null
      || store.sessionDefaultThinking !== undefined
      || getAllTypes().some((type) => store.sessionModelOverride(type) !== null
        || store.sessionThinkingOverride(type) !== undefined);
    if (hasSession) {
      items.push({
        id: "clearSession",
        label: "Clear session overrides",
        currentValue: "",
        description: "Discard session-only model and thinking overrides.",
        submenu: createConfirmSubmenu({
          message: "Clear all session overrides?",
          theme,
          onConfirm: () => {
            store.mutate.session.clearAll();
            ctx.ui.notify("Session overrides cleared", "info");
          },
        }),
      });
    }

    items.push({
      id: "clearAll",
      label: "Reset all agent settings",
      currentValue: "",
      description: "Clear saved and session model/thinking overrides, including global defaults.",
      submenu: createConfirmSubmenu({
        message: "Reset all model and thinking settings?",
        theme,
        onConfirm: () => {
          const agentConfig = store.agentConfigSnapshot();
          const hasModelOverrides = Object.entries(agentConfig).some(
            ([key, value]) => !CONFIG_AGENT_NON_MODEL_KEYS.includes(key) && value != null,
          );
          const hasAnything = hasSession || hasModelOverrides || store.agent.defaultModel !== null
            || store.agent.defaultThinking !== undefined
            || store.hasPersistedThinkingOverrides();
          if (!hasAnything) {
            ctx.ui.notify("No overrides to clear", "info");
            return;
          }
          store.mutate.session.clearAll();
          store.mutate.agent.clearAllModelOverrides();
          store.mutate.agent.clearAllThinkingOverrides();
          store.mutate.agent.setDefaultModel(null);
          store.mutate.agent.setDefaultThinking(undefined);
          ctx.ui.notify("All agent settings reset", "info");
        },
      }),
    });

    return items;
  };

  let rebuild: ((items: SettingItem[]) => void) | undefined;
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items = buildItems(getStore(), theme);
    const settingsList = new SettingsList(
      items,
      18,
      buildSettingsListTheme(theme),
      () => rebuild?.(buildItems(getStore(), theme)),
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Agent Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (callback) => { rebuild = callback; },
    });
  });
}
