/**
 * result-viewer.ts — TUI scrollable markdown viewer for agent results.
 *
 * Used by the /agents > running agents menu to display agent results
 * in a bordered, scrollable panel with keyboard navigation.
 * Renders markdown so headings, code blocks, lists, etc. are styled.
 */

import {
  Container,
  type Component,
  getKeybindings,
  Markdown,
  Spacer,
  Text,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { type LifetimeUsage, formatTokens } from "./usage.js";
import type { Theme } from "./ui/agent-widget.js";
import { formatMs } from "./format.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ResultViewerCallbacks {
  onClose: () => void;
  /** Called on 'r' press — returns fresh markdown text, or undefined to skip refresh. */
  onRefresh?: () => string | undefined;
}

export interface ResultViewerStats {
  lifetimeUsage: LifetimeUsage;
  turnCount?: number;
  durationMs?: number;
}

/* ------------------------------------------------------------------ */
/*  ResultViewer                                                       */
/* ------------------------------------------------------------------ */

/** Lines scrolled per PageUp/PageDown (kept at a fixed, comfortable amount). */
const PAGE_STEP = 14;

/** Render width for markdown content and separator line. */
const RENDER_WIDTH = 78;

/** Fixed non-viewport lines in the component (borders, title, spacers, hints, etc.). */
const BASE_OVERHEAD = 10;

/** Extra overhead lines for the stats title line (spacer + text). */
const STATS_OVERHEAD = 2;

/** Minimum viewport content lines regardless of terminal size. */
const MIN_VIEWPORT = 20;

/**
 * Build a MarkdownTheme from the TUI theme instance.
 */
function buildMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text: string) => theme.fg("accent", theme.bold(text)),
    link: (text: string) => theme.fg("accent", text),
    linkUrl: (text: string) => theme.fg("muted", text),
    code: (text: string) => theme.fg("accent", text),
    codeBlock: (text: string) => text,
    codeBlockBorder: (text: string) => theme.fg("muted", text),
    quote: (text: string) => theme.fg("muted", text),
    quoteBorder: (text: string) => theme.fg("muted", text),
    hr: (text: string) => theme.fg("muted", text),
    listBullet: (text: string) => theme.fg("accent", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => (theme.italic ? theme.italic(text) : text),
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  };
}

/**
 * A scrollable markdown viewer with bordered frame.
 *
 * Rendering:
 *   - Top border
 *   - Title bar with agent info
 *   - Separator
 *   - Paginated markdown content (dynamically sized to at least 50% of terminal)
 *   - Scroll position indicator (when scrollable)
 *   - Key hints footer
 *   - Bottom border
 *
 * Key bindings: up/down/pageup/pagedown/g/G/f(ullscreen)/escape
 */
export class ResultViewer extends Container implements Component {
  private markdown: Markdown;
  private renderedLines: string[];
  private viewport!: Container;
  private scrollIndicator!: Container;
  private scrollOffset: number;
  private theme: Theme;
  private callbacks: ResultViewerCallbacks;
  private fullScreen: boolean;
  private _viewportSize: number;
  private terminalHeight: number;
  private textRef: { text: string }; // mutable ref for refresh

  /**
   * Current number of content lines displayed in the viewport.
   * Varies based on terminal height and full-screen mode.
   */
  get viewportSize(): number {
    return this._viewportSize;
  }

  /** Whether the viewer is currently in full-screen mode. */
  get isFullScreen(): boolean {
    return this.fullScreen;
  }

  /** Whether stats line is shown. Used for viewport sizing. */
  private hasStats: boolean;

  constructor(
    title: string,
    text: string,
    callbacks: ResultViewerCallbacks,
    theme: Theme,
    terminalHeight: number = 24,
    stats?: ResultViewerStats,
  ) {
    super();

    this.callbacks = callbacks;
    this.theme = theme;
    this.scrollOffset = 0;
    this.fullScreen = true;
    this.terminalHeight = terminalHeight;
    this.hasStats = stats != null;
    this._viewportSize = computeViewportSize(terminalHeight, true, this.hasStats);
    this.textRef = { text };

    // Build markdown renderer (pre-render to get total lines)
    const mdTheme = buildMarkdownTheme(theme);
    this.markdown = new Markdown(text, 0, 0, mdTheme);
    this.renderedLines = this.markdown.render(RENDER_WIDTH);

    this.buildUI(title, stats);
    this.updateViewport();
  }

