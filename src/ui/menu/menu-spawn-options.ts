/**
 * menu-spawn-options.ts — Spawn options menu concern.
 *
 * Exports:
 *   - showSpawnOptionsMenu: default spawn-time options (thinking, max turns, force background, grace turns, system prompt mode, include AGENTS.md)
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../types.js";
import { runMenuLoop, parseNumericInput } from "./menu-helpers.js";
import { getStore } from "../../shell.js";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export async function showSpawnOptionsMenu(ctx: ExtensionCommandContext): Promise<void> {
  return runMenuLoop(ctx, "Spawn Options", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

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

    // Default max turns
    const defaultMaxTurns = store.agent.defaultMaxTurns;
    items.push(`Default max turns · ${defaultMaxTurns != null ? String(defaultMaxTurns) : "unlimited"}`);
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

    // Default thinking level
    const defaultThinking = store.agent.defaultThinking;
    items.push(`Default thinking level · ${defaultThinking ?? "inherit"}`);
    actions.push(async () => {
      const allLevels = [...THINKING_LEVELS, "inherit"];
      const chosen = await ctx.ui.select("Default thinking level", allLevels);
      if (chosen === undefined) return;
      const level = chosen === "inherit" ? undefined : (chosen as ThinkingLevel);
      store.mutate.agent.setDefaultThinking(level);
      ctx.ui.notify(`Default thinking level set to ${level ?? "inherit"}`, "info");
    });

    return { items, actions };
  });
}
