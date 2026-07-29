/** Diagnostics menu: inspect discovered agent types. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import { buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

async function showAgentTypes(ctx: ExtensionCommandContext): Promise<void> {
  const types = getAllTypes();
  if (types.length === 0) {
    ctx.ui.notify("No agent types available", "info");
    return;
  }

  const lines: string[] = ["Available agent types:\n"];
  for (const name of types) {
    const cfg = getAgentConfig(name);
    if (!cfg) continue;
    const hidden = cfg.hidden === true ? " [HIDDEN]" : "";
    const model = cfg.model ? `  Model: ${cfg.model}` : "";
    const tools = cfg.registeredTools
      ? `  Tools: ${cfg.registeredTools.join(", ")}`
      : "  Tools: all built-in tools";
    const source = cfg.source ? `  Source: ${cfg.source}` : "";
    lines.push(`  ${name}${hidden}`);
    lines.push(`    ${cfg.description}`);
    if (model) lines.push(model);
    lines.push(tools);
    if (source) lines.push(source);
    lines.push("");
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showDiagnosticsMenu(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      { value: "agent-types", label: "Agent types", description: "List available agent types and their configs" },
    ];
    const list = new SelectList(items, 10, buildSelectListTheme(theme));
    list.onSelect = async () => showAgentTypes(ctx);
    return new SettingsListWrapper(list, { title: "Diagnostics", theme, onCancel: () => done(undefined) });
  });
}