  /** Build the full UI tree — borders, title, stats, viewport, hints. */
  private buildUI(title: string, stats?: ResultViewerStats): void {
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    // Title bar
    this.addChild(
      new Text(this.theme.fg("accent", this.theme.bold(` ${title}`)), 0, 0),
    );

    // Stats line (below title, above separator)
    if (stats) {
      this.addChild(new Spacer(1));
      this.addChild(
        new Text(this.theme.fg("dim", this.formatStatsLine(stats)), 0, 0),
      );
    }

    this.addChild(new Spacer(1));

    // Separator
    this.addChild(
      new Text(this.theme.fg("muted", "─".repeat(RENDER_WIDTH)), 0, 0),
    );
    this.addChild(new Spacer(1));

    // Scrollable viewport
    this.viewport = new Container();
    this.addChild(this.viewport);

    // Scroll position indicator (outside viewport so it doesn't mix with content)
    this.scrollIndicator = new Container();
    this.addChild(this.scrollIndicator);

    // Bottom spacer + key hints + border
    this.addChild(new Spacer(1));
    const refreshHint = this.callbacks.onRefresh ? " · r refresh" : "";
    const hints = this.theme.fg(
      "muted",
      `  ↑↓ navigate · PgUp/PgDn · g/G top/bottom · f fullscreen · q/Esc close${refreshHint}`,
    );
    this.addChild(new Text(hints, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }

  /**
   * Build the stats line string, e.g.:
   *   " ↑12.0k · ↓8.0k · W3.0k · $0.024 · 15 turns · 47s"
   * Fields with no data are omitted.
   */
  private formatStatsLine(stats: ResultViewerStats): string {
    const parts: string[] = [];

    const { lifetimeUsage } = stats;
    parts.push(`↑${formatTokens(lifetimeUsage.input)}`);
    parts.push(`↓${formatTokens(lifetimeUsage.output)}`);
    parts.push(`W${formatTokens(lifetimeUsage.cacheWrite)}`);
    parts.push(`\$${lifetimeUsage.cost.toFixed(3)}`);

    if (stats.turnCount != null) {
      parts.push(`${stats.turnCount} turns`);
    }
    if (stats.durationMs != null) {
      parts.push(formatMs(stats.durationMs));
    }

    return ` ${parts.join(" · ")}`;
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();

    // Up
    if (kb.matches(keyData, "tui.select.up")) {
      this.scrollTo(this.scrollOffset - 1);
      return;
    }

    // Down
    if (kb.matches(keyData, "tui.select.down")) {
      this.scrollTo(this.scrollOffset + 1);
      return;
    }

    // 'f' — toggle full-screen mode
    if (keyData === "f") {
      this.fullScreen = !this.fullScreen;
      this._viewportSize = computeViewportSize(this.terminalHeight, this.fullScreen, this.hasStats);
      this.updateViewport();
      return;
    }

    // PageUp
    if (kb.matches(keyData, "tui.select.pageUp")) {
      this.scrollTo(this.scrollOffset - PAGE_STEP);
      return;
    }

    // PageDown
    if (kb.matches(keyData, "tui.select.pageDown")) {
      this.scrollTo(this.scrollOffset + PAGE_STEP);
      return;
    }

    // 'g' — jump to top
    if (keyData === "g") {
      this.scrollTo(0);
      return;
    }

    // 'G' — jump to bottom
    if (keyData === "G") {
      this.scrollTo(this.renderedLines.length - 1);
      return;
    }

    // 'r' — refresh content (only if onRefresh callback provided)
    if (keyData === "r" && this.callbacks.onRefresh) {
      const newText = this.callbacks.onRefresh();
      if (newText !== undefined && newText !== this.textRef.text) {
        const oldOffset = this.scrollOffset;
        this.textRef.text = newText;
        const mdTheme = buildMarkdownTheme(this.theme);
        this.markdown = new Markdown(newText, 0, 0, mdTheme);
        this.renderedLines = this.markdown.render(RENDER_WIDTH);
        // Preserve scroll position, clamped to new content bounds
        this.scrollOffset = Math.min(oldOffset, this.renderedLines.length - 1);
        this.updateViewport();
      }
      return;
    }

    // 'q' or Escape / Ctrl+C — close
    if (keyData === "q" || kb.matches(keyData, "tui.select.cancel")) {
      this.callbacks.onClose();
      return;
    }
  }

  invalidate(): void {}

  private scrollTo(offset: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.renderedLines.length - 1, offset));
    this.updateViewport();
  }

  private updateViewport(): void {
    this.viewport.clear();

    const visibleLines = Math.min(
      this._viewportSize,
      this.renderedLines.length - this.scrollOffset,
    );

    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      const line = this.renderedLines[lineIdx] ?? "";
      this.viewport.addChild(new Text(line, 0, 0));
    }

    // Pad AFTER content to keep viewport at fixed height so the footer
    // stays at a consistent screen row. Spacer renders real empty lines
    // (Text("") short-circuits to zero lines).
    const padding = this._viewportSize - visibleLines;
    if (padding > 0) {
      this.viewport.addChild(new Spacer(padding));
    }

    // Scroll position indicator (outside viewport)
    this.scrollIndicator.clear();
    if (this.renderedLines.length > this._viewportSize) {
      const pct = Math.round(
        (this.scrollOffset / this.renderedLines.length) * 100,
      );
      this.scrollIndicator.addChild(new Text(this.theme.fg(
        "muted",
        `  (${this.scrollOffset + 1}/${this.renderedLines.length} · ${pct}%)`,
      ), 0, 0));
    }
  }
}

/**
 * Compute the viewport content line count based on terminal height and full-screen mode.
 * Uses at least 50% of terminal height for the total component; falls back to MIN_VIEWPORT.
 * When hasStats is true, extra lines are reserved for the stats title line.
 */
function computeViewportSize(terminalHeight: number, fullScreen: boolean, hasStats: boolean = false): number {
  const overhead = BASE_OVERHEAD + (hasStats ? STATS_OVERHEAD : 0);
  if (fullScreen) {
    // Nearly full screen: leave a small margin
    return Math.max(MIN_VIEWPORT, terminalHeight - overhead - 2);
  }
  // At least 50% of terminal height
  const raw = Math.floor(terminalHeight / 2) - overhead;
  return Math.max(MIN_VIEWPORT, raw);
}
