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

// Theme type from ctx.ui.custom() callback
type Theme = any;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ResultViewerCallbacks {
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  ResultViewer                                                       */
/* ------------------------------------------------------------------ */

const PAGE_SIZE = 14;

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
 *   - Paginated markdown content
 *   - Scroll position indicator (when scrollable)
 *   - Key hints footer
 *   - Bottom border
 *
 * Key bindings: up/down/pageup/pagedown/g/G/escape
 */
export class ResultViewer extends Container implements Component {
  private markdown: Markdown;
  private renderedLines: string[];
  private viewport: Container;
  private scrollOffset: number;
  private theme: Theme;
  private callbacks: ResultViewerCallbacks;

  constructor(
    title: string,
    text: string,
    callbacks: ResultViewerCallbacks,
    theme: Theme,
  ) {
    super();

    this.callbacks = callbacks;
    this.theme = theme;
    this.scrollOffset = 0;

    // Build markdown renderer (pre-render to get total lines)
    const mdTheme = buildMarkdownTheme(theme);
    this.markdown = new Markdown(text, 0, 0, mdTheme);
    // Pre-render at a reasonable width to get line count
    this.renderedLines = this.markdown.render(78);

    // Build UI
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    // Title bar
    this.addChild(
      new Text(this.theme.fg("accent", theme.bold(` ${title}`)), 0, 0),
    );
    this.addChild(new Spacer(1));

    // Separator
    this.addChild(
      new Text(this.theme.fg("muted", "─".repeat(78)), 0, 0),
    );
    this.addChild(new Spacer(1));

    // Scrollable viewport
    this.viewport = new Container();
    this.addChild(this.viewport);

    // Bottom spacer + key hints + border
    this.addChild(new Spacer(1));
    const hints = this.theme.fg(
      "muted",
      "  ↑↓ navigate · PgUp/PgDn · g/G top/bottom · Esc close",
    );
    this.addChild(new Text(hints, 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.updateViewport();
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();

    // Up
    if (kb.matches(keyData, "tui.select.up")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.updateViewport();
      }
      return;
    }

    // Down
    if (kb.matches(keyData, "tui.select.down")) {
      if (this.scrollOffset < this.renderedLines.length - 1) {
        this.scrollOffset++;
        this.updateViewport();
      }
      return;
    }

    // PageUp
    if (kb.matches(keyData, "tui.select.pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - PAGE_SIZE);
      this.updateViewport();
      return;
    }

    // PageDown
    if (kb.matches(keyData, "tui.select.pageDown")) {
      this.scrollOffset = Math.min(
        this.renderedLines.length - 1,
        this.scrollOffset + PAGE_SIZE,
      );
      this.updateViewport();
      return;
    }

    // 'g' — jump to top
    if (keyData === "g") {
      this.scrollOffset = 0;
      this.updateViewport();
      return;
    }

    // 'G' — jump to bottom
    if (keyData === "G") {
      this.scrollOffset = this.renderedLines.length - 1;
      this.updateViewport();
      return;
    }

    // Escape / Ctrl+C — close
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.callbacks.onClose();
      return;
    }
  }

  invalidate(): void {}

  private updateViewport(): void {
    this.viewport.clear();

    const visibleLines = Math.min(
      PAGE_SIZE,
      this.renderedLines.length - this.scrollOffset,
    );
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      const line = this.renderedLines[lineIdx] ?? "";
      this.viewport.addChild(new Text(line, 0, 0));
    }

    // Scroll position indicator
    if (this.renderedLines.length > PAGE_SIZE) {
      const pct = Math.round(
        (this.scrollOffset / this.renderedLines.length) * 100,
      );
      const indicator = this.theme.fg(
        "muted",
        `  (${this.scrollOffset + 1}/${this.renderedLines.length} · ${pct}%)`,
      );
      this.viewport.addChild(new Text(indicator, 0, 0));
    }
  }
}
