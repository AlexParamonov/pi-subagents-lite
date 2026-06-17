/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses ctx.ui.select with a while(true) loop for the dispatcher menus (main, settings).
 * This pattern is correct for dispatchers because:
 *   - They don't need cursor persistence (cursor position doesn't matter for dispatchers)
 *   - ctx.ui.select handles escape correctly and re-renders after each submenu
 *   - SettingsList-based menus (spawn options, system prompt) have the cursor persistence issue
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
import { matchMenuChoice } from "./menu-helpers.js";
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
  const menuItems = [
    "1. Model settings — Set global default and per-type model overrides",
    "2. Concurrency settings — Set per-model slot limits",
    "3. Spawn options — Default thinking, max turns, background, grace turns",
    "4. System prompt — Prompt mode, custom prompt file, AGENTS.md",
    "5. Widget settings — Configure widget display options",
    "",
    "Back",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showModelSettingsMenu(ctx, modelOptions),
    "2": () => showConcurrencySettingsMenu(ctx, modelOptions),
    "3": () => showSpawnOptionsMenu(ctx),
    "4": () => showSystemPromptMenu(ctx),
    "5": () => showWidgetSettingsMenu(ctx),
  };

  while (true) {
    const choice = await ctx.ui.select("Settings", menuItems);
    if (choice === undefined || choice === "Back") return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Running agents — List running/queued agents",
    "2. Spawn agent — Manually spawn a new agent",
    "3. Settings — Model, concurrency, and widget settings",
    "4. Debug — Agent types, briefing, diagnostics",
    "",
    "Press Escape to close",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showRunningAgentsMenu(ctx),
    "2": () => showSpawnAgentMenu(ctx, modelOptions),
    "3": () => showSettingsMenu(ctx, modelOptions),
    "4": () => showDebugMenu(ctx),
  };

  // Loop so sub-menus navigate back to root; only Escape at root closes
  while (true) {
    const choice = await ctx.ui.select("Subagents Management", menuItems);
    if (choice === undefined || choice === "Press Escape to close") return;

    const action = matchMenuChoice(choice, handlers);
    if (action) await action();
  }
}
