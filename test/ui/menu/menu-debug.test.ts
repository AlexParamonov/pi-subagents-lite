/**
 * menu-debug.test.ts — Tests for showDebugMenu using SelectList.
 *
 * Uses ctx.ui.custom (not ctx.ui.select).
 * The debug menu is a SelectList with 2 items that execute actions on select.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockModules, resetConfig } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import {
  getAllTypes,
  getAvailableTypes,
  getAgentConfig,
  getToolNamesForType,
} from "../../../src/agents/agent-types.js";
import type { AgentConfig } from "../../../src/agents/types.js";
import type { Component, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import type { SettingsListWrapperOptions } from "../../../src/ui/menu/wrappers/settings-list.js";

// Capture SettingsManager creation so the menu's defaultTools read is
// test-controllable without touching real pi settings files.
const codingAgentMock = vi.hoisted(() => ({
  SettingsManager: { create: vi.fn(() => ({ settings: {} })) },
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => codingAgentMock);

// Capture SelectList constructor calls
let selectListCalls: Array<{
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
}> = [];

let settingsListWrapperCalls: Array<{
  component: Component;
  options: SettingsListWrapperOptions;
}> = [];

vi.mock("@earendil-works/pi-tui", () => {
  return {
    SettingsList: class MockSettingsList {
      constructor() {}
    },
    SelectList: class MockSelectList {
      items: SelectItem[];
      maxVisible: number;
      onSelect?: (item: SelectItem) => void;
      onCancel?: () => void;
      constructor(items: SelectItem[], maxVisible: number, _theme: SelectListTheme) {
        this.items = items;
        this.maxVisible = maxVisible;
        selectListCalls.push(this);
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
    constructor(component: Component, options: SettingsListWrapperOptions) {
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
import { findLastAgentCallsFromEntries } from "../../../src/agents/restart-last-agents.js";

/**
 * Assert a getAgentConfig fixture against the real AgentConfig at the mocked
 * module boundary (one cast, pi-boundaries style). Needed for the single
 * fixture that models `source` as a project-local agent path: the debug menu
 * interpolates cfg.source verbatim, but src's AgentConfig.source is
 * "project" | "global", so no typed fixture can carry the path without a
 * boundary assertion.
 */
function asAgentConfig<S extends object>(fake: S): AgentConfig & S {
  return fake as AgentConfig & S;
}

afterEach(() => resetConfig());

