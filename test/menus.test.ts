/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { getAgentConfig } from "../src/agents/agent-types.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: any[];
  maxVisible: number;
  theme: any;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: any;
}> = [];

vi.mock("@earendil-works/pi-tui", () => ({
  SettingsList: class MockSettingsList {
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, options });
    }
  },
  Input: class MockInput {
    value = "";
    onSubmit?: (value: string) => void;
    onEscape?: () => void;
    setValue(v: string) { this.value = v; }
    getValue() { return this.value; }
    constructor() {}
  },
}));

// Import AFTER mock setup
import { showAgentsMainMenu, showSettingsMenu } from "../src/ui/menu/menus.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showAgentsMainMenu — SettingsList integration", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with 4 items", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(settingsListCalls.length).toBe(1);
    expect(settingsListCalls[0].items.length).toBe(4);
  });

  it("items have correct ids and labels", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["running", "spawn", "settings", "debug"]);
    expect(settingsListCalls[0].items[0].label).toBe("Running agents");
    expect(settingsListCalls[0].items[1].label).toBe("Spawn agent");
    expect(settingsListCalls[0].items[2].label).toBe("Settings");
    expect(settingsListCalls[0].items[3].label).toBe("Debug");
  });

  it("all items show '→' as current value", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    for (const item of settingsListCalls[0].items) {
      expect(item.currentValue).toBe("→");
    }
  });

  it("all items have submenu functions", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    for (const item of settingsListCalls[0].items) {
      expect(typeof item.submenu).toBe("function");
    }
  });

  it("Settings submenu opens a nested SettingsList", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const settingsItem = settingsListCalls[0].items.find((i: any) => i.id === "settings");
    settingsItem.submenu("→", vi.fn());
    // Should create a nested SettingsList for the Settings menu
    expect(settingsListCalls.length).toBe(2);
    expect(settingsListCalls[1].items.length).toBe(5);
    const settingsIds = settingsListCalls[1].items.map((i: any) => i.id);
    expect(settingsIds).toEqual(["model", "concurrency", "spawn", "systemPrompt", "widget"]);
  });
});

describe("showSettingsMenu — SettingsList integration", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SettingsList with 5 items", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(settingsListCalls.length).toBe(1);
    expect(settingsListCalls[0].items.length).toBe(5);
  });

  it("items have correct ids and labels", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toEqual(["model", "concurrency", "spawn", "systemPrompt", "widget"]);
    expect(settingsListCalls[0].items[0].label).toBe("Model settings");
    expect(settingsListCalls[0].items[1].label).toBe("Concurrency settings");
    expect(settingsListCalls[0].items[2].label).toBe("Spawn options");
    expect(settingsListCalls[0].items[3].label).toBe("System prompt");
    expect(settingsListCalls[0].items[4].label).toBe("Widget settings");
  });

  it("all items show '→' as current value", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    for (const item of settingsListCalls[0].items) {
      expect(item.currentValue).toBe("→");
    }
  });

  it("all items have submenu functions", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    for (const item of settingsListCalls[0].items) {
      expect(typeof item.submenu).toBe("function");
    }
  });

  it("Widget settings submenu opens nested SettingsList", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const widgetItem = settingsListCalls[0].items.find((i: any) => i.id === "widget");
    widgetItem.submenu("→", vi.fn());
    // Should create a nested SettingsList for widget settings
    expect(settingsListCalls.length).toBe(2);
  });

  it("Spawn options submenu opens nested SettingsList", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const spawnItem = settingsListCalls[0].items.find((i: any) => i.id === "spawn");
    spawnItem.submenu("→", vi.fn());
    expect(settingsListCalls.length).toBe(2);
    const spawnIds = settingsListCalls[1].items.map((i: any) => i.id);
    expect(spawnIds).toEqual(["forceBackground", "graceTurns", "defaultMaxTurns", "defaultThinking"]);
  });

  it("System prompt submenu opens nested SettingsList", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const spItem = settingsListCalls[0].items.find((i: any) => i.id === "systemPrompt");
    spItem.submenu("→", vi.fn());
    expect(settingsListCalls.length).toBe(2);
    const spIds = settingsListCalls[1].items.map((i: any) => i.id);
    expect(spIds).toEqual(["systemPromptMode", "includeContextFiles", "loadSkillsImplicitly", "loadExtensionsImplicitly"]);
  });
});

describe("main menu — debug submenu navigation", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    settingsListCalls = [];
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  // Briefing content (worktree_path, agent types, etc.) is tested in menu-debug.test.ts.
  // Here we verify the main menu can navigate to the debug submenu.
  it("debug submenu is accessible from main menu", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    const debugItem = settingsListCalls[0].items.find((i: any) => i.id === "debug");
    expect(debugItem).toBeDefined();
    expect(typeof debugItem.submenu).toBe("function");
  });
});
