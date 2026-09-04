/**
 * menu-model-settings-invalid.test.ts — Bad config values never break the
 * Model Settings menu: with an object-shaped default present the menu still
 * opens (backstop), and with a validated store it shows the fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import type { SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";
import type { ThinkingLevel } from "../../../src/types.js";

const piSettingsMock = vi.hoisted(() => ({
  getPiDefaultThinkingLevel: vi.fn<(cwd: string, agentDir?: string) => ThinkingLevel | undefined>(() => undefined),
}));

let settingsListCalls: Array<{ items: SettingItem[] }> = [];
let settingsListWrapperCalls: Array<{ component: Component; options: SettingsListWrapperOptions }> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: SettingItem[];
    constructor(
      items: SettingItem[],
      _max: number,
      _theme: SettingsListTheme,
      _onChange: (id: string, newValue: string) => void,
      _onCancel: () => void,
    ) {
      this.items = items;
      settingsListCalls.push(this);
    }
    render() {
      return [];
    }
    handleInput() {}
    updateValue() {}
  },
  SelectList: class MockSelectList {
    constructor() {}
    render() {
      return [];
    }
    handleInput() {}
  },
  Input: class MockInput {},
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: Component, options: SettingsListWrapperOptions) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() {
      return [];
    }
    handleInput() {}
    invalidate() {}
  },
}));

import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";

vi.mock("../../../src/pi-settings.js", () => piSettingsMock);

afterEach(() => {
  resetConfig();
});

describe("showModelSettingsMenu with bad config values", () => {
  beforeEach(() => {
    settingsListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("opens without throw when the default is an object (missed-check backstop)", async () => {
    (mockModules.mockConfig.agent as Record<string, unknown>).default = { model: "x" };
    const ctx = createMockCtx();
    await expect(showModelSettingsMenu(ctx, ["openai/gpt-4o"])).resolves.toBeUndefined();
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultModel")!;
    expect(item).toBeDefined();
  });

  it("opens without throw when a per-type override is an object", async () => {
    (mockModules.mockConfig.agent as Record<string, unknown>).Explore = { model: "x" };
    const ctx = createMockCtx();
    await expect(showModelSettingsMenu(ctx, ["openai/gpt-4o"])).resolves.toBeUndefined();
  });
});
