/**
 * menu-system-prompt.ts — System prompt settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Exports:
 *   - showSystemPromptMenu: system prompt mode, create prompt file, include AGENTS.md, per-model prompts
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, Editor } from "@earendil-works/pi-tui";
import { buildSettingsListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { SystemPromptMode } from "../../agents/types.js";
import { getStore } from "../../shell.js";
import { CUSTOM_PROMPT_PATH } from "../../config/config-io.js";

/**
 * Build a submenu that opens a multiline Editor for a per-model prompt.
 * @param ctx Extension context
 * @param store Config store
 * @param modelKey Full model string (e.g. `anthropic/claude-sonnet-4-20250514`)
 * @param currentText Current prompt text (empty string if none)
 */
function createModelPromptEditor(
  ctx: ExtensionCommandContext,
  store: ReturnType<typeof getStore>,
  modelKey: string,
  currentText: string,
): SettingItem["submenu"] {
  return (_currentValue, subDone) => {
    ctx.ui.custom((tui, theme, _kb, editorDone) => {
      const editor = new Editor(tui, {
        borderColor: (s: string) => s,
        selectList: {
          selectedPrefix: () => theme.fg("accent", "→ "),
          selectedText: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("muted", s),
          scrollInfo: (s: string) => theme.fg("dim", s),
          noMatch: (s: string) => theme.fg("dim", s),
        },
      });
      editor.setText(currentText);
      editor.onSubmit = (text: string) => {
        if (text.length > 0) {
          store.mutate.modelPrompts.setModelPrompt(modelKey, text);
          ctx.ui.notify(`Prompt saved for ${modelKey}`, "info");
        } else {
          store.mutate.modelPrompts.clearModelPrompt(modelKey);
          ctx.ui.notify(`Prompt cleared for ${modelKey}`, "info");
        }
        editorDone(undefined);
        subDone();
      };
      return editor;
    });
    return {} as any;
  };
}

export async function showSystemPromptMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const buildItems = (): SettingItem[] => {
    const items: SettingItem[] = [
      {
        id: "systemPromptMode",
        label: "System prompt mode",
        currentValue: store.agent.systemPromptMode,
        values: ["replace", "inherit", "custom"],
        description: "How the subagent system prompt is built: replace, inherit, or custom.",
      },
    ];

    // Create prompt file (only when mode is custom and file doesn't exist)
    if (store.agent.systemPromptMode === "custom" && !fs.existsSync(CUSTOM_PROMPT_PATH)) {
      items.push({
        id: "createPromptFile",
        label: "Create prompt file",
        currentValue: CUSTOM_PROMPT_PATH,
        values: ["Create"],
        description: `Create ${CUSTOM_PROMPT_PATH} with a starter template for custom mode.`,
      });
    }

    items.push(
      {
        id: "includeContextFiles",
        label: "Include AGENTS.md",
        currentValue: store.agent.includeContextFiles ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Load project and ~/.pi/agent AGENTS.md as shared <project_context>.",
      },
      {
        id: "loadSkillsImplicitly",
        label: "Load skills implicitly",
        currentValue: store.agent.loadSkillsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Give new agents all skills when frontmatter omits the field.",
      },
      {
        id: "loadExtensionsImplicitly",
        label: "Load extensions implicitly",
        currentValue: store.agent.loadExtensionsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Give new agents all extensions when frontmatter omits the field.",
      },
      {
        id: "agentToolStrictMode",
        label: "Strict schema for Agent tool",
        currentValue: store.agent.agentToolStrictMode ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Uses constrained sampling for Agent tool. Costs slightly more tokens, requires compatible provider (OpenAI Codex, etc). Requires reload.",
      },
    );

    // Per-model prompts section
    const models = ctx.modelRegistry.getAvailable();
    const modelPrompts = store.modelPrompts;
    items.push({ id: "__sep__", label: " ", currentValue: "" });
    items.push({ id: "__sep__", label: "── Per-model prompts ──", currentValue: "────────" });
    for (const model of models) {
      const modelKey = `${model.provider}/${model.id}`;
      const prompt = modelPrompts[modelKey] ?? "";
      const preview = prompt.length > 0
        ? (prompt.length > 40 ? prompt.slice(0, 40) + "..." : prompt)
        : "(none)";
      items.push({
        id: `model-prompt:${modelKey}`,
        label: modelKey,
        currentValue: preview,
        description: "Custom prompt appended for agents using this model.",
        submenu: createModelPromptEditor(ctx, store, modelKey, prompt),
      });
    }

    return items;
  };
  let items = buildItems();
  let rebuild: ((newItems: SettingItem[]) => void) | null = null;

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "systemPromptMode":
        store.mutate.agent.setSystemPromptMode(newValue as SystemPromptMode);
        ctx.ui.notify(`System prompt mode set to ${newValue}`, "info");
        // Rebuild: "custom" adds the create prompt file item, other modes remove it.
        items = buildItems();
        rebuild?.(items);
        break;
      case "createPromptFile":
        try {
          fs.mkdirSync(path.dirname(CUSTOM_PROMPT_PATH), { recursive: true });
          fs.writeFileSync(CUSTOM_PROMPT_PATH, "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously", "utf-8");
          ctx.ui.notify(`Created prompt file: ${CUSTOM_PROMPT_PATH}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to create prompt file: ${err.message}`, "error");
        }
        return;
      case "includeContextFiles":
        store.mutate.agent.setIncludeContextFiles(newValue === "ON");
        ctx.ui.notify(`Include AGENTS.md set to ${newValue}`, "info");
        break;
      case "loadSkillsImplicitly":
        store.mutate.agent.setLoadSkillsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load skills implicitly set to ${newValue}`, "info");
        break;
      case "loadExtensionsImplicitly":
        store.mutate.agent.setLoadExtensionsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load extensions implicitly set to ${newValue}`, "info");
        break;
      case "agentToolStrictMode":
        store.mutate.agent.setAgentToolStrictMode(newValue === "ON");
        ctx.ui.notify(`Agent tool strict mode ${newValue} (requires reload)`, "info");
        break;
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const settingsList = new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "System Prompt", theme, onCancel: () => done(undefined), onRebuild: (r) => { rebuild = r; } });
  });
}