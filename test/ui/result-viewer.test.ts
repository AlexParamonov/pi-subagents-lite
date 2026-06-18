/**
 * result-viewer.test.ts — Tests for the scrollable markdown ResultViewer.
 *
 * Covers:
 *   - Dynamic viewport sizing based on terminal height
 *   - Full-screen toggle ('f' key)
 *   - Scroll key handling (up/down/pageup/pagedown/g/G/escape)
 *   - Scroll indicator visibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mock classes — class declarations are hoisted, so they are
// available when hoisted vi.mock factories run.
// ---------------------------------------------------------------------------

const mockClasses = vi.hoisted(() => {
  class MockContainer {
    children: any[] = [];
    addChild(c: any) {
      this.children.push(c);
    }
    removeChild(_c: any) {
      /* noop */
    }
    clear() {
      this.children = [];
    }
    invalidate() {
      /* noop */
    }
    render(_width: number): string[] {
      return [];
    }
  }

  class MockText {
    text: string;
    constructor(text: string, _x?: number, _y?: number) {
      this.text = text;
    }
  }

  class MockSpacer {}
  class MockDynamicBorder {}

  const markdownRender = vi.fn((_width: number) => []);

  return { MockContainer, MockText, MockSpacer, MockDynamicBorder, markdownRender };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Container: mockClasses.MockContainer,
  Text: mockClasses.MockText,
  Spacer: mockClasses.MockSpacer,
  Markdown: class {
    text: string;
    constructor(text: string, _w: number, _h: number, _theme: any) {
      this.text = text;
    }
    render(width: number) {
      return mockClasses.markdownRender(width);
    }
  },
  getKeybindings: () => ({
    matches: (key: string, binding: string) => {
      const map: Record<string, string[]> = {
        "tui.select.up": ["\x1b[A"],
        "tui.select.down": ["\x1b[B"],
        "tui.select.pageUp": ["\x1b[5~"],
        "tui.select.pageDown": ["\x1b[6~"],
        "tui.select.cancel": ["\x1b", "\x03"],
      };
      const expected = map[binding];
      if (expected === undefined) return false;
      return expected.includes(key);
    },
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: mockClasses.MockDynamicBorder,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ResultViewer, type ResultViewerStats } from "../../src/ui/result-viewer.js";

// Destructure hoisted mock classes for use in test helpers (not vi.mock factories).
const { MockContainer, MockText, markdownRender } = mockClasses;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopTheme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

const dummyCallbacks = { onClose: vi.fn() };

/** Extract all text from the entire component's children (viewport + indicator) */
function collectAllText(viewer: ResultViewer): string[] {
  const children = (viewer as any).children || [];
  const texts: string[] = [];
  for (const child of children) {
    if (child instanceof MockText) {
      texts.push(child.text);
    } else if (child && child.children) {
      // Container with nested children (viewport, scrollIndicator)
      for (const nested of child.children) {
        if (nested instanceof MockText) {
          texts.push(nested.text);
        }
      }
    }
  }
  return texts;
}

/** Extract all text content from the viewer's top-level children */
function collectTopLevelText(viewer: ResultViewer): string[] {
  return (viewer as any).children
    .filter((c: any) => c instanceof MockText)
    .map((c: any) => c.text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultViewer viewport sizing", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("uses at least 14 viewport lines with default terminal height (24)", () => {
    const viewer = new ResultViewer(
      "test",
      "some content",
      dummyCallbacks,
      noopTheme,
    );

    // default terminalHeight = 24 => 50% = 12, minus overhead(10) = 2, min 14
    expect(viewer.viewportSize).toBe(20);
  });

  it("computes viewport size as ~50% of terminal height for large terminals", () => {
    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      60,
    );

    // Full-screen: 60 - 10(overhead) - 2(margin) = 48
    expect(viewer.viewportSize).toBe(48);
  });

  it("scales viewport proportionally for medium terminals", () => {
    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      50,
    );

    // Full-screen: 50 - 10(overhead) - 2(margin) = 38
    expect(viewer.viewportSize).toBe(38);
  });

  it("never goes below 14 even for small terminals", () => {
    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      18,
    );

    // 50% of 18 = 9, minus overhead(10) = -1, min 14
    expect(viewer.viewportSize).toBe(20);
  });
});

