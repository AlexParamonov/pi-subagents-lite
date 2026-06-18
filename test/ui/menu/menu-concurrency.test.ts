/**
 * menu-concurrency-new.test.ts — Tests for showConcurrencySettingsMenu using SettingsList.
 *
 * After migration: uses ctx.ui.custom with SettingsList (not ctx.ui.select/runMenuLoop).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

let settingsListCalls: Array<any> = [];
let inputInstances: Array<any> = [];
let selectListInstances: Array<any> = [];
let settingsListWrapperCalls: Array<any> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    items: any[];
    onChange: any;
    onCancel: any;
    constructor(items: any[], _max: number, _theme: any, onChange: any, onCancel: any) {
      this.items = items;
      this.onChange = onChange;
      this.onCancel = onCancel;
      settingsListCalls.push(this as any);
    }
    render() { return []; }
    handleInput() {}
  },
  SelectList: class MockSelectList {
    items: any[];
    onSelect?: (item: any) => void;
    onCancel?: () => void;
    constructor(items: any[]) {
      this.items = items;
      selectListInstances.push(this as any);
    }
    render() { return []; }
    handleInput() {}
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (v: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() { inputInstances.push(this as any); }
  },
}));

vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() { return []; }
    handleInput() {}
    invalidate() {}
  },
}));

// Import AFTER mock setup
import { showConcurrencySettingsMenu } from "../../../src/ui/menu/menu-concurrency.js";

function resetConfig(): void {
  mockModules.mockConfig.concurrency = { default: 4 };
}

describe("showConcurrencySettingsMenu — SettingsList migration", () => {
  beforeEach(() => {
    resetConfig();
    settingsListCalls = [];
    inputInstances = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select/runMenuLoop)", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with correct items", async () => {
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"]);
    expect(settingsListCalls.length).toBe(1);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("defaultConcurrency");
    expect(ids).toContain("addProviderLimit");
    expect(ids).toContain("addModelLimit");
    expect(ids).toContain("resetAll");
  });

  it("shows default concurrency with current value", async () => {
    mockModules.mockConfig.concurrency = { default: 4 };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, []);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "defaultConcurrency");
    expect(item.currentValue).toBe("4");
  });
});

describe("showConcurrencySettingsMenu — per-provider limits", () => {
  beforeEach(() => {
    resetConfig();
    settingsListCalls = [];
    inputInstances = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("shows configured per-provider limits as items", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("provider:llamacpp");
    const item = settingsListCalls[0].items.find((i: any) => i.id === "provider:llamacpp");
    expect(item.currentValue).toBe("2 slots");
  });

  it("edit provider limit submenu shows Edit/Remove options", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "provider:llamacpp");
    const done = vi.fn();
    item.submenu("2", done);
    // Submenu creates a SelectList with Edit/Remove
    const editList = selectListInstances[selectListInstances.length - 1];
    expect(editList).toBeDefined();
    expect(editList.items).toHaveLength(2);
    expect(editList.items[0].value).toBe("edit");
    expect(editList.items[1].value).toBe("remove");
  });

  it("edit provider limit — selecting Remove removes the limit", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "provider:llamacpp");
    const done = vi.fn();
    item.submenu("2", done);
    const editList = selectListInstances[selectListInstances.length - 1];
    editList.onSelect!({ value: "remove" });
    expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Removed per-provider limit for llamacpp", "info");
    expect(done).toHaveBeenCalled();
  });

  it("edit provider limit — selecting Edit opens Input via proxy", async () => {
    mockModules.mockConfig.concurrency = { default: 4, providers: { llamacpp: 2 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "provider:llamacpp");
    const done = vi.fn();
    const proxy = item.submenu("2", done);

    // Proxy starts delegating to SelectList
    expect(proxy.render(80)).toEqual([]);

    // Simulate selecting "edit" — proxy now delegates to Input
    const editList = selectListInstances[selectListInstances.length - 1];
    editList.onSelect!({ value: "edit" });

    // Input should be the active component now
    const input = inputInstances[inputInstances.length - 1];
    expect(input).toBeDefined();

    // Verify proxy delegates handleInput to Input (not SelectList)
    proxy.handleInput("5\r");
    // The Input mock doesn't simulate full key handling, so call onSubmit directly
    // to verify the handler is wired correctly
    input.onSubmit!("5");
    expect(mockModules.mockConfig.concurrency.providers!.llamacpp).toBe(5);
    expect(ctx.ui.notify).toHaveBeenCalledWith("llamacpp concurrency set to 5", "info");
    expect(done).toHaveBeenCalled();
  });
});

describe("showConcurrencySettingsMenu — per-model limits", () => {
  beforeEach(() => {
    resetConfig();
    settingsListCalls = [];
    inputInstances = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("shows configured per-model limits as items", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 3 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("model:llamacpp/4b");
    const item = settingsListCalls[0].items.find((i: any) => i.id === "model:llamacpp/4b");
    expect(item.currentValue).toBe("3 slots");
  });

  it("edit model limit submenu shows Edit/Remove options", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 1 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "model:llamacpp/4b");
    const done = vi.fn();
    item.submenu("1", done);
    const editList = selectListInstances[selectListInstances.length - 1];
    expect(editList).toBeDefined();
    expect(editList.items).toHaveLength(2);
    expect(editList.items[0].value).toBe("edit");
    expect(editList.items[1].value).toBe("remove");
  });

  it("edit model limit — selecting Edit opens Input via proxy", async () => {
    mockModules.mockConfig.concurrency = { default: 4, models: { "llamacpp/4b": 1 } };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "model:llamacpp/4b");
    const done = vi.fn();
    const proxy = item.submenu("1", done);

    // Proxy starts delegating to SelectList
    expect(proxy.render(80)).toEqual([]);

    // Simulate selecting "edit"
    const editList = selectListInstances[selectListInstances.length - 1];
    editList.onSelect!({ value: "edit" });

    // Input should be the active component now
    const input = inputInstances[inputInstances.length - 1];
    expect(input).toBeDefined();

    // Verify proxy delegates handleInput to Input
    proxy.handleInput("8\r");
    input.onSubmit!("8");
    expect(mockModules.mockConfig.concurrency.models!["llamacpp/4b"]).toBe(8);
    expect(done).toHaveBeenCalled();
  });
});

describe("showConcurrencySettingsMenu — reset all", () => {
  beforeEach(() => {
    resetConfig();
    settingsListCalls = [];
    inputInstances = [];
    selectListInstances = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("reset all clears per-provider and per-model limits", async () => {
    mockModules.mockConfig.concurrency = {
      default: 4,
      providers: { llamacpp: 2, openai: 5 },
      models: { "llamacpp/4b": 3, "openai/gpt-4o": 1 },
    };
    const ctx = createMockCtx();
    await showConcurrencySettingsMenu(ctx, ["llamacpp/4b", "openai/gpt-4o"]);
    const item = settingsListCalls[0].items.find((i: any) => i.id === "resetAll");
    const done = vi.fn();
    item.submenu("", done);
    // The confirm submenu creates a SelectList — simulate selecting "Yes"
    const confirmList = selectListInstances[selectListInstances.length - 1];
    expect(confirmList).toBeDefined();
    confirmList.onSelect!({ value: "Yes" });
    expect(mockModules.mockConfig.concurrency).toEqual({ default: 4 });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Concurrency reset to defaults", "info");
    expect(done).toHaveBeenCalledWith("Yes");
  });
});
