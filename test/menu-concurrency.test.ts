/**
 * menu-concurrency.test.ts — Tests for showConcurrencySettingsMenu.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showConcurrencySettingsMenu } from "../src/ui/menu/menu-concurrency.js";

function resetConfig(): void {
  mockModules.mockConfig.concurrency = { default: 4 };
}

describe("showConcurrencySettingsMenu — remove limit", () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  describe("per-provider remove limit", () => {
    it("removes a per-provider limit when 'Remove limit' is selected", async () => {
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2 };
      const selections = [
        "llamacpp  ·  2 slots",
        "Remove limit",
        undefined,
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "llamacpp/4b"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency.providers).toEqual({});
      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Removed per-provider limit for llamacpp",
        "info",
      );
    });

    it("preserves other providers when one is removed", async () => {
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2, openai: 5 };

      const selections = [
        "openai  ·  5 slots",
        "Remove limit",
        undefined,
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b", "openai/gpt-4o"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(2);
      expect(mockModules.mockConfig.concurrency.providers!.openai).toBeUndefined();
    });
  });

  describe("per-model remove limit", () => {
    it("removes a per-model limit when 'Remove limit' is selected", async () => {
      mockModules.mockConfig.concurrency.models = { "llamacpp/4b": 3 };

      const selections = [
        "llamacpp/4b  ·  3 slots",
        "Remove limit",
        undefined,
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBeUndefined();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Removed per-model limit for llamacpp/4b",
        "info",
      );
    });
  });

  describe("reset all to defaults", () => {
    it("clears all per-provider and per-model limits when 'Reset all to defaults' is selected", async () => {
      mockModules.mockConfig.concurrency = {
        default: 4,
        providers: { llamacpp: 2, openai: 5 },
        models: { "llamacpp/4b": 3, "openai/gpt-4o": 1 },
      };

      const selections = [
        "Reset all to defaults",
        undefined,
      ];

      const ctx = createMockCtx(selections);
      const modelOptions = ["llamacpp/4b", "openai/gpt-4o"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency).toEqual({ default: 4 });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Concurrency reset to defaults",
        "info",
      );
    });
  });

  describe("edit limit still works", () => {
    it("edits a per-provider limit when 'Edit limit' is selected", async () => {
      mockModules.mockConfig.concurrency.providers = { llamacpp: 2 };

      const selections = [
        "llamacpp  ·  2 slots",
        "Edit limit",
        undefined,
      ];

      const inputs = ["5"];

      const ctx = createMockCtx(selections, inputs);
      const modelOptions = ["llamacpp/4b"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(5);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "llamacpp concurrency set to 5",
        "info",
      );
    });

    it("edits a per-model limit when 'Edit limit' is selected", async () => {
      mockModules.mockConfig.concurrency.models = { "llamacpp/4b": 1 };

      const selections = [
        "llamacpp/4b  ·  1 slots",
        "Edit limit",
        undefined,
      ];

      const inputs = ["8"];

      const ctx = createMockCtx(selections, inputs);
      const modelOptions = ["llamacpp/4b"];

      await showConcurrencySettingsMenu(ctx, modelOptions);

      expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBe(8);
    });
  });
});