describe("ResultViewer full-screen toggle", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("starts in full-screen mode", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    expect(viewer.isFullScreen).toBe(true);
    expect(viewer.viewportSize).toBeGreaterThan(20);
  });

  it("toggles to normal mode on 'f' key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    const fullSize = viewer.viewportSize;

    viewer.handleInput("f");

    expect(viewer.isFullScreen).toBe(false);
    expect(viewer.viewportSize).toBeLessThan(fullSize);
  });

  it("toggles back to full-screen on second 'f' key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    const fullSize = viewer.viewportSize;

    viewer.handleInput("f");
    viewer.handleInput("f");

    expect(viewer.isFullScreen).toBe(true);
    expect(viewer.viewportSize).toBe(fullSize);
  });

  it("full-screen on 50-row terminal uses nearly full height", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 50);

    // Full-screen: 50 - 10(overhead) - 2(margin) = 38
    expect(viewer.viewportSize).toBe(38);
  });
});

describe("ResultViewer scroll behavior", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    markdownRender.mockReturnValue(lines);
  });

  afterEach(() => {
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("starts at scroll offset 0", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    expect((viewer as any).scrollOffset).toBe(0);
  });

  it("scrolls down on down arrow key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("\x1b[B");
    expect((viewer as any).scrollOffset).toBe(1);
  });

  it("scrolls up on up arrow key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    (viewer as any).scrollOffset = 5;
    viewer.handleInput("\x1b[A");
    expect((viewer as any).scrollOffset).toBe(4);
  });

  it("scrolls down by pageStep on PageDown", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("\x1b[6~");
    expect((viewer as any).scrollOffset).toBe(14);
  });

  it("scrolls up by pageStep on PageUp", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    (viewer as any).scrollOffset = 30;
    viewer.handleInput("\x1b[5~");
    expect((viewer as any).scrollOffset).toBe(16);
  });

  it("jumps to top on 'g' key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    (viewer as any).scrollOffset = 50;
    viewer.handleInput("g");
    expect((viewer as any).scrollOffset).toBe(0);
  });

  it("jumps to bottom on 'G' key", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("G");
    expect((viewer as any).scrollOffset).toBe(99);
  });

  it("closes on Escape", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("\x1b");
    expect(dummyCallbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Ctrl+C", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("\x03");
    expect(dummyCallbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on q", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("q");
    expect(dummyCallbacks.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not scroll past end", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    (viewer as any).scrollOffset = 99;
    viewer.handleInput("\x1b[B");
    expect((viewer as any).scrollOffset).toBe(99);
  });

  it("does not scroll before start", () => {
    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme);
    viewer.handleInput("\x1b[A");
    expect((viewer as any).scrollOffset).toBe(0);
  });
});

