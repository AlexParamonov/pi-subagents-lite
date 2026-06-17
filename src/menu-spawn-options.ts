/**
 * menu-spawn-options.ts — Spawn options menu concern.
 *
 * Exports:
 *   - showSpawnOptionsMenu: default spawn-time options (thinking, max turns, force background, grace turns, system prompt mode, include AGENTS.md)
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SystemPromptMode, ThinkingLevel } from "./types.js";
import { runMenuLoop, parseNumericInput } from "./menu-helpers.js";
import { getStore } from "./shell.js";
import { CUSTOM_PROMPT_PATH } from "./agent-runner.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export async function showSpawnOptionsMenu(ctx: ExtensionCommandContext): Promise<void> {
  return runMenuLoop(ctx, "Spawn Options", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // Thinking level
    const defaultThinking = store.agent.defaultThinking;
    items.push(`Thinking level · ${defaultThinking ?? "inherit"}`);
    actions.push(async () => {
      const allLevels = [...THINKING_LEVELS, "inherit"];
      const chosen = await ctx.ui.select("Default thinking level", allLevels);
      if (chosen === undefined) return;
      const level = chosen === "inherit" ? undefined : (chosen as ThinkingLevel);
      store.mutate.agent.setDefaultThinking(level);
      ctx.ui.notify(`Default thinking level set to ${level ?? "inherit"}`, "info");
    });

    // Max turns
    const defaultMaxTurns = store.agent.defaultMaxTurns;
    items.push(`Max turns · ${defaultMaxTurns != null ? String(defaultMaxTurns) : "unlimited"}`);
    actions.push(async () => {
      const initial = defaultMaxTurns != null ? String(defaultMaxTurns) : "unlimited";
      const input = await ctx.ui.input("Default max turns (number or 'unlimited')", initial);
      if (input === undefined) return;
      const trimmed = input.trim().toLowerCase();
      if (trimmed === "unlimited" || trimmed === "") {
        store.mutate.agent.setDefaultMaxTurns(undefined);
        ctx.ui.notify("Default max turns set to unlimited", "info");
      } else {
        const parsed = parseInt(trimmed, 10);
        if (isNaN(parsed) || parsed < 1) {
          ctx.ui.notify("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
          return;
        }
        store.mutate.agent.setDefaultMaxTurns(parsed);
        ctx.ui.notify(`Default max turns set to ${parsed}`, "info");
      }
    });

    // Force background toggle
    const forceBg = store.agent.forceBackground;
    items.push(`Force background · ${forceBg ? "ON" : "OFF"}`);
    actions.push(async () => {
      store.mutate.agent.setForceBackground(!forceBg);
      ctx.ui.notify(`Force background ${store.agent.forceBackground ? "ON" : "OFF"}`, "info");
    });

    // Grace turns
    const graceTurns = store.agent.graceTurns;
    items.push(`Grace turns · ${graceTurns}`);
    actions.push(async () => {
      const parsed = await parseNumericInput(ctx, "Grace turns (≥ 0)", String(graceTurns), 0, "≥ 0");
      if (parsed === undefined) return;
      store.mutate.agent.setGraceTurns(parsed);
      ctx.ui.notify(`Grace turns set to ${parsed}`, "info");
    });

    // System prompt mode
    const systemPromptMode = store.agent.systemPromptMode;
    items.push(`System prompt mode · ${systemPromptMode}`);
    actions.push(async () => {
      const choices = [
        "replace — generic header + env + agent's systemPrompt (current)",
        "inherit — parent's full system prompt (verbatim) + env + agent's systemPrompt",
        "custom — content of ~/.pi/agent/subagents-lite-prompt.md + env + agent's systemPrompt",
      ];
      const choice = await ctx.ui.select("System prompt mode", choices);
      if (choice === undefined) return;
      let mode: SystemPromptMode;
      if (choice.startsWith("replace")) mode = "replace";
      else if (choice.startsWith("inherit")) mode = "inherit";
      else mode = "custom";
      store.mutate.agent.setSystemPromptMode(mode);
      ctx.ui.notify(`System prompt mode set to ${mode}`, "info");
    });

    // Offer to create custom prompt file if mode is custom but file doesn't exist
    if (systemPromptMode === "custom") {
      if (!fs.existsSync(CUSTOM_PROMPT_PATH)) {
        items.push("Create prompt file · ~/.pi/agent/subagents-lite-prompt.md");
        actions.push(async () => {
          try {
            fs.mkdirSync(path.dirname(CUSTOM_PROMPT_PATH), { recursive: true });
            fs.writeFileSync(CUSTOM_PROMPT_PATH, "You are Pi, an expert coding assistant. Think thoroughly. Write concisely.", "utf-8");
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
