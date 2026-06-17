/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Module structure:
 *   - menu-helpers.ts: shared helpers (runMenuLoop, runMenu, promptModelSelection, parseNumericInput, matchMenuChoice, buildSettingsListTheme, validateNumeric)
 *   - menu-model-settings.ts: showModelSettingsMenu
 *   - menu-concurrency.ts: showConcurrencySettingsMenu
 *   - menu-widget-settings.ts: showWidgetSettingsMenu
 *   - menu-running-agents.ts: showRunningAgentsMenu, showAgentActions
 *   - menu-debug.ts: showDebugMenu
 *   - menu-spawn-options.ts: showSpawnOptionsMenu
 *   - menu-system-prompt.ts: showSystemPromptMenu
 *   - menus.ts (this file): dispatcher — main menu and settings menu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./menu-helpers.js";
import { showModelSettingsMenu } from "./menu-model-settings.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showRunningAgentsMenu } from "./menu-running-agents.js";
import { showDebugMenu } from "./menu-debug.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";

// Spawn wizard — imported and re-exported so the dispatcher calls it from here.
import { showSpawnAgentMenu } from "../../spawn/spawn-wizard.js";
export { showSpawnAgentMenu };


export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SettingItem[] = [
    {
      id: "model",
      label: "Model settings",
      currentValue: "→",
      submenu: (_v, done) => {
        showModelSettingsMenu(ctx, modelOptions).then(() => done());
        // Async navigation: the submenu takes over rendering via ctx.ui.select/custom
        // before SettingsList can interact with the return value. undefined is safe here.
        return undefined as any;
      },
    },
    {
      id: "concurrency",
      label: "Concurrency settings",
      currentValue: "→",
      submenu: (_v, done) => {
        showConcurrencySettingsMenu(ctx, modelOptions).then(() => done());
        return undefined as any;
      },
    },
    {
      id: "spawn",
      label: "Spawn options",
      currentValue: "→",
      submenu: (_v, done) => {
        showSpawnOptionsMenu(ctx).then(() => done());
        return undefined as any;
      },
    },
    {
      id: "systemPrompt",
      label: "System prompt",
      currentValue: "→",
      submenu: (_v, done) => {
        showSystemPromptMenu(ctx).then(() => done());
        return undefined as any;
      },
    },
    {
      id: "widget",
      label: "Widget settings",
      currentValue: "→",
      submenu: (_v, done) => {
        showWidgetSettingsMenu(ctx).then(() => done());
        return undefined as any;
      },
    },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) =>
    new SettingsList(items, 10, buildSettingsListTheme(theme), () => {}, () => done(undefined))
  );
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SettingItem[] = [
    {
      id: "running",
      label: "Running agents",
      currentValue: "→",
      submenu: (_v, done) => {
        showRunningAgentsMenu(ctx).then(() => done());
        // Async navigation: the submenu takes over rendering via ctx.ui.select/custom
        // before SettingsList can interact with the return value. undefined is safe here.
        return undefined as any;
      },
    },
    {
      id: "spawn",
      label: "Spawn agent",
      currentValue: "→",
      submenu: (_v, done) => {
        showSpawnAgentMenu(ctx, modelOptions).then(() => done());
        return undefined as any;
      },
    },
    {
      id: "settings",
      label: "Settings",
      currentValue: "→",
      submenu: (_v, done) => {
        showSettingsMenu(ctx, modelOptions).then(() => done());
        return undefined as any;
      },
    },
    {
      id: "debug",
      label: "Debug",
      currentValue: "→",
      submenu: (_v, done) => {
        showDebugMenu(ctx).then(() => done());
        return undefined as any;
      },
    },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) =>
    new SettingsList(items, 10, buildSettingsListTheme(theme), () => {}, () => done(undefined))
  );
}
