/**
 * menu-spawn-options.ts — Spawn options menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Exports:
 *   - showSpawnOptionsMenu: default spawn-time options (thinking, max turns, force background, grace turns)
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { buildSettingsListTheme, buildSelectListTheme } from "./helpers.js";
import { createTargetSelectSubmenu } from "./submenus/target-select.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { ThinkingLevel } from "../../types.js";
import type { SystemPromptMode } from "../../agents/types.js";
import type { Theme } from "../types.js";
import { DEFAULT_GRACE_TURNS, DEFAULT_WATCHDOG_TIMEOUT_MINUTES, CUSTOM_PROMPT_PATH } from "../../config/config-io.js";
import { VALID_THINKING_LEVELS } from "../../utils.js";
import { getStore } from "../../shell.js";

export async function showSpawnOptionsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  /** " [project]" when the effective value comes from the project layer. */
  const projectTag = (key: string): string => (store.hasProjectModelKey(key) ? " [project]" : "");

  /** Submenu: pick a persisted layer (global or project), then edit the value. No session target. */
  const persistedTargetSubmenu = (
    theme: Theme,
    onPick: (target: "global" | "project", pickDone: (selectedValue?: string) => void) => Component | void,
  ) =>
    createTargetSelectSubmenu({
      theme,
      projectOffered: store.projectTargetOffered,
      includeSession: false,
      // The picker offers only global/project here; narrow its TargetChoice.
      onPick: (target, pickDone) => onPick(target as "global" | "project", pickDone),
    });

  const buildItems = (theme: Theme): SettingItem[] => [
    {
      id: "forceBackground",
      label: "Force background",
      currentValue: store.agent.forceBackground ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Spawn every agent in the background by default (no foreground wait).",
    },
    {
      id: "graceTurns",
      label: "Grace turns",
      currentValue: String(store.agent.graceTurns),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) => {
        store.mutate.agent.setGraceTurns(parsed);
        ctx.ui.notify(`Grace turns set to ${parsed}`, "info");
      }),
      description: "Extra turns after the soft turn limit before a hard abort.",
    },
    {
      id: "toolTimeout",
      label: "Tool timeout",
      currentValue: String(store.agent.toolTimeoutMinutes),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_WATCHDOG_TIMEOUT_MINUTES }, (parsed) => {
        store.mutate.agent.setToolTimeoutMinutes(parsed);
        ctx.ui.notify(`Tool timeout set to ${parsed} minutes`, "info");
      }),
      description: "Stop an agent when a single tool call runs longer than this. 0 disables the check.",
    },
    {
      id: "idleTimeout",
      label: "Idle timeout",
      currentValue: String(store.agent.idleTimeoutMinutes),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_WATCHDOG_TIMEOUT_MINUTES }, (parsed) => {
        store.mutate.agent.setIdleTimeoutMinutes(parsed);
        ctx.ui.notify(`Idle timeout set to ${parsed} minutes`, "info");
      }),
      description:
        "Stop an agent with no activity (tool events or streamed text) for longer than this. 0 disables the check.",
    },
    {
      id: "defaultMaxTurns",
      label: "Default max turns",
      currentValue: `${store.agent.defaultMaxTurns ?? "(not set)"}${projectTag("defaultMaxTurns")}`,

      submenu: createTargetSelectSubmenu({
        theme,
        projectOffered: store.projectTargetOffered,
        includeSession: false,
        showClear: true,
        onPick: (target, pickDone) => {
          const layer = target as "global" | "project";
          return createNumericSubmenu(
            ctx,
            { min: 1 },
            (parsed) => {
              store.mutate.agent.setDefaultMaxTurns(parsed, layer);
              ctx.ui.notify(`Default max turns set to ${parsed} (${layer})`, "info");
            },
            () => {
              store.mutate.agent.setDefaultMaxTurns(undefined, layer);
              ctx.ui.notify(`Default max turns cleared (${layer})`, "info");
            },
          )(String(store.agent.defaultMaxTurns ?? ""), pickDone);
        },
        onClear: (target) => {
          // The nested clear picker has no session entry (includeSession: false above).
          store.mutate.agent.clearDefaultMaxTurns(target as "global" | "project" | "all");
          ctx.ui.notify(`Default max turns cleared (${target})`, "info");
        },
      }),
      description: "Soft turn limit; agent is steered here, then hard-aborts after grace turns. Blank = unlimited.",
    },
    {
      id: "defaultThinking",
      label: "Default thinking level",
      currentValue: `${store.agent.defaultThinking ?? "inherit"}${projectTag("defaultThinking")}`,

      submenu: persistedTargetSubmenu(theme, (target, pickDone) => {
        const levelItems = [...VALID_THINKING_LEVELS, "inherit"].map((v) => ({
          value: v,
          label: v,
        }));
        const list = new SelectList(levelItems, 10, buildSelectListTheme(theme));
        list.onSelect = (item) => {
          store.mutate.agent.setDefaultThinking(
            item.value === "inherit" ? undefined : (item.value as ThinkingLevel),
            target,
          );
          ctx.ui.notify(`Default thinking level set to ${item.value} (${target})`, "info");
          pickDone(item.value);
        };
        list.onCancel = () => pickDone();
        return list;
      }),
      description: "Thinking level applied when agent frontmatter omits one.",
    },
    {
      id: "disableDefaultAgents",
      label: "Disable default agents",
      currentValue: store.agent.disableDefaultAgents ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Skip auto-loading built-in agent types next session; only .pi/agents types load.",
    },
    {
      id: "systemPromptMode",
      label: "System prompt mode",
      currentValue: store.agent.systemPromptMode,
      values: ["replace", "inherit", "custom"],
      description: "How the subagent system prompt is built: replace, inherit, or custom.",
    },
    // Create prompt file (only when mode is custom and file doesn't exist)
    ...(store.agent.systemPromptMode === "custom" && !fs.existsSync(CUSTOM_PROMPT_PATH)
      ? [
          {
            id: "createPromptFile",
            label: "Create prompt file",
            currentValue: CUSTOM_PROMPT_PATH,
            values: ["Create"],
            description: `Create ${CUSTOM_PROMPT_PATH} with a starter template for custom mode.`,
          },
        ]
      : []),
    {
      id: "includeContextFiles",
      label: "Include AGENTS.md",
      currentValue: store.agent.includeContextFiles ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Load project and ~/.pi/agent AGENTS.md as shared <project_context>.",
    },
    {
      id: "loadSkillsImplicitly",
      label: "Load skills implicitly",
      currentValue: store.agent.loadSkillsImplicitly ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Give new agents all skills when frontmatter omits the field.",
    },
    {
      id: "loadExtensionsImplicitly",
      label: "Load extensions implicitly",
      currentValue: store.agent.loadExtensionsImplicitly ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Give new agents all extensions when frontmatter omits the field.",
    },
    {
      id: "agentToolStrictMode",
      label: "Strict schema for Agent tool",
      currentValue: store.agent.agentToolStrictMode ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description:
        "Uses constrained sampling for Agent tool. Costs slightly more tokens, requires compatible provider (OpenAI Codex, etc). Requires reload.",
    },
  ];

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "forceBackground":
        store.mutate.agent.setForceBackground(newValue === "ON");
        ctx.ui.notify(`Force background set to ${newValue}`, "info");
        break;
      case "disableDefaultAgents":
        store.mutate.agent.setDisableDefaultAgents(newValue === "ON");
        ctx.ui.notify(`Disable default agents ${newValue} (takes effect on next session)`, "info");
        break;
      case "systemPromptMode":
        store.mutate.agent.setSystemPromptMode(newValue as SystemPromptMode);
        ctx.ui.notify(`System prompt mode set to ${newValue}`, "info");
        break;
      case "createPromptFile":
        try {
          fs.mkdirSync(path.dirname(CUSTOM_PROMPT_PATH), { recursive: true });
          fs.writeFileSync(
            CUSTOM_PROMPT_PATH,
            "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously",
            "utf-8",
          );
          ctx.ui.notify(`Created prompt file: ${CUSTOM_PROMPT_PATH}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to create prompt file: ${err.message}`, "error");
        }
        return;
      case "includeContextFiles":
        store.mutate.agent.setIncludeContextFiles(newValue === "ON");
        ctx.ui.notify(`Include AGENTS.md set to ${newValue}`, "info");
        break;
      case "loadSkillsImplicitly":
        store.mutate.agent.setLoadSkillsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load skills implicitly set to ${newValue}`, "info");
        break;
      case "loadExtensionsImplicitly":
        store.mutate.agent.setLoadExtensionsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load extensions implicitly set to ${newValue}`, "info");
        break;
      case "agentToolStrictMode":
        store.mutate.agent.setAgentToolStrictMode(newValue === "ON");
        ctx.ui.notify(`Agent tool strict mode ${newValue} (requires reload)`, "info");
        break;
    }
  };

  let rebuild: ((items: SettingItem[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items = buildItems(theme);
    const triggerRebuild = () => rebuild?.(buildItems(theme));
    const settingsList = new SettingsList(
      items,
      10,
      buildSettingsListTheme(theme),
      (id, newValue) => {
        onChange(id, newValue);
        // Submenu-driven rows rebuild to refresh value + provenance tag; toggle
        // rows update in place via SettingsList (a rebuild would reset the cursor).
        // System prompt mode change also rebuilds: "custom" adds createPromptFile item.
        if (items.some((i) => i.id === id && i.submenu) || id === "systemPromptMode") triggerRebuild();
      },
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Spawn Options",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
