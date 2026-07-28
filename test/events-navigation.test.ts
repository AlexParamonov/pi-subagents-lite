/**
 * events-navigation.test.ts — Tests for the real navigation key handler from events.ts.
 *
 * Drives createNavInputHandler with stubbed shell singletons (getManager, getWidget)
 * and a minimal ctx. Every assertion exercises the actual handler code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/home/test/.pi/agent",
}));
import { createNavInputHandler } from "../src/events.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const mockMatchesKey = vi.fn();
const mockIsKeyRelease = vi.fn(() => false);

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: (...args: any[]) => mockMatchesKey(...args),
  isKeyRelease: (...args: any[]) => mockIsKeyRelease(...args),
  truncateToWidth: (text: string, width: number) => text,
  Editor: class Editor {},
  Container: class Container {},
  Markdown: class Markdown {},
  Spacer: class Spacer {},
  Text: class Text {},
  getKeybindings: () => [],
  visibleWidth: (text: string) => text.length,
}));

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => []),
  setAgentScanDirs: vi.fn(),
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn(async () => new Map()),
  mergeAgents: vi.fn((...maps: Map[][]) => {
    const merged = new Map();
    for (const m of maps) for (const [k, v] of m) merged.set(k, v);
    return merged;
  }),
}));

vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class AgentManager {
    listAgents() { return []; }
    getAgent() { return undefined; }
    setConcurrency() {}
    getTotalAgentCost() { return 0; }
    setOnComplete() {}
    dispose() { return Promise.resolve(); }
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class AgentWidget {},
}));

vi.mock("../src/ui/result-viewer.js", () => ({
  ResultViewer: class ResultViewer {},
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class SpawnCoordinator {},
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  toolCallListener: vi.fn(),
}));

vi.mock("../src/registration.js", () => ({
  registerAgentTool: vi.fn(),
}));

vi.mock("../src/prompt/context.js", () => ({
  buildSnapshotMarkdown: vi.fn(() => ""),
}));

vi.mock("../src/ui/format.js", () => ({
  formatMs: vi.fn(() => "0s"),
  buildStatsParts: vi.fn(() => []),
  getDisplayName: vi.fn((type: string) => type),
  truncateDesc: vi.fn((desc: string) => desc),
}));

const mockManager: any = {
  listAgents: vi.fn(() => []),
  getTotalAgentCost: vi.fn(() => 0),
};

const mockWidget: any = {
  isViewerOpen: vi.fn(() => false),
  isEditorFocused: vi.fn(() => true),
  isNavActive: vi.fn(() => false),
  navActivate: vi.fn(),
  navUp: vi.fn(),
  navDown: vi.fn(),
  navSelect: vi.fn(() => null),
  navDeactivate: vi.fn(),
  setViewerOpen: vi.fn(),
  highlightedIndex: vi.fn(() => 0),
  hasVisibleAgents: vi.fn(() => true),
  update: vi.fn(),
};

const mockStore: any = {
  notifyToolsExpanded: vi.fn(),
};

vi.mock("../src/shell.js", () => ({
  getManager: () => mockManager,
  getWidget: () => mockWidget,
  getStore: () => mockStore,
  getCoordinator: () => ({}),
  getPiInstance: () => ({}),
  getSessionCtx: () => ({}),
  setSessionCtx: vi.fn(),
  setManager: vi.fn(),
  setWidget: vi.fn(),
  setCoordinator: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("navigation key handler (createNavInputHandler)", () => {
  let ctx: ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWidget.isViewerOpen.mockReturnValue(false);
    mockWidget.isEditorFocused.mockReturnValue(true);
    mockWidget.isNavActive.mockReturnValue(false);
    mockWidget.highlightedIndex.mockReturnValue(0);
    mockManager.listAgents.mockReturnValue([]);
    mockMatchesKey.mockReturnValue(false);
    mockIsKeyRelease.mockReturnValue(false);
    ctx = {
      ui: {
        getEditorText: vi.fn(() => ""),
        notify: vi.fn(),
      },
    } as unknown as ExtensionContext;
  });

  describe("key release ignored", () => {
    it("returns undefined for key release events", () => {
      mockIsKeyRelease.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_key");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("viewer open guard", () => {
    it("returns undefined when viewer is open", () => {
      mockWidget.isViewerOpen.mockReturnValue(true);
      mockMatchesKey.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("editor focus check", () => {
    it("deactivates nav and returns undefined when editor not focused", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("does nothing when editor not focused and nav inactive", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(false);
      const handler = createNavInputHandler(ctx);
      const result = handler("down");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).not.toHaveBeenCalled();
    });
  });

  describe("activation", () => {
    it("activates on down + empty editor + agents exist", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      (ctx.ui.getEditorText as any).mockReturnValue("");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navActivate).toHaveBeenCalled();
    });

    it("does not activate when editor has text", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      (ctx.ui.getEditorText as any).mockReturnValue("hello");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate when no visible agents", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockWidget.hasVisibleAgents.mockReturnValue(false);
      (ctx.ui.getEditorText as any).mockReturnValue("");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate on non-down key", () => {
      mockMatchesKey.mockReturnValue(false);
      mockWidget.hasVisibleAgents.mockReturnValue(true);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("navigation when active", () => {
    beforeEach(() => {
      mockWidget.isNavActive.mockReturnValue(true);
    });

    it("handles down arrow", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDown).toHaveBeenCalled();
    });

    it("handles up arrow", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(2);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navUp).toHaveBeenCalled();
    });

    it("wraps on up at index 0", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(0);
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navUp).toHaveBeenCalled();
      expect(mockWidget.navDeactivate).not.toHaveBeenCalled();
    });

    it("handles escape", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "escape");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("handles enter and calls navSelect", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      const handler = createNavInputHandler(ctx);
      const result = handler("some_data");
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navSelect).toHaveBeenCalled();
    });

    it("deactivates on non-navigation key", () => {
      mockMatchesKey.mockReturnValue(false);
      const handler = createNavInputHandler(ctx);
      const result = handler("a");
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });
  });
});
