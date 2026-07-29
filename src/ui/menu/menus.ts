/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 * No nested ctx.ui.custom calls.
 *
 * Module structure:
 *   - helpers.ts: shared helpers (buildSettingsListTheme, buildSelectListTheme, validateNumeric)
 *   - menu-model-settings.ts: showModelSettingsMenu
 *   - menu-concurrency.ts: showConcurrencySettingsMenu
 *   - menu-appearance.ts: showAppearanceMenu
 *   - menu-execution.ts: showExecutionMenu
 *   - menu-widget-settings.ts: showWidgetSettingsMenu
 *   - menu-running-agents.ts: showRunningAgentsMenu
 *   - menu-debug.ts: showDiagnosticsMenu
 *   - menu-spawn-options.ts: showSpawnOptionsMenu
 *   - menu-system-prompt.ts: showSystemPromptMenu
 *   - menus.ts (this file): dispatcher — main menu and settings menu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { showModelSettingsMenu } from "./menu-model-settings.js";
import { showConcurrencySettingsMenu } from "./menu-concurrency.js";
import { showAppearanceMenu } from "./menu-appearance.js";
import { showExecutionMenu } from "./menu-execution.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showRunningAgentsMenu } from "./menu-running-agents.js";
import { showDiagnosticsMenu } from "./menu-debug.js";
import { showSpawnOptionsMenu } from "./menu-spawn-options.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";

// Spawn wizard — co-located in this folder.
import { showSpawnAgentMenu } from "./menu-spawn-wizard.js";
export { showSpawnAgentMenu };


/**
 * Render `items` as a titled SelectList and dispatch the chosen value.
 * Re-loops after each dispatch until the user cancels (Esc or Back).
 * Each iteration builds a fresh list so state never leaks between visits.
 */
async function runSelectMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  dispatch: (choice: string) => Promise<void>,
): Promise<void> {
  while (true) {
    const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const list = new SelectList([...items], 10, buildSelectListTheme(theme));
      list.onSelect = (item) => done(item.value);
      return new SettingsListWrapper(list, { title, theme, onCancel: () => done(undefined) });
    });
    if (choice === undefined) return;
    await dispatch(choice);
  }
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SelectItem[] = [
    { value: "models", label: "Agent settings", description: "Set global and per-agent model/thinking overrides" },
    { value: "execution", label: "Execution", description: "Default concurrency, background mode, and max turns" },
    { value: "appearance", label: "Appearance", description: "Widget size, compact mode, model/thinking, and stats preset" },
    { value: "advanced", label: "Advanced", description: "Limits, prompts, behavior, detailed widget settings, diagnostics" },
  ];

  await runSelectMenu(ctx, "Settings", items, async (choice) => {
    switch (choice) {
      case "models": await showModelSettingsMenu(ctx, modelOptions); break;
      case "execution": await showExecutionMenu(ctx); break;
      case "appearance": await showAppearanceMenu(ctx); break;
      case "advanced": await showAdvancedMenu(ctx, modelOptions); break;
    }
  });
}

async function showAdvancedMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SelectItem[] = [
    { value: "concurrency", label: "Concurrency limits", description: "Per-provider and per-model agent slot limits" },
    { value: "systemprompt", label: "System prompt, context, skills & extensions", description: "Prompt mode and implicit loading defaults" },
    { value: "behavior", label: "Agent behavior & discovery", description: "Grace turns and built-in agent discovery" },
    { value: "widget", label: "Detailed widget settings", description: "Compact lines, descriptions, shortcuts, retention, and stat toggles" },
    { value: "diagnostics", label: "Diagnostics", description: "Inspect discovered agent types" },
  ];

  await runSelectMenu(ctx, "Advanced", items, async (choice) => {
    switch (choice) {
      case "concurrency": await showConcurrencySettingsMenu(ctx, modelOptions, {
        includeDefault: false,
        resetDefault: false,
        title: "Concurrency Limits",
      }); break;
      case "systemprompt": await showSystemPromptMenu(ctx); break;
      case "behavior": await showSpawnOptionsMenu(ctx, "behavior"); break;
      case "widget": await showWidgetSettingsMenu(ctx); break;
      case "diagnostics": await showDiagnosticsMenu(ctx); break;
    }
  });
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items: SelectItem[] = [
    { value: "running", label: "Running agents", description: "List running, queued, and completed agents" },
    { value: "spawn", label: "Spawn agent", description: "Manually spawn a new agent" },
    { value: "settings", label: "Settings", description: "Models, execution, appearance, and advanced settings" },
  ];

  await runSelectMenu(ctx, "Agents", items, async (choice) => {
    switch (choice) {
      case "running": await showRunningAgentsMenu(ctx); break;
      case "spawn": await showSpawnAgentMenu(ctx, modelOptions); break;
      case "settings": await showSettingsMenu(ctx, modelOptions); break;
    }
  });
}
