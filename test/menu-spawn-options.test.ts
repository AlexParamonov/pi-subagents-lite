/**
 * menu-spawn-options.test.ts — Tests for showSpawnOptionsMenu.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showSpawnOptionsMenu } from "../src/ui/menu/menu-spawn-options.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showSpawnOptionsMenu — max turns", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Default max turns · unlimited' when no default is set", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Default max turns"))).toBe("Default max turns · unlimited");
  });

  it("shows configured max turns value", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Default max turns"))).toBe("Default max turns · 50");
  });

  it("sets max turns to a specific value", async () => {
    const ctx = createMockCtx(["Default max turns · unlimited", undefined], ["30"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBe(30);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default max turns set to 30", "info");
  });

  it("sets max turns to unlimited (undefined)", async () => {
    mockModules.mockConfig.agent.defaultMaxTurns = 50;
    const ctx = createMockCtx(["Default max turns · 50", undefined], ["unlimited"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultMaxTurns).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default max turns set to unlimited", "info");
  });

  it("rejects invalid max turns with error", async () => {
    const ctx = createMockCtx(["Default max turns · unlimited", undefined], ["abc"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
  });

  it("rejects max turns < 1 with error", async () => {
    const ctx = createMockCtx(["Default max turns · unlimited", undefined], ["0"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 1 or 'unlimited'", "error");
  });
});

describe("showSpawnOptionsMenu — force background", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Force background · OFF' when disabled", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Force background"))).toBe("Force background · OFF");
  });

  it("shows 'Force background · ON' when enabled", async () => {
    mockModules.mockConfig.agent.forceBackground = true;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Force background"))).toBe("Force background · ON");
  });

  it("toggles force background", async () => {
    mockModules.mockConfig.agent.forceBackground = false;
    const ctx = createMockCtx(["Force background · OFF", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.forceBackground).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Force background ON", "info");
  });
});

describe("showSpawnOptionsMenu — grace turns", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Grace turns · 6' with default value", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 6");
  });

  it("shows configured grace turns value", async () => {
    mockModules.mockConfig.agent.graceTurns = 10;
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Grace turns"))).toBe("Grace turns · 10");
  });

  it("persists setting to 0", async () => {
    mockModules.mockConfig.agent.graceTurns = 5;
    const ctx = createMockCtx(["Grace turns · 5", undefined], ["0"]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.graceTurns).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Grace turns set to 0", "info");
  });

  it("rejects negative numbers with error notification", async () => {
    mockModules.mockConfig.agent.graceTurns = 3;
    const ctx = createMockCtx(["Grace turns · 3", undefined], ["-1"]);
    await showSpawnOptionsMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Invalid value — must be a number ≥ 0", "error");
    expect(mockModules.mockConfig.agent.graceTurns).toBe(3);
  });
});

describe("showSpawnOptionsMenu — default thinking level", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("shows 'Default thinking level · inherit' when no default is set", async () => {
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Default thinking level"))).toBe("Default thinking level · inherit");
  });

  it("shows configured thinking level", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx([undefined]);
    await showSpawnOptionsMenu(ctx);
    const items = ctx.ui.select.mock.calls[0][1];
    expect(items.find((i: string) => i.startsWith("Default thinking level"))).toBe("Default thinking level · high");
  });

  it("sets thinking level to a specific value", async () => {
    const ctx = createMockCtx(["Default thinking level · inherit", "medium", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultThinking).toBe("medium");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default thinking level set to medium", "info");
  });

  it("sets thinking level to inherit (undefined)", async () => {
    mockModules.mockConfig.agent.defaultThinking = "high";
    const ctx = createMockCtx(["Default thinking level · high", "inherit", undefined]);
    await showSpawnOptionsMenu(ctx);
    expect(mockModules.mockConfig.agent.defaultThinking).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default thinking level set to inherit", "info");
  });

  it("shows thinking level select with all levels plus inherit", async () => {
    const ctx = createMockCtx(["Default thinking level · inherit", undefined]);
    await showSpawnOptionsMenu(ctx);
    const thinkingCall = ctx.ui.select.mock.calls.find((c: any[]) => c[0] === "Default thinking level");
    expect(thinkingCall).toBeDefined();
    expect(thinkingCall[1]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "inherit"]);
  });
});
