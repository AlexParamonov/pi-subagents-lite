/**
 * menu-agent-settings.ts — Agent settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Exports:
 *   - showSpawnOptionsMenu: agent limit, colors, output, thinking
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, SelectList, type SettingItem, type Component } from "@earendil-works/pi-tui";
import { SEPARATOR_ID, buildSettingsListTheme, buildSelectListTheme, headerItem } from "./helpers.js";
import { createTargetSelectSubmenu } from "./submenus/target-select.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { ThinkingLevel } from "../../types.js";
import type { Theme } from "../types.js";
import {
  DEFAULT_GRACE_TURNS,
  DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
  CUSTOM_PROMPT_PATH,
  canonicalAgentStatusLimit,
} from "../../config/config-io.js";
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
    // --- Spawn behavior ---
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
      id: "toolTimeout",
      label: "Tool timeout watchdog",
      currentValue: String(store.agent.toolTimeoutMinutes),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_WATCHDOG_TIMEOUT_MINUTES }, (parsed) => {
        store.mutate.agent.setToolTimeoutMinutes(parsed);
        ctx.ui.notify(`Tool timeout set to ${parsed} minutes`, "info");
      }),
      description: "Stop an agent when a single tool call runs longer than this. 0 disables the check.",
    },
    {
      id: "idleTimeout",
      label: "Idle timeout watchdog",
      currentValue: String(store.agent.idleTimeoutMinutes),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_WATCHDOG_TIMEOUT_MINUTES }, (parsed) => {
        store.mutate.agent.setIdleTimeoutMinutes(parsed);
        ctx.ui.notify(`Idle timeout set to ${parsed} minutes`, "info");
      }),
      description:
        "Stop an agent with no activity (tool events or streamed text) for longer than this. 0 disables the check.",
    },
    // --- Delivery ---
    { id: SEPARATOR_ID, label: " ", currentValue: "" },
    headerItem(theme, "Delivery & Display"),
    {
      id: "forceBackground",
      label: "Force background",
      currentValue: store.agent.forceBackground ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Spawn every agent in the background by default (no foreground wait).",
    },
    {
      id: "showCompletionCards",
      label: "Completion cards",
      currentValue: store.agent.showCompletionCards ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show background-agent completion cards in the transcript; turn OFF to hide them.",
    },
    {
      id: "showAgentColors",
      label: "Agent colors",
      currentValue: store.agent.showAgentColors ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Enable colored spinner frames, status icons, and picker bullets.",
    },
    {
      id: "statusBarFormat",
      label: "Status bar format",
      currentValue: store.agent.statusBarFormat,
      values: ["full", "compact"],
      description: "Status bar format: full (Agents: N active · M done) or compact (N MΣ).",
    },
    // --- Tools ---
    { id: SEPARATOR_ID, label: " ", currentValue: "" },
    headerItem(theme, "Tools"),
    {
      id: "disableDefaultAgents",
      label: "Disable default agents",
      currentValue: store.agent.disableDefaultAgents ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Skip auto-loading built-in agent types next session; only .pi/agents types load.",
    },
    {
      id: "agentToolStrictMode",
      label: "Strict schema for Agent tool",
      currentValue: store.agent.agentToolStrictMode ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description:
        "Uses constrained sampling for Agent tool. Costs slightly more tokens, requires compatible provider (OpenAI Codex, etc). Requires reload.",
    },
    {
      id: "agentStatusLimit",
      label: "Agent status limit",
      currentValue: String(canonicalAgentStatusLimit(store.agentConfigSnapshot().agentStatusLimit)),
      submenu: createNumericSubmenu(ctx, { min: 0 }, (parsed) => {
        store.mutate.agent.setAgentStatusLimit(parsed);
        ctx.ui.notify(`Agent status limit set to ${parsed}`, "info");
      }),
      description: "Max settled agents AgentStatus lists. 0 = auto (2 × default concurrency).",
    },
    {
      id: "outputTranscript",
      label: "Output transcript",
      currentValue: store.agent.outputTranscript ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Write streaming transcript to /tmp/pi-agent-outputs/<agentId>.log (frontmatter overrides).",
    },
    {
      id: "thinkingBuffer",
      label: "Thinking buffer",
      currentValue: store.agent.outputThinkingBufferSize === 0 ? "OFF" : String(store.agent.outputThinkingBufferSize),
      values: ["OFF", "80", "200", "500", "1000"],
      description:
        "Controls output transcript thinking buffering in chars. OFF = only at turn end, 80 = flush after 80 chars.",
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
      case "agentStatusLimit":
        // Handled by numeric submenu
        break;
      case "agentToolStrictMode":
        store.mutate.agent.setAgentToolStrictMode(newValue === "ON");
        ctx.ui.notify(`Agent tool strict mode ${newValue} (requires reload)`, "info");
        break;
      case "showAgentColors":
        store.mutate.agent.setShowAgentColors(newValue === "ON");
        ctx.ui.notify(`Agent colors ${newValue}`, "info");
        break;
      case "showCompletionCards":
        store.mutate.widget.setShowCompletionCards(newValue === "ON");
        ctx.ui.notify(`Show completion cards ${newValue}`, "info");
        break;
      case "statusBarFormat":
        store.mutate.widget.setStatusBarFormat(newValue as "full" | "compact");
        ctx.ui.notify(`Status bar format: ${newValue}`, "info");
        break;
      case "outputTranscript":
        store.mutate.agent.setOutputTranscript(newValue === "ON");
        ctx.ui.notify(`Output transcript set to ${newValue}`, "info");
        break;
      case "thinkingBuffer":
        store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
        ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
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
        if (items.some((i) => i.id === id && i.submenu)) triggerRebuild();
      },
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "Agent settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
