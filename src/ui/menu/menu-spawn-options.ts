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

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { buildSettingsListTheme, buildSelectListTheme } from "./helpers.js";
import { createTargetSelectSubmenu } from "./submenus/target-select.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { ThinkingLevel } from "../../types.js";
import type { Theme } from "../types.js";
import { DEFAULT_GRACE_TURNS, DEFAULT_WATCHDOG_TIMEOUT_MINUTES } from "../../config/config-io.js";
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
      id: "outputTranscript",
      label: "Output transcript",
      currentValue: store.agent.outputTranscript ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Write streaming transcript to /tmp/pi-agent-outputs/<agentId>.log (frontmatter overrides).",
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
      case "outputTranscript":
        store.mutate.agent.setOutputTranscript(newValue === "ON");
        ctx.ui.notify(`Output transcript set to ${newValue}`, "info");
        break;
    }
  };

  let rebuild: ((items: any[]) => void) | undefined;

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
        if (items.some((i) => i.id === id && i.submenu)) triggerRebuild();
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
