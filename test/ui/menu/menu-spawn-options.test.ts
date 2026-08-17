/**
 * menu-spawn-options.test.ts — Tests for showSpawnOptionsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 * defaultThinking/defaultMaxTurns go through a target picker (global/project
 * per ADR-0008) before their value submenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Component, SelectItem, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";

// Capture SettingsList constructor calls from pi-tui
let settingsListCalls: Array<{
  items: SettingItem[];
  maxVisible: number;
  theme: SettingsListTheme;
  onChange: (id: string, newValue: string) => void;
  onCancel: () => void;
  options?: { enableSearch?: boolean };
  /** The SettingsList instance, so tests can observe in-place rebuilds. */
  list: {
    items: SettingItem[];
    activate: (id: string) => void;
    onCancel: () => void;
  };
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
        maxVisible: number,
        theme: SettingsListTheme,
        onChange: (id: string, newValue: string) => void,
        onCancel: () => void,
        options?: { enableSearch?: boolean },
      ) {
        this.items = items;
        this.onChange = onChange;
        this.onCancel = onCancel;
        settingsListCalls.push({ items, maxVisible, theme, onChange, onCancel, options, list: this });
      }
      activate(id: string) {
        activatePickerRow(this, id);
      }
    },
    SelectList: class MockSelectList {
      items: SelectItem[];
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
      constructor(items: SelectItem[]) {
        this.items = items;
        selectListInstances.push(this);
      }
    },
    Input: class MockInput {
      value = "";
      onSubmit?: (value: string) => void;
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

// Import AFTER mock setup
import { showSpawnOptionsMenu } from "../../../src/ui/menu/menu-spawn-options.js";

afterEach(() => resetConfig());

function resetMenuState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockProjectConfig.agent = {};
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockProjectTargetOffered = false;
  vi.clearAllMocks();
  settingsListCalls = [];
  inputInstances = [];
  selectListInstances = [];
}

