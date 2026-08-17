/**
 * menu-concurrency.test.ts — Tests for showConcurrencySettingsMenu using SettingsList.
 *
 * Uses ctx.ui.custom with SettingsList. Limits are target-level (session/global/
 * project per ADR-0008) with a nested level picker for remove/clear.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig, selectDialogInstances } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import type { Component, SelectItem, SettingItem, SettingsListTheme, SelectListTheme } from "@earendil-works/pi-tui";
import type { SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";

let settingsListCalls: Array<{
  items: SettingItem[];
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  submenuComponent: Component | null;
  activate: (id: string) => void;
}> = [];
let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
}> = [];
let selectListInstances: Array<{
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}> = [];

vi.mock("@earendil-works/pi-tui", async () => {
  const { activatePickerRow } = await import("../../menu-picker-helpers.js");
  return {
    SettingsList: class MockSettingsList {
      items: SettingItem[];
      onChange: (id: string, newValue: string) => void;
      onCancel: () => void;
      submenuComponent: Component | null = null;
      constructor(
        items: SettingItem[],
        _max: number,
        _theme: SettingsListTheme,
        onChange: (id: string, newValue: string) => void,
        onCancel: () => void,
      ) {
        this.items = items;
        this.onChange = onChange;
        this.onCancel = onCancel;
        settingsListCalls.push(this);
      }
      render() {
        return this.submenuComponent ? this.submenuComponent.render(80) : [];
      }
      handleInput() {}
      activate(id: string) {
        activatePickerRow(this, id);
      }
    },
    SelectList: class MockSelectList {
      items: SelectItem[];
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
      constructor(items: SelectItem[], _maxVisible: number, _theme: SelectListTheme) {
        this.items = items;
        selectListInstances.push(this);
      }
      render() {
        return [];
      }
      handleInput() {}
    },
    Input: class MockInput {
      value = "";
      onSubmit?: (v: string) => void;
      onEscape?: () => void;
      setValue(v: string) {
        this.value = v;
      }
      getValue() {
        return this.value;
      }
      constructor() {
        inputInstances.push(this);
      }
    },
  };
});

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(_component: Component, _options: SettingsListWrapperOptions) {}
    render() {
      return [];
    }
    handleInput() {}
    invalidate() {}
  },
}));

// Import AFTER mock setup
import { showConcurrencySettingsMenu } from "../../../src/ui/menu/menu-concurrency.js";

afterEach(() => resetConfig());

function resetMenuState(): void {
  settingsListCalls = [];
  inputInstances = [];
  selectListInstances = [];
  vi.clearAllMocks();
}

describe("showConcurrencySettingsMenu — SettingsList migration", () => {
  beforeEach(() => {
    resetConfig();
    resetMenuState();
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows default concurrency with current value", async () => {
    mockModules.mockConfig.concurrency = { default: 4 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultConcurrency")!;
    expect(item.currentValue).toBe("4");
  });

  it("tags a session-sourced default with [session]", async () => {
    mockModules.mockSessionConcurrency.default = 9;
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultConcurrency")!;
    expect(item.currentValue).toBe("9 [session]");
  });

  it("tags a project-sourced provider limit with [project]", async () => {
    mockModules.mockProjectConfig.concurrency.providers = { llamacpp: 2 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    expect(item.currentValue).toBe("2 slots [project]");
  });

  it("sets the default at a target level via the picker", async () => {
    mockModules.mockProjectTargetOffered = true;
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultConcurrency")!;
    const done = vi.fn();
    item.submenu!("4", done);

    // Set at a target level → value input (no separate mode list)
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList.items.map((i) => i.id)).toEqual(["session", "global", "project", "clear"]);
    modeList.activate("project");

    const input = inputInstances[inputInstances.length - 1];
    expect(input.value).toBe("4");
    input.onSubmit!("6");

    expect(mockModules.mockProjectConfig.concurrency.default).toBe(6);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("6"), "info");
    expect(done).toHaveBeenCalledWith("6");
  });

  it("remove default limit — nested target pick removes at the picked level", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.concurrency = { default: 4 };
    mockModules.mockProjectConfig.concurrency.default = 8;
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultConcurrency")!;
    const done = vi.fn();
    item.submenu!("8", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i) => i.id)).toEqual(["global", "project", "all"]);
    targetList.activate("project");

    expect(mockModules.mockProjectConfig.concurrency.default).toBeUndefined();
    expect(mockModules.mockConfig.concurrency.default).toBe(4);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(done).toHaveBeenCalledWith("project");
  });

  it("hides Clear when no layer carries the default", async () => {
    mockModules.mockConfig.concurrency = {};
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "defaultConcurrency")!;
    const done = vi.fn();
    item.submenu!("4", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList.items.map((i) => i.id)).toEqual(["session", "global"]);
  });

  it("styles section headers like the model settings menu", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const items = settingsListCalls[0].items;
    // Section headers are bare labels, styled by the theme like model settings.
    expect(items.some((i) => i.label === "Per-provider limits")).toBe(true);
    expect(items.some((i) => i.label === "Per-model limits")).toBe(true);
  });
});

describe("showConcurrencySettingsMenu — per-provider limits", () => {
  beforeEach(() => {
    resetConfig();
    resetMenuState();
  });

  it("shows configured per-provider limits as items", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).toContain("provider:llamacpp");
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    expect(item.currentValue).toMatch(/^2\s+slots?$/);
  });

  it("edit provider limit submenu shows Set targets plus Clear", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    const done = vi.fn();
    item.submenu!("2", done);
    // Submenu lists Set targets plus Clear (no separate mode list)
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList).toBeDefined();
    expect(modeList.items.map((i) => i.id)).toEqual(["session", "global", "clear"]);
  });

  it("remove provider limit — nested target pick removes at the picked level", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    mockModules.mockProjectConfig.concurrency.providers = { llamacpp: 3 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    const done = vi.fn();
    item.submenu!("2", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i) => i.id)).toEqual(["global", "project", "all"]);
    targetList.activate("project");

    expect(mockModules.mockProjectConfig.concurrency.providers!.llamacpp).toBeUndefined();
    expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(done).toHaveBeenCalledWith("project");
  });

  it("remove target pick offers only the level carrying the provider entry", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockProjectConfig.concurrency.providers = { llamacpp: 2 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    const done = vi.fn();
    item.submenu!("2", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("clear");
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i) => i.id)).toEqual(["project"]);
  });

  it("edit provider limit — target pick then Input applies at the picked level", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "provider:llamacpp")!;
    const done = vi.fn();
    const proxy = item.submenu!("2", done);

    expect(proxy.render(80)).toEqual([]);

    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("session");

    const input = inputInstances[inputInstances.length - 1];
    expect(input).toBeDefined();
    expect(input.value).toBe("2");

    proxy.handleInput!("5\r");
    input.onSubmit!("5");
    expect(mockModules.mockSessionConcurrency.providers!.llamacpp).toBe(5);
    expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(done).toHaveBeenCalledWith("5");
  });

  it("add provider limit — pick, target, then value", async () => {
    mockModules.mockProjectTargetOffered = true;
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "addProviderLimit")!;
    const done = vi.fn();
    item.submenu!("", done);

    const selector = selectDialogInstances[selectDialogInstances.length - 1];
    selector.callbacks.onSelect("llamacpp");

    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("project");

    const input = inputInstances[inputInstances.length - 1];
    input.onSubmit!("3");

    expect(mockModules.mockProjectConfig.concurrency.providers!.llamacpp).toBe(3);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(done).toHaveBeenCalledWith("3");
  });
});

describe("showConcurrencySettingsMenu — per-model limits", () => {
  beforeEach(() => {
    resetConfig();
    resetMenuState();
  });

  it("shows configured per-model limits as items", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 3 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).toContain("model:llamacpp/4b");
    const item = settingsListCalls[0].items.find((i) => i.id === "model:llamacpp/4b")!;
    expect(item.currentValue).toMatch(/^3\s+slots?$/);
  });

  it("edit model limit submenu shows Set targets plus Clear", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 1 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "model:llamacpp/4b")!;
    const done = vi.fn();
    item.submenu!("1", done);
    const modeList = settingsListCalls[settingsListCalls.length - 1];
    expect(modeList).toBeDefined();
    expect(modeList.items.map((i) => i.id)).toEqual(["session", "global", "clear"]);
  });

  it("edit model limit — target pick then Input applies at the picked level", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 1 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "model:llamacpp/4b")!;
    const done = vi.fn();
    const proxy = item.submenu!("1", done);

    expect(proxy.render(80)).toEqual([]);

    const modeList = settingsListCalls[settingsListCalls.length - 1];
    modeList.activate("global");

    const input = inputInstances[inputInstances.length - 1];
    expect(input.value).toBe("1");

    proxy.handleInput!("8\r");
    input.onSubmit!("8");
    expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBe(8);
    expect(done).toHaveBeenCalledWith("8");
  });
});

describe("showConcurrencySettingsMenu — clear all limits per target", () => {
  beforeEach(() => {
    resetConfig();
    resetMenuState();
  });

  it("clear all — target pick then confirm clears the picked level", async () => {
    mockModules.mockConfig.concurrency = {
      default: 4,
      providers: { llamacpp: 2, openai: 5 },
      models: { "llamacpp/4b": 3, "openai/gpt-4o": 1 },
    };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "resetAll")!;
    const done = vi.fn();
    item.submenu!("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i) => i.id)).toEqual(["global"]);
    targetList.activate("global");

    const confirmList = selectListInstances[selectListInstances.length - 1];
    expect(confirmList).toBeDefined();
    confirmList.onSelect!({ value: "Yes", label: "Yes" });

    expect(mockModules.mockConfig.concurrency).toEqual({});
    expect(mockModules.mockSessionConcurrency).toEqual({});
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("clear all at project clears only the project layer", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    mockModules.mockProjectConfig.concurrency = { default: 8, providers: { llamacpp: 3 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "resetAll")!;
    const done = vi.fn();
    item.submenu!("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("project");
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes", label: "Yes" });

    expect(mockModules.mockProjectConfig.concurrency).toEqual({});
    expect(mockModules.mockConfig.concurrency).toEqual({ default: 4, providers: { llamacpp: 2 } });
  });

  it("clear all at session clears only the session layer", async () => {
    mockModules.mockSessionConcurrency = { default: 9, providers: { llamacpp: 3 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i) => i.id === "resetAll")!;
    const done = vi.fn();
    item.submenu!("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    targetList.activate("session");
    const confirmList = selectListInstances[selectListInstances.length - 1];
    confirmList.onSelect!({ value: "Yes", label: "Yes" });

    expect(mockModules.mockSessionConcurrency).toEqual({});
    expect(mockModules.mockConfig.concurrency).toEqual({ default: 4 });
  });

  it("hides Clear all when no layer carries any concurrency entry", async () => {
    mockModules.mockConfig.concurrency = {};
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).not.toContain("resetAll");
  });

  it("clear all offers All levels when two layers carry entries", async () => {
    mockModules.mockConfig.concurrency = { default: 4 };
    mockModules.mockSessionConcurrency = { default: 9 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i) => i.id === "resetAll")!;
    const done = vi.fn();
    item.submenu!("", done);
    const targetList = settingsListCalls[settingsListCalls.length - 1];
    expect(targetList.items.map((i) => i.id)).toEqual(["session", "global", "all"]);
  });
});