describe("showDebugMenu — SelectList migration", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
    vi.mocked(getAllTypes).mockReturnValue([]);
    vi.mocked(getAvailableTypes).mockReturnValue([]);
    vi.mocked(getAgentConfig).mockImplementation(() => undefined);
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
    expect(selectListCalls[0].items).toHaveLength(3);
    expect(selectListCalls[0].items[0].value).toBe("agent-types");
    expect(selectListCalls[0].items[1].value).toBe("agent-briefing");
    expect(selectListCalls[0].items[2].value).toBe("restart-last-agents");
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
    codingAgentMock.SettingsManager.create.mockReturnValue({ settings: {} });
    vi.mocked(getToolNamesForType).mockReturnValue(["read", "bash", "edit", "write"]);
  });

  it("shows 'No agent types available' when getAllTypes returns empty", async () => {
    vi.mocked(getAllTypes).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    // Simulate selecting "agent-types"
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No agent types available"), "info");
    // Empty branch opens no further UI: only the debug menu's custom call
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("lists each agent type with its description", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["general-purpose", "Explore"]);
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose") return { name, description: "General-purpose agent", systemPrompt: "" };
      if (name === "Explore") return { name, description: "Explore agent", systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    // The notification text we show the user is the observable outcome.
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("general-purpose");
    expect(msg).toContain("General-purpose agent");
    expect(msg).toContain("Explore");
    expect(msg).toContain("Explore agent");
  });

  it("marks hidden types with [HIDDEN]", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["secret-agent"]);
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "secret-agent") return { name, description: "Hidden agent", hidden: true, systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("[HIDDEN]"), "info");
  });

  it("shows model when config has one", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["test-agent"]);
    vi.mocked(getAgentConfig).mockImplementation(() => ({
      name: "test-agent",
      description: "Test agent",
      model: "claude-sonnet-4-20250514",
      systemPrompt: "",
    }));
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Model: claude-sonnet-4-20250514"), "info");
  });

  it("shows registered tools when present", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["tool-agent"]);
    vi.mocked(getAgentConfig).mockImplementation(() => ({
      name: "tool-agent",
      description: "Agent with tools",
      systemPrompt: "",
    }));
    vi.mocked(getToolNamesForType).mockReturnValue(["file_read", "file_write"]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: file_read, file_write"), "info");
  });

  it("shows the effective default tool set when registeredTools is absent", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["default-agent"]);
    vi.mocked(getAgentConfig).mockImplementation(() => ({
      name: "default-agent",
      description: "Default agent",
      systemPrompt: "",
    }));
    vi.mocked(getToolNamesForType).mockReturnValue(["read", "bash", "edit", "write"]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: read, bash, edit, write"), "info");
    // The generic "all built-in tools" placeholder is gone.
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("all built-in tools"), "info");
  });

  it("reads defaultTools through the shared accessor and feeds the resolver", async () => {
    codingAgentMock.SettingsManager.create.mockReturnValue({
      settings: { defaultTools: ["read", "bash", "grep"] },
    });
    vi.mocked(getAllTypes).mockReturnValue(["general-purpose"]);
    vi.mocked(getAgentConfig).mockImplementation(() => ({
      name: "general-purpose",
      description: "General-purpose agent",
      systemPrompt: "",
    }));
    vi.mocked(getToolNamesForType).mockReturnValue(["read", "bash", "grep"]);
    const ctx = { ...createMockCtx(), cwd: "/repo" };
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    // Same manager acquisition as the spawn path: SettingsManager over cwd + agent dir.
    expect(codingAgentMock.SettingsManager.create).toHaveBeenCalledWith("/repo", "/home/test/.pi/agent");
    expect(getToolNamesForType).toHaveBeenCalledWith("general-purpose", ["read", "bash", "grep"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: read, bash, grep"), "info");
  });

  it("shows '(none)' when the effective tool set is empty", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["tool-agent"]);
    vi.mocked(getAgentConfig).mockImplementation(() => ({
      name: "tool-agent",
      description: "Agent with no tools",
      systemPrompt: "",
    }));
    vi.mocked(getToolNamesForType).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tools: (none)"), "info");
  });

  it("skips types where getAgentConfig returns undefined", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["known", "unknown"]);
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "known") return { name, description: "Known agent", systemPrompt: "" };
      return undefined;
    });
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
    const [msg] = ctx.ui.notify.mock.calls[0];
    expect(msg).toContain("known");
    expect(msg).not.toContain("unknown");
  });

  it("shows source when present", async () => {
    vi.mocked(getAllTypes).mockReturnValue(["ext-agent"]);
    vi.mocked(getAgentConfig).mockImplementation(() =>
      asAgentConfig({
        name: "ext-agent",
        description: "Extension agent",
        systemPrompt: "",
        source: ".pi/agents/ext-agent.md",
      }),
    );
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-types", label: "Agent types" });
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
    codingAgentMock.SettingsManager.create.mockReturnValue({ settings: {} });
    vi.mocked(getAvailableTypes).mockReturnValue(["general-purpose", "Explore"]);
    vi.mocked(getAgentConfig).mockImplementation((name: string) => {
      if (name === "general-purpose")
        return {
          name,
          displayName: "General Purpose",
          description: "General-purpose agent",
          registeredTools: ["file_read", "file_write"],
          model: "claude-sonnet-4-20250514",
          maxTurns: 50,
          systemPrompt: "",
        };
      if (name === "Explore")
        return {
          name,
          description: "Explore agent",
          systemPrompt: "",
        };
      return undefined;
    });
    // Tools resolve per type: explicit for general-purpose, default set for Explore.
    vi.mocked(getToolNamesForType).mockImplementation((name: string) =>
      name === "general-purpose" ? ["file_read", "file_write"] : ["read", "bash", "edit", "write"],
    );
  });

  it("sends briefing to LLM via sendUserMessage", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("includes agent type headings in the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    // The briefing message sent to the LLM is the observable outcome.
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("General Purpose"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Explore"));
  });

  it("includes tool and model info when present", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** file_read, file_write"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("**Default model:** claude-sonnet-4-20250514"),
    );
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Max turns:** 50"));
  });

  it("includes the parameters table with all required parameters", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("prompt"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("description"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("agent"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("thinking"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
  });
  it("always includes a Tools line, with the effective set when registeredTools is absent", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** file_read, file_write"));
    // Explore has no explicit registeredTools: the default set still renders.
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** read, bash, edit, write"));
  });

  it("shows '(none)' for an empty effective tool set in the briefing", async () => {
    vi.mocked(getToolNamesForType).mockReturnValue([]);
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("**Tools:** (none)"));
  });

  it("notifies the user after sending the briefing", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
  });

  it("includes worktree_path usage guidelines", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("worktree_path"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("any git repository"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Relative paths"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining(".pi/agents/"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("trust"));
  });

  it("includes usage guidelines for background agents", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    selectListCalls[0].onSelect!({ value: "agent-briefing", label: "Agent briefing" });
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("run_in_background"));
    expect(mockSendUserMessage).toHaveBeenCalledWith(expect.stringContaining("do NOT poll"));
  });
});

describe("showDebugMenu — restart last agents action (SelectList)", () => {
  beforeEach(() => {
    selectListCalls = [];
    settingsListWrapperCalls = [];
    vi.clearAllMocks();
  });

  it("has a restart-last-agents menu item as the third option", async () => {
    const ctx = createMockCtx();
    await showDebugMenu(ctx);
    expect(selectListCalls[0].items[2].value).toBe("restart-last-agents");
    expect(selectListCalls[0].items[2].label).toBe("Restart last agents");
  });

  it("notifies when no Agent tool calls exist in session history", async () => {
    const ctx = createMockCtx();
    // Mock sessionManager.getEntries to return empty
    ctx.sessionManager = { getEntries: vi.fn(() => []) };
    await showDebugMenu(ctx);
    await selectListCalls[0].onSelect!({ value: "restart-last-agents", label: "Restart last agents" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No recent Agent tool calls found"), "info");
  });
});
