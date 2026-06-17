/**
 * menu-debug.test.ts — Tests for showDebugMenu (showAgentTypes, handleAgentBriefing).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showDebugMenu } from "../src/ui/menu/menu-debug.js";
import { getAllTypes, getAvailableTypes, getAgentConfig } from "../src/agents/agent-types.js";

describe("showDebugMenu — menu loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAllTypes as any).mockReturnValue([]);
    (getAvailableTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("displays two menu items: Agent types and Agent briefing", async () => {
    const ctx = createMockCtx([undefined]);
    await showDebugMenu(ctx);
    const items: string[] = ctx.ui.select.mock.calls[0][1];
    expect(items.length).toBe(2);
    expect(items[0]).toContain("Agent types");
    expect(items[1]).toContain("Agent briefing");
  });

  it("shows 'Debug' as the menu title", async () => {
    const ctx = createMockCtx([undefined]);
    await showDebugMenu(ctx);
    expect(ctx.ui.select.mock.calls[0][0]).toBe("Debug");
  });

  it("exits when selection returns undefined (user cancels)", async () => {
    const ctx = createMockCtx([undefined]);
    await showDebugMenu(ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });

  it("re-prompts after handling a selection", async () => {
    // First: select "Agent types" (option 1). Second: cancel.
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
  });
});

describe("showDebugMenu — showAgentTypes (option 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'No agent types available' when getAllTypes returns empty", async () => {
    (getAllTypes as any).mockReturnValue([]);
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No agent types available", "info");
  });

  it("lists each agent type with its description", async () => {
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { description: "General-purpose agent" };
      if (name === "Explore") return { description: "Explore agent" };
      return undefined;
    });
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall).toBeDefined();
    expect(notifyCall[0]).toContain("general-purpose");
    expect(notifyCall[0]).toContain("General-purpose agent");
    expect(notifyCall[0]).toContain("Explore");
    expect(notifyCall[0]).toContain("Explore agent");
  });

  it("marks hidden types with [HIDDEN]", async () => {
    (getAllTypes as any).mockReturnValue(["secret-agent"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "secret-agent") return { description: "Hidden agent", hidden: true };
      return undefined;
    });
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("secret-agent"));
    expect(notifyCall[0]).toContain("[HIDDEN]");
  });

  it("shows model when config has one", async () => {
    (getAllTypes as any).mockReturnValue(["test-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Test agent",
      model: "claude-sonnet-4-20250514",
    }));
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Model: claude-sonnet-4-20250514");
  });

  it("shows registered tools when present", async () => {
    (getAllTypes as any).mockReturnValue(["tool-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Agent with tools",
      registeredTools: ["file_read", "file_write"],
    }));
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Tools: file_read, file_write");
  });

  it("shows 'all built-in tools' when registeredTools is absent", async () => {
    (getAllTypes as any).mockReturnValue(["default-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Default agent",
    }));
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Tools: all built-in tools");
  });

  it("shows source when present", async () => {
    (getAllTypes as any).mockReturnValue(["ext-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Extension agent",
      source: ".pi/agents/ext-agent.md",
    }));
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("Source: .pi/agents/ext-agent.md");
  });

  it("skips types where getAgentConfig returns undefined", async () => {
    (getAllTypes as any).mockReturnValue(["known", "unknown"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "known") return { description: "Known agent" };
      return undefined;
    });
    const ctx = createMockCtx(["1. Agent types", undefined]);
    await showDebugMenu(ctx);
    const notifyCall = ctx.ui.notify.mock.calls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("Available agent types"));
    expect(notifyCall[0]).toContain("known");
    expect(notifyCall[0]).not.toContain("unknown");
  });
});

describe("showDebugMenu — handleAgentBriefing (option 2)", () => {
  let mockSendUserMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    (getAvailableTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return {
        displayName: "General Purpose",
        description: "General-purpose agent",
        registeredTools: ["file_read", "file_write"],
        model: "claude-sonnet-4-20250514",
        maxTurns: 50,
      };
      if (name === "Explore") return {
        description: "Explore agent",
      };
      return undefined;
    });
  });

  it("sends briefing to LLM via sendUserMessage", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("includes agent type headings in the briefing", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("General Purpose");
    expect(message).toContain("Explore");
  });

  it("includes tool and model info when present", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("**Tools:** file_read, file_write");
    expect(message).toContain("**Default model:** claude-sonnet-4-20250514");
    expect(message).toContain("**Max turns:** 50");
  });

  it("includes the parameters table with all required parameters", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("prompt");
    expect(message).toContain("description");
    expect(message).toContain("agent");
    expect(message).toContain("thinking");
    expect(message).toContain("run_in_background");
    expect(message).toContain("worktree_path");
  });

  it("includes worktree_path usage guidelines", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("worktree_path");
    expect(message).toContain("git worktree of the parent");
    expect(message).toContain("Relative paths");
    expect(message).toContain(".pi/agents/");
  });

  it("includes usage guidelines for background agents", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    const message = mockSendUserMessage.mock.calls[0][0];
    expect(message).toContain("run_in_background");
    expect(message).toContain("do NOT poll");
  });

  it("notifies the user after sending the briefing", async () => {
    const ctx = createMockCtx(["2. Agent briefing", undefined]);
    await showDebugMenu(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Agent briefing sent to LLM", "info");
  });
});
