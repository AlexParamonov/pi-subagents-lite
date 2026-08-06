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
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { ThinkingLevel } from "../../types.js";
import { DEFAULT_GRACE_TURNS, DEFAULT_WATCHDOG_TIMEOUT_MINUTES } from "../../config/config-io.js";
import { getStore } from "../../shell.js";

export async function showSpawnOptionsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const items: SettingItem[] = [
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
      currentValue: String(store.agent.defaultMaxTurns ?? "(not set)"),
      submenu: createNumericSubmenu(
        ctx,
        { min: 1 },
        (parsed) => {
          store.mutate.agent.setDefaultMaxTurns(parsed);
          ctx.ui.notify(`Default max turns set to ${parsed}`, "info");
        },
        () => {
          store.mutate.agent.setDefaultMaxTurns(undefined);
          ctx.ui.notify("Default max turns cleared", "info");
        },
      ),
      description: "Soft turn limit; agent is steered here, then hard-aborts after grace turns. Blank = unlimited.",
    },
    {
      id: "defaultThinking",
      label: "Default thinking level",
      currentValue: store.agent.defaultThinking ?? "inherit",
      values: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"],
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
      description: "Write streaming JSON-lines transcript to .output file for each agent.",
    },
  ];

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "forceBackground":
        store.mutate.agent.setForceBackground(newValue === "ON");
        ctx.ui.notify(`Force background set to ${newValue}`, "info");
        break;
      case "defaultThinking":
        store.mutate.agent.setDefaultThinking(newValue === "inherit" ? undefined : (newValue as ThinkingLevel));
        ctx.ui.notify(`Default thinking level set to ${newValue}`, "info");
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

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const settingsList = new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "Spawn Options", theme, onCancel: () => done(undefined) });
  });
}
