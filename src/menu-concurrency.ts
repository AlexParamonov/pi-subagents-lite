/**
 * menu-concurrency.ts — Concurrency settings menu concern.
 *
 * Exports:
 *   - showConcurrencySettingsMenu: per-provider and per-model slot limits
 *
 * Private helpers (single-consumer, co-located):
 *   - parseConcurrencyInput: parse and validate concurrency input (≥ 1)
 *   - promptConcurrencyInput: prompt for concurrency value and apply via setter
 *   - promptAddConcurrencyLimit: prompt to add a new concurrency limit for a named entity
 *   - editOrRemoveConcurrencyEntry: sub-menu for editing or removing a per-provider/per-model entry
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runMenuLoop, runMenu, promptModelSelection, parseNumericInput } from "./menu-helpers.js";
import { getStore } from "./shell.js";

/**
 * Parse a concurrency input: prompt, validate (integer ≥ 1), return parsed value or undefined.
 */
async function parseConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  initialValue: string,
): Promise<number | undefined> {
  return parseNumericInput(ctx, label, initialValue, 1, "≥ 1");
}

/**
 * Prompt for a concurrency value, validate, and apply via setter.
 * The setter handles save + sync internally.
 */
async function promptConcurrencyInput(
  ctx: ExtensionCommandContext,
  label: string,
  currentValue: number,
  setter: (value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, label, String(currentValue));
  if (parsed === undefined) return;
  setter(parsed);
  ctx.ui.notify(
    `${label.replace("Concurrency slots for ", "")} concurrency set to ${parsed}`,
    "info",
  );
}

/**
 * Prompt to add a new concurrency limit for a named entity.
 * Calls the setter which handles save + sync internally.
 */
async function promptAddConcurrencyLimit(
  ctx: ExtensionCommandContext,
  label: string,
  setter: (key: string, value: number) => void,
): Promise<void> {
  const parsed = await parseConcurrencyInput(ctx, "Concurrency slots", "1");
  if (parsed === undefined) return;
  setter(label, parsed);
  ctx.ui.notify(`${label} concurrency set to ${parsed}`, "info");
}

/**
 * Build a sub-menu for a single per-provider or per-model entry:
 * "Edit limit" to change the value, or "Remove limit" to delete it.
 * Callers pass setter callbacks that handle save + sync internally.
 */
async function editOrRemoveConcurrencyEntry(
  ctx: ExtensionCommandContext,
  label: string,
  entityType: "provider" | "model",
  entityKey: string,
  currentValue: number,
  setEntry: (key: string, value: number) => void,
  removeEntry: () => void,
): Promise<void> {
  await runMenu(ctx, `${entityKey} concurrency`, [
    "Edit limit",
    "Remove limit",
  ], [
    async () => {
      await promptConcurrencyInput(
        ctx, entityKey, currentValue,
        (value) => setEntry(entityKey, value),
      );
    },
    async () => {
      removeEntry();
      ctx.ui.notify(
        `Removed per-${entityType} limit for ${entityKey}`,
        "info",
      );
    },
  ]);
}

export async function showConcurrencySettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const providers = [...new Set(modelOptions.map((m) => m.split("/")[0]))].sort();

  return runMenuLoop(ctx, "Concurrency Settings", () => {
    const items: string[] = [];
    const actions: Array<() => Promise<void>> = [];
    const store = getStore();

    // Global default
    items.push(`Default concurrency limit · ${store.concurrency.default}`);
    actions.push(async () => {
      await promptConcurrencyInput(
        ctx, "Default limit", store.concurrency.default,
        (value) => store.mutate.concurrency.setDefault(value),
      );
    });

    // Reset all to defaults
    items.push("Reset all to defaults");
    actions.push(async () => {
      store.mutate.concurrency.reset();
      ctx.ui.notify("Concurrency reset to defaults", "info");
    });

    // ── Per-provider limits ──
    const providerLimits = store.concurrency.providers;
    const configuredProviders = Object.keys(providerLimits);
    if (configuredProviders.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── per-provider limits ───");
      actions.push(async () => {}); // separator

      for (const provider of configuredProviders) {
        const limit = providerLimits[provider];
        items.push(`${provider}  ·  ${limit} slots`);
        actions.push(async () => {
          await editOrRemoveConcurrencyEntry(
            ctx,
            `Concurrency slots for ${provider}`,
            "provider",
            provider,
            limit,
            (key, value) => store.mutate.concurrency.setProvider(key, value),
            () => store.mutate.concurrency.removeProvider(provider),
          );
        });
      }
    }

    // Add per-provider limit
    items.push("Add per-provider limit...");
    actions.push(async () => {
      const provider = await ctx.ui.select("Select provider", providers);
      if (provider === undefined) return;
      await promptAddConcurrencyLimit(
        ctx, provider,
        (key, value) => store.mutate.concurrency.setProvider(key, value),
      );
    });

    // ── Per-model limits ──
    const models = store.concurrency.models;
    const modelKeys = Object.keys(models);
    if (modelKeys.length > 0) {
      items.push("");
      actions.push(async () => {});
      items.push("─── per-model limits ───");
      actions.push(async () => {}); // separator

      for (const modelKey of modelKeys) {
        const limit = models[modelKey];
        items.push(`${modelKey}  ·  ${limit} slots`);
        actions.push(async () => {
          await editOrRemoveConcurrencyEntry(
            ctx,
            `Concurrency slots for ${modelKey}`,
            "model",
            modelKey,
            limit,
            (key, value) => store.mutate.concurrency.setModel(key, value),
            () => store.mutate.concurrency.removeModel(modelKey),
          );
        });
      }
    }

    // Add per-model limit
    items.push("Add per-model limit...");
    actions.push(async () => {
      const modelKey = await promptModelSelection(
        ctx, modelOptions, store.agent.defaultModel ?? "(inherits parent)",
      );
      if (modelKey === null) return;
      await promptAddConcurrencyLimit(
        ctx, modelKey.trim(),
        (key, value) => store.mutate.concurrency.setModel(key, value),
      );
    });

    return { items, actions };
  });
}
