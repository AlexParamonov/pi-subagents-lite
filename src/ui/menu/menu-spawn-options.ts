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
import { SettingsList, Input, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme, validateNumeric } from "./menu-helpers.js";
import type { ThinkingLevel } from "../../types.js";
import { getStore } from "../../shell.js";

export async function showSpawnOptionsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const items: SettingItem[] = [
    {
      id: "forceBackground",
      label: "Force background",
      currentValue: store.agent.forceBackground ? "ON" : "OFF",
      values: ["ON", "OFF"],
    },
    {
      id: "graceTurns",
      label: "Grace turns",
      currentValue: String(store.agent.graceTurns),
      submenu: (currentValue, done) => {
        const input = new Input();
        input.setValue(currentValue);
        input.onSubmit = (value) => {
          const result = validateNumeric(value, 0);
          if (result === undefined) {
            ctx.ui.notify("Must be a number ≥ 0", "error");
            return;
          }
          store.mutate.agent.setGraceTurns(result);
          ctx.ui.notify(`Grace turns set to ${result}`, "info");
          done(String(result));
        };
        input.onEscape = () => done();
        return input;
      },
    },
    {
      id: "defaultMaxTurns",
      label: "Default max turns",
      currentValue: store.agent.defaultMaxTurns != null ? String(store.agent.defaultMaxTurns) : "unlimited",
      submenu: (currentValue, done) => {
        const input = new Input();
        input.setValue(currentValue);
        input.onSubmit = (value) => {
          const trimmed = value.trim().toLowerCase();
          if (trimmed === "unlimited" || trimmed === "") {
            store.mutate.agent.setDefaultMaxTurns(undefined);
            ctx.ui.notify("Default max turns set to unlimited", "info");
            done("unlimited");
            return;
          }
          const result = validateNumeric(value, 1);
          if (result === undefined) {
            ctx.ui.notify("Must be a number ≥ 1 or 'unlimited'", "error");
            return;
          }
          store.mutate.agent.setDefaultMaxTurns(result);
          ctx.ui.notify(`Default max turns set to ${result}`, "info");
          done(String(result));
        };
        input.onEscape = () => done();
        return input;
      },
    },
    {
      id: "defaultThinking",
      label: "Default thinking level",
      currentValue: store.agent.defaultThinking ?? "inherit",
      values: ["off", "minimal", "low", "medium", "high", "xhigh", "inherit"],
    },
  ];

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "forceBackground":
        store.mutate.agent.setForceBackground(newValue === "ON");
        ctx.ui.notify(`Force background set to ${newValue}`, "info");
        break;
      case "defaultThinking":
        store.mutate.agent.setDefaultThinking(newValue === "inherit" ? undefined : newValue as ThinkingLevel);
        ctx.ui.notify(`Default thinking level set to ${newValue}`, "info");
        break;
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) =>
    new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined))
  );
}
