/**
 * menu-system-prompt.test.ts — Tests for showSystemPromptMenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import type { Component, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: SettingItem[];
  maxVisible: number;
  theme: SettingsListTheme;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  list: {
    items: SettingItem[];
    activate: (id: string) => void;
    onCancel: () => void;
  };
}> = [];

vi.mock("@earendil-works/pi-tui", async () => {
  const { activatePickerRow } = await import("../../menu-picker-helpers.js");
  return {
    SettingsList: class MockSettingsList {
      items: SettingItem[];
      maxVisible: number;
      theme: SettingsListTheme;
      onChange: (id: string, newValue: string) => void;
      onCancel: () => void;
      submenuComponent: Component | null = null;
      selectedIndex = 0;
      constructor(
        items: SettingItem[],
        maxVisible: number,
        theme: SettingsListTheme,
        onChange: (id: string, newValue: string) => void,
        onCancel: () => void,
      ) {
        this.items = items;
        this.maxVisible = maxVisible;
        this.theme = theme;
        this.onChange = onChange;
        this.onCancel = onCancel;
        settingsListCalls.push({
          items,
          maxVisible,
          theme,
          onChange,
          onCancel,
          list: {
            get items() {
              return items;
            },
            activate: (id: string) => activatePickerRow(this, id),
            onCancel,
          },
        });
      }
      invalidate() {}
      render(_width: number) {
        return "";
      }
      handleInput(_data: string) {}
    },
    SettingsListWrapper: class MockWrapper {
      constructor(public inner: unknown, public options: Record<string, unknown>) {}
      invalidate() {}
      render(_width: number) {
        return "";
      }
      handleInput(_data: string) {}
    },
  };
});

beforeEach(() => {
  settingsListCalls = [];
  resetConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("showSystemPromptMenu", () => {
  it("shows correct items", async () => {
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).toContain("systemPromptMode");
    expect(ids).toContain("includeContextFiles");
    expect(ids).toContain("loadSkillsImplicitly");
    expect(ids).toContain("loadExtensionsImplicitly");
    expect(ids).not.toContain("agentToolStrictMode");
  });

  it("includes createPromptFile when mode is custom and file does not exist", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).toContain("createPromptFile");
    vi.restoreAllMocks();
  });

  it("does NOT include createPromptFile when mode is not custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "replace";
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).not.toContain("createPromptFile");
  });

  it("does NOT include createPromptFile when file already exists", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i) => i.id);
    expect(ids).not.toContain("createPromptFile");
    vi.restoreAllMocks();
  });

  it("creates file and shows notification via onChange", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("createPromptFile", "Create");
    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created prompt file"), "info");
    vi.restoreAllMocks();
  });

  it("shows error notification when file creation fails", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const ctx = createMockCtx();
    const { showSystemPromptMenu } = await import("../../../src/ui/menu/menu-system-prompt.js");
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("createPromptFile", "Create");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file"), "error");
    vi.restoreAllMocks();
  });
});