describe("showSpawnOptionsMenu — SettingsList integration", () => {
  beforeEach(resetMenuState);

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — force background", () => {
  beforeEach(resetMenuState);

  it("shows 'Force background · OFF' when disabled", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i) => i.id === "forceBackground")!;
    expect(fb.currentValue).toBe("OFF");
  });

  it("shows 'Force background · ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i) => i.id === "forceBackground")!;
    expect(fb.currentValue).toBe("ON");
  });

  it("toggles force background via onChange", async () => {
    mockModules.mockConfig.agent.forceBackground = false;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("forceBackground", "ON");
    expect(mockModules.mockConfig.agent.forceBackground).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSpawnOptionsMenu — grace turns", () => {
  beforeEach(resetMenuState);

  it("shows 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i) => i.id === "graceTurns")!;
    expect(gt.currentValue).toBe("6");
    expect(typeof gt.submenu).toBe("function");
  });

  it("shows configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i) => i.id === "graceTurns")!;
    expect(gt.currentValue).toBe("10");
  });

  it("grace turns submenu creates Input and handles valid submit", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i) => i.id === "graceTurns")!;
    const mockDone = vi.fn();
    gt.submenu!("5", mockDone);

    expect(inputInstances.length).toBe(1);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("grace turns submenu rejects negative numbers", async () => {
    mockModules.mockConfig.agent.graceTurns = 3;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i) => i.id === "graceTurns")!;
    const mockDone = vi.fn();
    gt.submenu!("3", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("grace turns submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i) => i.id === "graceTurns")!;
    const mockDone = vi.fn();
    gt.submenu!("6", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — default max turns", () => {
  beforeEach(resetMenuState);

  it("shows 'Default max turns · (not set)' when no default is set", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    expect(dmt.currentValue).toBe("(not set)");
    expect(typeof dmt.submenu).toBe("function");
  });

  it("shows configured max turns value", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    expect(dmt.currentValue).toBe("50");
  });

  it("tags a project-sourced max turns with [project]", async () => {
    mockModules.mockProjectConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    expect(dmt.currentValue).toBe("50 [project]");
  });

  it("max turns submenu: target pick then valid number", async () => {
    mockModules.mockProjectTargetOffered = true;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("unlimited", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    // No session layer for max turns; project offered.
    expect(targetList.items.map((i) => i.id)).toEqual(["global", "project", "clear"]);
    targetList.activate("project");

    const input = inputInstances[inputInstances.length - 1];
    input.onSubmit!("30");
    expect(mockModules.mockProjectConfig.agent.defaultMaxTurns).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("30");
  });

  it("max turns submenu: Clear... opens a nested per-level picker and clears at the picked level", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    mockModules.mockProjectConfig.agent.defaultMaxTurns = 30;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("30", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("clear");

    // The nested clear picker offers the persisted layers plus "all"; no session layer.
    const clearList = settingsListCalls[settingsListCalls.length - 1].list;
    expect(clearList).not.toBe(targetList);
    expect(clearList.items.map((i) => i.id)).toEqual(["global", "project", "all"]);
    clearList.activate("project");

    expect(mockModules.mockProjectConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(50); // falls through to global
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("project");
  });

  it("max turns submenu: Clear... at all levels removes the value from every layer", async () => {
    mockModules.mockProjectTargetOffered = true;
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    mockModules.mockProjectConfig.agent.defaultMaxTurns = 30;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("30", mockDone);

    settingsListCalls[settingsListCalls.length - 1].list.activate("clear");
    settingsListCalls[settingsListCalls.length - 1].list.activate("all");

    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(mockModules.mockProjectConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith("all");
  });

  it("max turns submenu: Clear... offers only global and all when the project target is unavailable", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("", mockDone);

    settingsListCalls[settingsListCalls.length - 1].list.activate("clear");

    const clearList = settingsListCalls[settingsListCalls.length - 1].list;
    expect(clearList.items.map((i) => i.id)).toEqual(["global", "all"]);
  });

  it("max turns submenu: escape from the nested Clear... picker returns to the outer picker", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("50", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("clear");

    const clearList = settingsListCalls[settingsListCalls.length - 1].list;
    expect(clearList).not.toBe(targetList);
    // Drill-down: canceling the nested picker returns to the outer picker;
    // nothing is cleared and the row's done is not called.
    clearList.onCancel();

    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(50);
    expect(mockDone).not.toHaveBeenCalled();
  });

  // Regression: after a submenu mutation the list must rebuild so the row
  // shows the fresh value with its provenance tag (previously stale until
  // the menu was reopened). Mirrors the real SettingsList flow: the numeric
  // submenu mutates the store, then closes with a value, which invokes onChange.
  it("rebuilds after a submenu value change so the row shows the new value with its provenance tag", async () => {
    mockModules.mockProjectTargetOffered = true;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const recorded = settingsListCalls[0];

    mockModules.mockProjectConfig.agent.defaultMaxTurns = 50;
    recorded.onChange("defaultMaxTurns", "50");

    const dmt = recorded.list.items.find((i) => i.id === "defaultMaxTurns")!;
    expect(dmt.currentValue).toBe("50 [project]");
  });

  it("max turns submenu accepts 'unlimited' to clear at the picked level", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("50", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("global");

    inputInstances[inputInstances.length - 1].onSubmit!("unlimited");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith("(not set)");
  });

  it("max turns submenu rejects value < 1", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("unlimited", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("global");

    inputInstances[inputInstances.length - 1].onSubmit!("0");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu handles escape from the target picker", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i) => i.id === "defaultMaxTurns")!;
    const mockDone = vi.fn();
    dmt.submenu!("unlimited", mockDone);

    settingsListCalls[settingsListCalls.length - 1].list.onCancel();
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — default thinking level", () => {
  beforeEach(resetMenuState);

  it("shows 'Default thinking level · inherit' when no default is set", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    expect(dt.currentValue).toBe("inherit");
  });

  it("shows configured thinking level", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    expect(dt.currentValue).toBe("high");
  });

  it("tags a project-sourced thinking level with [project]", async () => {
    mockModules.mockProjectConfig.agent.defaultThinking = "medium";
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    expect(dt.currentValue).toBe("medium [project]");
  });

  it("sets thinking level at global via target pick then level pick", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    const mockDone = vi.fn();
    dt.submenu!("", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("global");

    const levelList = selectListInstances[selectListInstances.length - 1];
    expect(levelList.items.map((i) => i.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "inherit",
    ]);
    levelList.onSelect!({ value: "medium", label: "medium" });

    expect(mockModules.mockConfig.agent.defaultThinking).toBe("medium");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("medium");
  });

  it("sets thinking level at project level via target pick", async () => {
    mockModules.mockProjectTargetOffered = true;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    const mockDone = vi.fn();
    dt.submenu!("", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("project");

    const levelList = selectListInstances[selectListInstances.length - 1];
    levelList.onSelect!({ value: "high", label: "high" });

    expect(mockModules.mockProjectConfig.agent.defaultThinking).toBe("high");
    expect(mockDone).toHaveBeenCalledWith("high");
  });

  it("selecting 'inherit' clears the level at the picked target", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i) => i.id === "defaultThinking")!;
    const mockDone = vi.fn();
    dt.submenu!("", mockDone);

    const targetList = settingsListCalls[settingsListCalls.length - 1].list;
    targetList.activate("global");

    const levelList = selectListInstances[selectListInstances.length - 1];
    levelList.onSelect!({ value: "inherit", label: "inherit" });

    expect(mockModules.mockConfig.agent.defaultThinking).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith("inherit");
  });
});