describe("ResultViewer scroll indicator", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
  });

  it("shows indicator when content exceeds viewport", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    markdownRender.mockReturnValue(lines);

    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    const text = collectAllText(viewer);
    const hasIndicator = text.some((t) => t.includes("/50") || t.includes("%"));
    expect(hasIndicator).toBe(true);
  });

  it("hides indicator when content fits in viewport", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}`);
    markdownRender.mockReturnValue(lines);

    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    const text = collectAllText(viewer);
    const hasIndicator = text.some((t) => t.includes("/") && t.includes("%"));
    expect(hasIndicator).toBe(false);
  });

  it("updates indicator position after scrolling", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    markdownRender.mockReturnValue(lines);

    const viewer = new ResultViewer("test", "content", dummyCallbacks, noopTheme, 40);
    viewer.handleInput("G");

    const text = collectAllText(viewer);
    const indicator = text.find((t) => t.includes("/50"));
    expect(indicator).toBeDefined();
    expect(indicator).toContain("50/50");
  });
});

describe("ResultViewer constructor", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("accepts optional terminalHeight parameter", () => {
    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      60,
    );
    expect(viewer).toBeDefined();
    expect(viewer.viewportSize).toBeGreaterThanOrEqual(20);
  });

  it("works with markdown content", () => {
    const md = "# Heading\n**bold** text\n- list item";
    markdownRender.mockReturnValue(md.split("\n"));

    const viewer = new ResultViewer("test", md, dummyCallbacks, noopTheme);
    expect(viewer).toBeDefined();

    expect(markdownRender).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  ResultViewer stats line                                           */
/* ------------------------------------------------------------------ */

describe("ResultViewer stats line", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("renders stats line below title when stats provided", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      turnCount: 15,
      durationMs: 47000,
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    // Title is at index 0, stats line at index 1
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeDefined();
    expect(statsLine).toContain("↑12.0k");
    expect(statsLine).toContain("↓8.0k");
    expect(statsLine).toContain("W3.0k");
    expect(statsLine).toContain("$0.024");
    expect(statsLine).toContain("15 turns");
    expect(statsLine).toContain("47s");
  });

  it("omits stats line when no stats provided (backward compat)", () => {
    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
    );

    const texts = collectTopLevelText(viewer);
    // Check that no line matches the stats pattern " ↑<number>..."
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeUndefined();
  });

  it("omits turn count when turnCount is undefined", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 100, cost: 0.01 },
      durationMs: 10000,
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeDefined();
    expect(statsLine).not.toContain("turns");
  });

  it("omits duration when durationMs is undefined", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 1000, output: 500, cacheWrite: 100, cost: 0.01 },
      turnCount: 5,
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeDefined();
    expect(statsLine).not.toMatch(/\d+s$/);
  });

  it("shows model name before token usage when modelName is provided", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      turnCount: 15,
      durationMs: 47000,
      modelName: "gpt-4o",
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    const statsLine = texts.find((t) => t.includes("↑12.0k"));
    expect(statsLine).toBeDefined();
    expect(statsLine).toMatch(/^ gpt-4o · ↑/);
  });

  it("omits model name prefix when modelName is undefined", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 },
      turnCount: 15,
      durationMs: 47000,
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeDefined();
    expect(statsLine).toMatch(/^ ↑/);
  });

  it("handles zero usage values", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      turnCount: 0,
      durationMs: 0,
    };

    const viewer = new ResultViewer(
      "test",
      "content",
      dummyCallbacks,
      noopTheme,
      40,
      stats,
    );

    const texts = collectTopLevelText(viewer);
    const statsLine = texts.find((t) => /^ ↑\d/.test(t));
    expect(statsLine).toBeDefined();
    expect(statsLine).toContain("↑0");
    expect(statsLine).toContain("↓0");
    expect(statsLine).toContain("W0");
    expect(statsLine).toContain("$0.000");
  });
});

describe("ResultViewer viewport sizing with stats", () => {
  beforeEach(() => {
    dummyCallbacks.onClose.mockReset();
    markdownRender.mockReset();
    markdownRender.mockReturnValue([]);
  });

  it("reduces viewport by 2 lines when stats are shown", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 100, output: 100, cacheWrite: 0, cost: 0 },
    };

    const noStats = new ResultViewer(
      "test", "content", dummyCallbacks, noopTheme, 60,
    );
    const withStats = new ResultViewer(
      "test", "content", dummyCallbacks, noopTheme, 60, stats,
    );

    // Full-screen without stats: 60 - 10(overhead) - 2(margin) = 48
    expect(noStats.viewportSize).toBe(48);
    // Full-screen with stats: 60 - 12(overhead) - 2(margin) = 46
    expect(withStats.viewportSize).toBe(46);
  });

  it("full-screen accounts for stats line", () => {
    const stats: ResultViewerStats = {
      lifetimeUsage: { input: 100, output: 100, cacheWrite: 0, cost: 0 },
    };

    const viewer = new ResultViewer(
      "test", "content", dummyCallbacks, noopTheme, 50, stats,
    );

    // Already full-screen by default: 50 - 12(overhead) - 2(margin) = 36
    expect(viewer.viewportSize).toBe(36);
  });
});
