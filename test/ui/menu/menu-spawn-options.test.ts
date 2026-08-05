/**
 * menu-spawn-options.test.ts — Tests for showSpawnOptionsMenu.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state (fixes cursor position reset).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
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

let inputInstances: Array<{
  value: string;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  setValue: (v: string) => void;
  getValue: () => string;
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
    setValue(v: string) {
      this.value = v;
    }
    getValue() {
      return this.value;
    }
    constructor() {
      inputInstances.push(this as any);
    }
  },
}));

// Import AFTER mock setup
import { showSpawnOptionsMenu } from "../../../src/ui/menu/menu-spawn-options.js";

afterEach(() => resetConfig());

describe("showSpawnOptionsMenu — SettingsList integration", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — force background", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Force background · OFF' when disabled", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i: any) => i.id === "forceBackground");
    expect(fb.currentValue).toBe("OFF");
  });

  it("shows 'Force background · ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const fb = settingsListCalls[0].items.find((i: any) => i.id === "forceBackground");
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
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    expect(gt.currentValue).toBe("6");
    expect(typeof gt.submenu).toBe("function");
  });

  it("shows configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    expect(gt.currentValue).toBe("10");
  });

  it("grace turns submenu creates Input and handles valid submit", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("5", mockDone);

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

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("3", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("grace turns submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const gt = settingsListCalls[0].items.find((i: any) => i.id === "graceTurns");
    const mockDone = vi.fn();
    gt.submenu("6", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — default max turns", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Default max turns · (not set)' when no default is set", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    expect(dmt.currentValue).toBe("(not set)");
    expect(typeof dmt.submenu).toBe("function");
  });

  it("shows configured max turns value", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    expect(dmt.currentValue).toBe("50");
  });

  it("max turns submenu accepts valid number", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    const mockDone = vi.fn();
    dmt.submenu("unlimited", mockDone);

    inputInstances[0].onSubmit!("30");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("30");
  });

  it("max turns submenu accepts 'unlimited'", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    const mockDone = vi.fn();
    dmt.submenu("50", mockDone);

    inputInstances[0].onSubmit!("unlimited");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(mockDone).toHaveBeenCalledWith("(not set)");
  });

  it("max turns submenu rejects value < 1", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    const mockDone = vi.fn();
    dmt.submenu("unlimited", mockDone);

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu rejects invalid input", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    const mockDone = vi.fn();
    dmt.submenu("unlimited", mockDone);

    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("max turns submenu handles escape", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const dmt = settingsListCalls[0].items.find((i: any) => i.id === "defaultMaxTurns");
    const mockDone = vi.fn();
    dmt.submenu("unlimited", mockDone);

    inputInstances[0].onEscape!();
    expect(mockDone).toHaveBeenCalled();
  });
});

describe("showSpawnOptionsMenu — default thinking level", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Default thinking level · inherit' when no default is set", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking");
    expect(dt.currentValue).toBe("inherit");
  });

  it("shows configured thinking level", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const dt = settingsListCalls[0].items.find((i: any) => i.id === "defaultThinking");
    expect(dt.currentValue).toBe("high");
  });

  it("sets thinking level via onChange", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("defaultThinking", "medium");
    expect(mockModules.mockConfig.agent.defaultThinking).toBe("medium");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("sets thinking level to inherit (undefined) via onChange", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    settingsListCalls[0].onChange("defaultThinking", "inherit");
    expect(mockModules.mockConfig.agent.defaultThinking).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});

describe("showSpawnOptionsMenu — watchdog timeouts", () => {
  beforeEach(() => {
    mockModules.mockConfig.agent = { default: null, forceBackground: false };
    mockModules.mockSessionOverrides.default = null;
    mockModules.mockSessionShowCost = undefined;
    vi.clearAllMocks();
    settingsListCalls = [];
    inputInstances = [];
  });

  it("shows 'Tool timeout · 45' and 'Idle timeout · 45' right after grace turns", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const items = settingsListCalls[0].items;

    const tt = items.find((i: any) => i.id === "toolTimeout");
    expect(tt.currentValue).toBe("45");
    expect(typeof tt.submenu).toBe("function");

    const itm = items.find((i: any) => i.id === "idleTimeout");
    expect(itm.currentValue).toBe("45");
    expect(typeof itm.submenu).toBe("function");

    const gtIdx = items.findIndex((i: any) => i.id === "graceTurns");
    expect(items[gtIdx + 1].id).toBe("toolTimeout");
    expect(items[gtIdx + 2].id).toBe("idleTimeout");
  });

  it("shows configured timeout values", async () => {
    mockModules.mockConfig.agent.toolTimeoutMinutes = 10;
    mockModules.mockConfig.agent.idleTimeoutMinutes = 20;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);
    const items = settingsListCalls[0].items;
    expect(items.find((i: any) => i.id === "toolTimeout").currentValue).toBe("10");
    expect(items.find((i: any) => i.id === "idleTimeout").currentValue).toBe("20");
  });

  it("tool timeout submenu pre-fills the current value and accepts 0", async () => {
    mockModules.mockConfig.agent.toolTimeoutMinutes = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const tt = settingsListCalls[0].items.find((i: any) => i.id === "toolTimeout");
    const mockDone = vi.fn();
    tt.submenu("5", mockDone);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.toolTimeoutMinutes).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("tool timeout submenu rejects negative and non-numeric input", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const tt = settingsListCalls[0].items.find((i: any) => i.id === "toolTimeout");
    const mockDone = vi.fn();
    tt.submenu("45", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12x");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12.5");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });

  it("idle timeout submenu pre-fills the current value and accepts 0", async () => {
    mockModules.mockConfig.agent.idleTimeoutMinutes = 5;
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const itm = settingsListCalls[0].items.find((i: any) => i.id === "idleTimeout");
    const mockDone = vi.fn();
    itm.submenu("5", mockDone);
    expect(inputInstances[0].value).toBe("5");

    inputInstances[0].onSubmit!("0");
    expect(mockModules.mockConfig.agent.idleTimeoutMinutes).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    expect(mockDone).toHaveBeenCalledWith("0");
  });

  it("idle timeout submenu rejects negative and non-numeric input", async () => {
    const ctx = createMockCtx();
    await showSpawnOptionsMenu(ctx);

    const itm = settingsListCalls[0].items.find((i: any) => i.id === "idleTimeout");
    const mockDone = vi.fn();
    itm.submenu("45", mockDone);

    inputInstances[0].onSubmit!("-1");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("abc");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12x");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();

    inputInstances[0].onSubmit!("12.5");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockDone).not.toHaveBeenCalled();
  });
});
