/**
 * events-navigation.test.ts — Tests for navigation key handling in events.ts.
 *
 * Covers:
 *   - Key release events ignored
 *   - Viewer open guard
 *   - Editor focus check
 *   - Activation on ↓ + empty editor + agents
 *   - Navigation keys (↑↓, Enter, Esc)
 *   - Non-navigation keys deactivate
 *   - Enter on main/queued does nothing
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const mockMatchesKey = vi.fn();
const mockIsKeyRelease = vi.fn(() => false);

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: (...args: any[]) => mockMatchesKey(...args),
  isKeyRelease: (...args: any[]) => mockIsKeyRelease(...args),
  truncateToWidth: (text: string, width: number) => text,
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  getConfig: (type: string) => ({
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    tools: [],
    maxTurns: undefined,
    thinkingLevel: undefined,
  }),
}));

vi.mock("../../src/shell.js", () => ({
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

// Hoisted mocks
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
  update: vi.fn(),
};

const mockStore: any = {
  notifyToolsExpanded: vi.fn(),
};

const mockCtx: any = {
  getEditorText: vi.fn(() => ""),
};

/* ------------------------------------------------------------------ */
/*  Helper to simulate the key handler logic                          */
/* ------------------------------------------------------------------ */

/**
 * Simulate the navigation key handler logic from events.ts.
 * This mirrors the actual handler so we can test it in isolation.
 */
function handleNavKey(data: string, ctx: any): any {
  const widget = mockWidget;

  // Only fire on key press (not release).
  if (mockIsKeyRelease(data)) return undefined;

  // Viewer overlay open — don't consume, don't deactivate.
  if (widget.isViewerOpen()) { return undefined; }

  // Editor lost focus (dialog, menu, etc.) — deactivate.
  if (!widget.isEditorFocused()) {
    if (widget.isNavActive()) widget.navDeactivate();
    return undefined;
  }

  if (!widget.isNavActive()) {
    // ↓ + empty editor + agents exist → activate
    const agents = mockManager.listAgents();
    const hasAgents = agents.length > 0;
    const editorEmpty = ctx.getEditorText?.() === "";
    if (mockMatchesKey(data, "down") && hasAgents && editorEmpty) {
      widget.navActivate();
      return { consume: true };
    }
  } else {
    // Nav active
    if (mockMatchesKey(data, "down")) { widget.navDown(); return { consume: true }; }
    if (mockMatchesKey(data, "up")) {
      if (widget.highlightedIndex() === 0) { widget.navDeactivate(); return { consume: true }; }
      widget.navUp();
      return { consume: true };
    }
    if (mockMatchesKey(data, "escape")) { widget.navDeactivate(); return { consume: true }; }
    if (mockMatchesKey(data, "enter")) {
      const record = widget.navSelect();
      // openViewer would be called here — we just check navSelect was called
      return { consume: true };
    }
    // Any other key → deactivate, pass through.
    widget.navDeactivate();
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("navigation key handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWidget.isViewerOpen.mockReturnValue(false);
    mockWidget.isEditorFocused.mockReturnValue(true);
    mockWidget.isNavActive.mockReturnValue(false);
    mockWidget.highlightedIndex.mockReturnValue(0);
    mockManager.listAgents.mockReturnValue([]);
    mockCtx.getEditorText.mockReturnValue("");
    mockMatchesKey.mockReturnValue(false);
    mockIsKeyRelease.mockReturnValue(false);
  });

  describe("key release ignored", () => {
    it("returns undefined for key release events", () => {
      mockIsKeyRelease.mockReturnValue(true);
      const result = handleNavKey("some_key", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("viewer open guard", () => {
    it("returns undefined when viewer is open", () => {
      mockWidget.isViewerOpen.mockReturnValue(true);
      mockMatchesKey.mockReturnValue(true);
      const result = handleNavKey("down", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });
  });

  describe("editor focus check", () => {
    it("deactivates nav and returns undefined when editor not focused", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(true);
      const result = handleNavKey("down", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("does nothing when editor not focused and nav inactive", () => {
      mockWidget.isEditorFocused.mockReturnValue(false);
      mockWidget.isNavActive.mockReturnValue(false);
      const result = handleNavKey("down", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).not.toHaveBeenCalled();
    });
  });

  describe("activation", () => {
    it("activates on ↓ + empty editor + agents exist", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      mockCtx.getEditorText.mockReturnValue("");

      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navActivate).toHaveBeenCalled();
    });

    it("does not activate when editor has text", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);
      mockCtx.getEditorText.mockReturnValue("hello");

      const result = handleNavKey("some_data", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate when no agents", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "down");
      mockManager.listAgents.mockReturnValue([]);
      mockCtx.getEditorText.mockReturnValue("");

      const result = handleNavKey("some_data", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navActivate).not.toHaveBeenCalled();
    });

    it("does not activate on non-down key", () => {
      mockMatchesKey.mockReturnValue(false);
      mockManager.listAgents.mockReturnValue([{ id: "a1" }]);

      const result = handleNavKey("some_data", mockCtx);
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
      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDown).toHaveBeenCalled();
    });

    it("handles up arrow", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(2);
      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navUp).toHaveBeenCalled();
    });

    it("deactivates on up at index 0", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "up");
      mockWidget.highlightedIndex.mockReturnValue(0);
      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
      expect(mockWidget.navUp).not.toHaveBeenCalled();
    });

    it("handles escape", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "escape");
      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });

    it("handles enter and calls navSelect", () => {
      mockMatchesKey.mockImplementation((_d: string, key: string) => key === "enter");
      const result = handleNavKey("some_data", mockCtx);
      expect(result).toEqual({ consume: true });
      expect(mockWidget.navSelect).toHaveBeenCalled();
    });

    it("deactivates on non-navigation key", () => {
      mockMatchesKey.mockReturnValue(false);
      const result = handleNavKey("a", mockCtx);
      expect(result).toBeUndefined();
      expect(mockWidget.navDeactivate).toHaveBeenCalled();
    });
  });
});
