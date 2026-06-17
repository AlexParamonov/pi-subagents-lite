/**
 * menu-system-prompt.ts — System prompt settings menu concern.
 *
 * Exports:
 *   - showSystemPromptMenu: system prompt mode, create prompt file, include AGENTS.md
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SystemPromptMode } from "../../types.js";
import { runMenuLoop } from "./menu-helpers.js";
import { getStore } from "../../shell.js";
import { CUSTOM_PROMPT_PATH } from "../../agents/agent-runner.js";

export async function showSystemPromptMenu(ctx: ExtensionCommandContext): Promise<void> {
  return runMenuLoop(ctx, "System Prompt", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // System prompt mode
    const systemPromptMode = store.agent.systemPromptMode;
    items.push(`System prompt mode · ${systemPromptMode}`);
    actions.push(async () => {
      const modes: SystemPromptMode[] = ["replace", "inherit", "custom"];
      const chosen = await ctx.ui.select("System prompt mode", modes);
      if (chosen === undefined) return;
      store.mutate.agent.setSystemPromptMode(chosen);
      ctx.ui.notify(`System prompt mode set to ${chosen}`, "info");
    });

    // Create prompt file (only when mode is custom and file doesn't exist)
    if (systemPromptMode === "custom") {
      if (!fs.existsSync(CUSTOM_PROMPT_PATH)) {
        items.push("Create prompt file · ~/.pi/agent/subagents-lite-prompt.md");
        actions.push(async () => {
          try {
            fs.mkdirSync(path.dirname(CUSTOM_PROMPT_PATH), { recursive: true });
            fs.writeFileSync(CUSTOM_PROMPT_PATH, "You are a Pi, an expect coding sub-agent.\nYou have been invoked to handle a specific task autonomously", "utf-8");
            ctx.ui.notify(`Created prompt file: ${CUSTOM_PROMPT_PATH}`, "info");
          } catch (err: any) {
            ctx.ui.notify(`Failed to create prompt file: ${err.message}`, "error");
          }
        });
      }
    }

    // Include AGENTS.md toggle
    const includeContextFiles = store.agent.includeContextFiles;
    items.push(`Include AGENTS.md · ${includeContextFiles ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.agent.setIncludeContextFiles(!includeContextFiles);
      ctx.ui.notify(`Include AGENTS.md ${store.agent.includeContextFiles ? "ON" : "OFF"}`, "info");
    });

    return { items, actions };
  });
}
