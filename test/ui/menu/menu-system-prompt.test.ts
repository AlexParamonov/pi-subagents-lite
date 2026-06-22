/**
 * menu-system-prompt.test.ts — Tests for showSystemPromptMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

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
    items: any[];
    constructor(items: any[], maxVisible: number, theme: any, onChange: any, onCancel: any, options?: any) {
      this.items = items;
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
import { showSystemPromptMenu } from "../../../src/ui/menu/menu-system-prompt.js";

describe("showSystemPromptMenu — SettingsList integration", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

});

describe("showSystemPromptMenu — system prompt mode", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("shows 'System prompt mode · replace' by default", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const spm = settingsListCalls[0].items.find((i: any) => i.id === "systemPromptMode");
  });

  it("shows configured system prompt mode", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "inherit";
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const spm = settingsListCalls[0].items.find((i: any) => i.id === "systemPromptMode");
    expect(spm.currentValue).toBe("inherit");
  });

  it("sets system prompt mode via onChange", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("systemPromptMode", "inherit");
    expect(mockModules.mockConfig.agent.systemPromptMode).toBe("inherit");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSystemPromptMenu — Create prompt file", () => {
  let existsSyncSpy: ReturnType<typeof vi.spyOn>;
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false, systemPromptMode: "custom" };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    existsSyncSpy = vi.spyOn(fs, "existsSync");
    mkdirSyncSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
  });

  it("shows 'Create prompt file' when mode is custom and file does not exist", async () => {
    existsSyncSpy.mockReturnValue(false);
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("createPromptFile");
    const cpf = settingsListCalls[0].items.find((i: any) => i.id === "createPromptFile");
    expect(cpf.currentValue).toContain("subagents-lite-prompt.md");
  });

  it("does NOT show 'Create prompt file' when mode is custom and file exists", async () => {
    existsSyncSpy.mockReturnValue(true);
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("createPromptFile");
  });

  it("does NOT show 'Create prompt file' when mode is not custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "replace";
    existsSyncSpy.mockReturnValue(false);
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).not.toContain("createPromptFile");
  });

  it("creates file and shows notification via onChange", async () => {
    existsSyncSpy.mockReturnValue(false);
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("createPromptFile", "Create");
    expect(mkdirSyncSpy).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Created prompt file"), "info");
  });

  it("shows error notification when file creation fails", async () => {
    existsSyncSpy.mockReturnValue(false);
    mkdirSyncSpy.mockImplementation(() => { throw new Error("permission denied"); });
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("createPromptFile", "Create");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to create prompt file"), "error");
  });
});

describe("showSystemPromptMenu — Include AGENTS.md", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("shows 'Include AGENTS.md · ON' when includeContextFiles is true", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const icf = settingsListCalls[0].items.find((i: any) => i.id === "includeContextFiles");
  });

  it("shows 'Include AGENTS.md · OFF' when includeContextFiles is false", async () => {
    mockModules.mockConfig.agent.includeContextFiles = false;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const icf = settingsListCalls[0].items.find((i: any) => i.id === "includeContextFiles");
    expect(icf.currentValue).toBe("OFF");
  });

  it("toggles include context files via onChange", async () => {
    mockModules.mockConfig.agent.includeContextFiles = true;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("includeContextFiles", "OFF");
    expect(mockModules.mockConfig.agent.includeContextFiles).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSystemPromptMenu — Load skills implicitly", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("shows 'Load skills implicitly · ON' when loadSkillsImplicitly is true", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const lsi = settingsListCalls[0].items.find((i: any) => i.id === "loadSkillsImplicitly");
  });

  it("shows 'Load skills implicitly · OFF' when loadSkillsImplicitly is false", async () => {
    mockModules.mockConfig.agent.loadSkillsImplicitly = false;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const lsi = settingsListCalls[0].items.find((i: any) => i.id === "loadSkillsImplicitly");
    expect(lsi.currentValue).toBe("OFF");
  });

  it("toggles load skills implicitly via onChange", async () => {
    mockModules.mockConfig.agent.loadSkillsImplicitly = true;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("loadSkillsImplicitly", "OFF");
    expect(mockModules.mockConfig.agent.loadSkillsImplicitly).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSystemPromptMenu — Load extensions implicitly", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });

  it("shows 'Load extensions implicitly · ON' when loadExtensionsImplicitly is true", async () => {
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const lei = settingsListCalls[0].items.find((i: any) => i.id === "loadExtensionsImplicitly");
  });

  it("shows 'Load extensions implicitly · OFF' when loadExtensionsImplicitly is false", async () => {
    mockModules.mockConfig.agent.loadExtensionsImplicitly = false;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const lei = settingsListCalls[0].items.find((i: any) => i.id === "loadExtensionsImplicitly");
    expect(lei.currentValue).toBe("OFF");
  });

  it("toggles load extensions implicitly via onChange", async () => {
    mockModules.mockConfig.agent.loadExtensionsImplicitly = true;
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    settingsListCalls[0].onChange("loadExtensionsImplicitly", "OFF");
    expect(mockModules.mockConfig.agent.loadExtensionsImplicitly).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSystemPromptMenu — item order", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
  });


  it("includes createPromptFile when systemPromptMode is custom", async () => {
    mockModules.mockConfig.agent.systemPromptMode = "custom";
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const ctx = createMockCtx();
    await showSystemPromptMenu(ctx);
    const ids = settingsListCalls[0].items.map((i: any) => i.id);
    expect(ids).toContain("createPromptFile");
    vi.restoreAllMocks();
  });
});
