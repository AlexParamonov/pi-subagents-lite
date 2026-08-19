/**
 * menu-general-settings.ts — General settings menu concern.
 *
 * Groups misc display/behavior settings that don't belong in Widget or
 * Spawn Options. Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 *
 * Settings:
 *   - showAgentColors: toggle agent color rendering globally
 *   - showCompletionCards: (moved from Widget > Behavior)
 *   - agentStatusLimit: (moved from Widget > Behavior)
 *   - thinkingBuffer: (moved from Widget > Behavior)
 *   - outputTranscript: (moved from Spawn Options)
 *
 * Exports:
 *   - showGeneralSettingsMenu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { SEPARATOR_ID, buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";
import { canonicalAgentStatusLimit } from "../../config/config-io.js";

function buildItems(ctx: ExtensionCommandContext, store: ReturnType<typeof getStore>): SettingItem[] {
  return [
    {
      id: "showAgentColors",
      label: "Agent colors",
      currentValue: store.agent.showAgentColors ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Enable colored spinner frames, status icons, and picker bullets.",
    },
    {
      id: "showCompletionCards",
      label: "Show completion cards",
      currentValue: store.agent.showCompletionCards ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Show background-agent completion cards in the transcript; turn OFF to hide them.",
    },
    {
      id: "agentStatusLimit",
      label: "Agent status settled limit",
      currentValue: String(canonicalAgentStatusLimit(store.agentConfigSnapshot().agentStatusLimit)),
      submenu: createNumericSubmenu(ctx, { min: 0 }, (parsed) => {
        store.mutate.agent.setAgentStatusLimit(parsed);
        ctx.ui.notify(`Agent status settled limit set to ${parsed}`, "info");
      }),
      description: "Max settled agents AgentStatus lists. 0 = auto (2 × default concurrency).",
    },
    {
      id: "thinkingBuffer",
      label: "Log file thinking buffer",
      currentValue: store.agent.outputThinkingBufferSize === 0 ? "OFF" : String(store.agent.outputThinkingBufferSize),
      values: ["OFF", "80", "200", "500", "1000"],
      description: "Controls log file thinking buffering in chars. OFF = only at turn end, 80 = flush after 80 chars.",
    },
    { id: SEPARATOR_ID, label: " ", currentValue: "" },
    {
      id: "outputTranscript",
      label: "Output transcript",
      currentValue: store.agent.outputTranscript ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Write streaming transcript to /tmp/pi-agent-outputs/<agentId>.log (frontmatter overrides).",
    },
  ];
}

/**
 * Rebuild cached chat cards via the only host lever: flipping the tool-output
 * expansion state triggers setExpanded on every expandable chat component, which
 * re-runs the message renderer (its result is otherwise cached). The double flip
 * restores the original state. No-op on hosts without the expansion API.
 */
function refreshChatComponents(ctx: ExtensionCommandContext): void {
  if (typeof ctx.ui.getToolsExpanded !== "function" || typeof ctx.ui.setToolsExpanded !== "function") return;
  const expanded = ctx.ui.getToolsExpanded();
  ctx.ui.setToolsExpanded(!expanded);
  ctx.ui.setToolsExpanded(expanded);
}

export async function showGeneralSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "showAgentColors":
        store.mutate.agent.setShowAgentColors(newValue === "ON");
        ctx.ui.notify(`Agent colors ${newValue}`, "info");
        break;
      case "showCompletionCards":
        store.mutate.widget.setShowCompletionCards(newValue === "ON");
        refreshChatComponents(ctx);
        ctx.ui.notify(`Show completion cards ${newValue}`, "info");
        break;
      case "thinkingBuffer":
        store.mutate.agent.setOutputThinkingBufferSize(newValue === "OFF" ? 0 : Number(newValue));
        ctx.ui.notify(`Thinking buffer ${newValue}`, "info");
        break;
      case "outputTranscript":
        store.mutate.agent.setOutputTranscript(newValue === "ON");
        ctx.ui.notify(`Output transcript set to ${newValue}`, "info");
        break;
      case "agentStatusLimit":
        // Handled by numeric submenu
        break;
    }
  };

  let rebuild: ((items: any[]) => void) | undefined;

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items = buildItems(ctx, store);
    const settingsList = new SettingsList(
      items,
      15,
      buildSettingsListTheme(theme),
      (id, newValue) => {
        onChange(id, newValue);
        if (items.some((i) => i.id === id && i.submenu)) rebuild?.(buildItems(ctx, getStore()));
      },
      () => done(undefined),
    );
    return new SettingsListWrapper(settingsList, {
      title: "General Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
