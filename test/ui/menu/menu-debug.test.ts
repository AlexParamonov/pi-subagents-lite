/**
 * menu-debug-new.test.ts — Tests for showDebugMenu using SelectList.
 *
 * After migration: uses ctx.ui.custom (not ctx.ui.select).
 * The debug menu is a SelectList with 2 items that execute actions on select.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAllTypes, getAvailableTypes, getAgentConfig } from "../../../src/agents/agent-types.js";

// Capture SelectList constructor calls
let selectListCalls: Array<{
  items: any[];
  maxVisible: number;
  onSelect?: (item: any) => void;
  onCancel?: () => void;
}> = [];

let settingsListWrapperCalls: Array<{
  component: any;
  options: any;
}> = [];

vi.mock("@earendil-works/pi-tui", () => {
  return {
    SettingsList: class MockSettingsList {
      constructor() {}
    },
    SelectList: class MockSelectList {
      items: any[];
      maxVisible: number;
      onSelect?: (item: any) => void;
      onCancel?: () => void;
      constructor(items: any[], maxVisible: number, _theme: any) {
        this.items = items;
        this.maxVisible = maxVisible;
        selectListCalls.push(this as any);
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
    },
  };
});

// Capture SettingsListWrapper usage
vi.mock("../../../src/ui/menu/wrappers/settings-list.js", () => ({
  SettingsListWrapper: class MockSettingsListWrapper {
    constructor(component: any, options: any) {
      settingsListWrapperCalls.push({ component, options });
    }
    render() {
      return [];
    }
    handleInput() {}
    invalidate() {}
  },
}));

// Import AFTER mock setup
import { showDebugMenu } from "../../../src/ui/menu/menu-debug.js";

afterEach(() => resetConfig());

describe("showDebugMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    (getAllTypes as any).mockReturnValue([]);
    (getAvailableTypes as any).mockReturnValue([]);
    (getAgentConfig as any).mockImplementation(() => undefined);
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("creates a SelectList with 2 items", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(selectListCalls.length).toBe(1);
    expect(selectListCalls[0].items).toHaveLength(2);
    expect(selectListCalls[0].items[0].value).toBe("agent-types");
    expect(selectListCalls[0].items[1].value).toBe("agent-briefing");
  });

  it("wraps SelectList in SettingsListWrapper with title 'Debug'", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(settingsListWrapperCalls.length).toBe(1);
    expect(settingsListWrapperCalls[0].options.title).toBe("Debug");
  });
});

describe("showDebugMenu — agent types action (SelectList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("shows 'No agent types available' when getAllTypes returns empty", async () => {
    (getAllTypes as any).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    // Simulate selecting "agent-types"
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("lists each agent type with its description", async () => {
    (getAllTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose") return { description: "General-purpose agent" };
      if (name === "Explore") return { description: "Explore agent" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    // The notification text we show the user is the observable outcome.
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("general-purpose");
    expect(msg).toContain("General-purpose agent");
    expect(msg).toContain("Explore");
    expect(msg).toContain("Explore agent");
  });

  it("marks hidden types with [HIDDEN]", async () => {
    (getAllTypes as any).mockReturnValue(["secret-agent"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "secret-agent") return { description: "Hidden agent", hidden: true };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("[HIDDEN]"), "info");
  });

  it("shows model when config has one", async () => {
    (getAllTypes as any).mockReturnValue(["test-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Test agent",
      model: "claude-sonnet-4-20250514",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Model: claude-sonnet-4-20250514"), "info");
  });

  it("shows registered tools when present", async () => {
    (getAllTypes as any).mockReturnValue(["tool-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Agent with tools",
      registeredTools: ["file_read", "file_write"],
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: file_read, file_write"), "info");
  });

  it("shows 'all built-in tools' when registeredTools is absent", async () => {
    (getAllTypes as any).mockReturnValue(["default-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Default agent",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: all built-in tools"), "info");
  });

  it("skips types where getAgentConfig returns undefined", async () => {
    (getAllTypes as any).mockReturnValue(["known", "unknown"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "known") return { description: "Known agent" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("known");
    expect(msg).not.toContain("unknown");
  });

  it("shows source when present", async () => {
    (getAllTypes as any).mockReturnValue(["ext-agent"]);
    (getAgentConfig as any).mockImplementation(() => ({
      description: "Extension agent",
      source: ".pi/agents/ext-agent.md",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Source: .pi/agents/ext-agent.md"), "info");
  });
});

describe("showDebugMenu — agent briefing action (SelectList)", () => {
  let mockSendUserMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    mockSendUserMessage = vi.fn();
    mockModules.mockPiInstance.sendUserMessage = mockSendUserMessage;
    (getAvailableTypes as any).mockReturnValue(["general-purpose", "Explore"]);
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          displayName: "General Purpose",
          description: "General-purpose agent",
          registeredTools: ["file_read", "file_write"],
          model: "claude-sonnet-4-20250514",
          maxTurns: 50,
        };
      if (name === "Explore")
        return {
          description: "Explore agent",
        };
      return undefined;
    });
  });

  it("sends briefing to LLM via sendUserMessage", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("includes agent type headings in the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    // The briefing message sent to the LLM is the observable outcome.
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("General Purpose"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Explore"));
  });

  it("includes tool and model info when present", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** file_read, file_write"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Default model:** claude-sonnet-4-20250514"),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Max turns:** 50"));
  });

  it("includes the parameters table with all required parameters", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("prompt"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("description"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("agent"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("thinking"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
  });

  it("notifies the user after sending the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("includes worktree_path usage guidelines", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("any git repository"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Relative paths"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining(".pi/agents/"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("trust"));
  });

  it("includes usage guidelines for background agents", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("do NOT poll"));
  });
});