describe("showSpawnOptionsMenu — watchdog timeouts", () => {
  beforeEach(resetMenuState);

  it("shows 'Tool timeout · 45' and 'Idle timeout · 45' right after grace turns", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const items = settingsListCalls[0].items;

    const tt = items.find((i) => i.id === "toolTimeout")!;
    expect(tt.currentValue).toBe("45");
    expect(typeof tt.submenu).toBe("function");

    const itm = items.find((i) => i.id === "idleTimeout")!;
    expect(itm.currentValue).toBe("45");
    expect(typeof itm.submenu).toBe("function");

    const gtIdx = items.findIndex((i) => i.id === "graceTurns");
    expect(items[gtIdx + 1].id).toBe("toolTimeout");
    expect(items[gtIdx + 2].id).toBe("idleTimeout");
  });

  it("shows configured timeout values", async () => {
    mockModules.mockConfig.agent.toolTimeoutMinutes = 10;
    mockModules.mockConfig.agent.idleTimeoutMinutes = 20;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items.find((i) => i.id === "toolTimeout")!.currentValue).toBe("10");
    expect(items.find((i) => i.id === "idleTimeout")!.currentValue).toBe("20");
  });

  it("tool timeout submenu pre-fills the current value and accepts 0", async () => {
    mockModules.mockConfig.agent.toolTimeoutMinutes = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const tt = settingsListCalls[0].items.find((i) => i.id === "toolTimeout")!;
    const mockDone = vi.fn();
    tt.submenu!("5", mockDone);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.toolTimeoutMinutes).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("tool timeout submenu rejects negative and non-numeric input", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const tt = settingsListCalls[0].items.find((i) => i.id === "toolTimeout")!;
    const mockDone = vi.fn();
    tt.submenu!("45", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12x");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("idle timeout submenu pre-fills the current value and accepts 0", async () => {
    mockModules.mockConfig.agent.idleTimeoutMinutes = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const itm = settingsListCalls[0].items.find((i) => i.id === "idleTimeout")!;
    const mockDone = vi.fn();
    itm.submenu!("5", mockDone);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.idleTimeoutMinutes).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("idle timeout submenu rejects negative and non-numeric input", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const itm = settingsListCalls[0].items.find((i) => i.id === "idleTimeout")!;
    const mockDone = vi.fn();
    itm.submenu!("45", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12x");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  describe("showSpawnOptionsMenu — output transcript", () => {
    beforeEach(() => {
      resetMenuState();
      mockModules.mockConfig.agent = {
        default: null,
        forceBackground: false,
        outputTranscript: true,
      };
    });

    it("shows 'Output transcript · ON' when enabled (default)", async () => {
      const ctx = createMockCtx();
      await showSpawnOptionsMenu(ctx);
      const ot = settingsListCalls[0].items.find((i) => i.id === "outputTranscript")!;
      expect(ot.currentValue).toBe("ON");
    });

    it("shows 'Output transcript · OFF' when disabled", async () => {
      mockModules.mockConfig.agent.outputTranscript = false;
      const ctx = createMockCtx();
      await showSpawnOptionsMenu(ctx);
      const ot = settingsListCalls[0].items.find((i) => i.id === "outputTranscript")!;
      expect(ot.currentValue).toBe("OFF");
    });

    it("toggles output transcript via onChange", async () => {
      mockModules.mockConfig.agent.outputTranscript = true;
      const ctx = createMockCtx();
      await showSpawnOptionsMenu(ctx);
      settingsListCalls[0].onChange("outputTranscript", "OFF");
      expect(mockModules.mockConfig.agent.outputTranscript).toBe(false);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    });

    it("toggles output transcript back on via onChange", async () => {
      mockModules.mockConfig.agent.outputTranscript = false;
      const ctx = createMockCtx();
      await showSpawnOptionsMenu(ctx);
      settingsListCalls[0].onChange("outputTranscript", "ON");
      expect(mockModules.mockConfig.agent.outputTranscript).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    });
  });
});
