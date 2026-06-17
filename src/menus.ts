/**
 * menus.ts — /agents command dispatcher.
 *
 * Thin dispatcher that routes command selections to the correct sub-module.
 * Re-exports showSpawnAgentMenu from spawn-wizard.ts.
 *
 * Module structure:
 *   - menu-helpers.ts: shared helpers (runMenuLoop, runMenu, promptModelSelection, parseNumericInput, matchMenuChoice)
 *   - menu-model-settings.ts: showModelSettingsMenu
 *   - menu-concurrency.ts: showConcurrencySettingsMenu
 *   - menu-widget-settings.ts: showWidgetSettingsMenu
 *   - menu-running-agents.ts: showRunningAgentsMenu, showAgentActions
 *   - menu-debug.ts: showDebugMenu
 *   - menus.ts (this file): dispatcher only
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchMenuChoice } from "./menu-helpers.js";
import { showModelSettingsMenu } from "./menu-model-settings.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showRunningAgentsMenu } from "./menu-running-agents.js";
import { showDebugMenu } from "./menu-debug.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";

// Spawn wizard — imported and re-exported so the dispatcher calls it from here.
import { showSpawnAgentMenu } from "./spawn-wizard.js";
export { showSpawnAgentMenu };


export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const menuItems = [
    "1. Spawn options — Default thinking, max turns, background, grace turns, system prompt",
    "2. Model settings — Set global default and per-type model overrides",
    "3. Concurrency settings — Set per-model slot limits",
    "4. Widget settings — Configure widget display options",
    "",
    "Back",
  ];

  const handlers: Record<string, () => Promise<void>> = {
    "1": () => showSpawnOptionsMenu(ctx),
    "2": () => showModelSettingsMenu(ctx, modelOptions),
    "3": () => showConcurrencySettingsMenu(ctx, modelOptions),
    "4": () => showWidgetSettingsMenu(ctx),
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
