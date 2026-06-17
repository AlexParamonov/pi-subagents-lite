/**
 * menu-widget-settings.ts — Widget settings menu concern.
 *
 * Exports:
 *   - showWidgetSettingsMenu: compact mode, max lines (full/compact), Ctrl+o shortcut
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runMenuLoop, parseNumericInput } from "./menu-helpers.js";
import { getStore } from "../../shell.js";

export async function showWidgetSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  return runMenuLoop(ctx, "Widget Settings", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // Force compact mode toggle
    const isForceCompact = store.agent.widgetCompact;
    items.push(`Force compact mode · ${isForceCompact ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.widget.setCompact(!isForceCompact);
      ctx.ui.notify(`Force compact mode ${store.agent.widgetCompact ? "ON" : "OFF"}`, "info");
    });

    // Max lines (full mode)
    const maxLines = store.agent.widgetMaxLines;
    items.push(`Max lines (full) · ${maxLines}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (full mode, ≥ 2)", String(maxLines), 2, "≥ 2");
      if (parsed === undefined) return;
      store.mutate.widget.setMaxLines(parsed);
      ctx.ui.notify(`Max lines (full) set to ${parsed}`, "info");
    });

    // Max lines (compact mode)
    const maxLinesCompact = store.agent.widgetMaxLinesCompact;
    items.push(`Max lines (compact) · ${maxLinesCompact}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Max lines (compact mode, ≥ 1)", String(maxLinesCompact), 1, "≥ 1");
      if (parsed === undefined) return;
      store.mutate.widget.setMaxLinesCompact(parsed);
      ctx.ui.notify(`Max lines (compact) set to ${parsed}`, "info");
    });

    // Ctrl+o shortcut toggle
    const shortcutEnabled = store.agent.widgetShortcut;
    items.push(`Ctrl+o shortcut · ${shortcutEnabled ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.widget.setShortcut(!shortcutEnabled);
      ctx.ui.notify(`Ctrl+o shortcut ${store.agent.widgetShortcut ? "ON" : "OFF"}`, "info");
    });

    return { items, actions };
  });
}
