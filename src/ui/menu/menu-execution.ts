/** Execution defaults shown at the top level of /agents settings. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { createDefaultConcurrencySetting } from "./menu-concurrency.js";
import { buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

export async function showExecutionMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const items: SettingItem[] = [
    createDefaultConcurrencySetting(ctx),
    {
      id: "forceBackground",
      label: "Force background",
      currentValue: store.agent.forceBackground ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Spawn every agent in the background by default.",
    },
    {
      id: "defaultMaxTurns",
      label: "Default max turns",
      currentValue: String(store.agent.defaultMaxTurns ?? "(not set)"),
      submenu: createNumericSubmenu(ctx, { min: 1 }, (parsed) => {
        store.mutate.agent.setDefaultMaxTurns(parsed);
        ctx.ui.notify(`Default max turns set to ${parsed}`, "info");
      }, () => {
        store.mutate.agent.setDefaultMaxTurns(undefined);
        ctx.ui.notify("Default max turns cleared", "info");
      }),
      description: "Soft turn limit. Blank leaves it unlimited.",
    },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const list = new SettingsList(items, 10, buildSettingsListTheme(theme), (id, value) => {
      if (id === "forceBackground") {
        store.mutate.agent.setForceBackground(value === "ON");
        ctx.ui.notify(`Force background set to ${value}`, "info");
      }
    }, () => done(undefined));
    return new SettingsListWrapper(list, { title: "Execution", theme, onCancel: () => done(undefined) });
  });
}
