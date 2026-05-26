/**
 * result-viewer.ts — TUI scrollable text viewer for agent results.
 *
 * Used by the /agents > running agents menu to display agent results
 * in a bordered, scrollable panel with keyboard navigation.
 */

import {
  Container,
  type Component,
  type Focusable,
  getKeybindings,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

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

const PAGE_SIZE = 12;

/**
 * A scrollable text viewer with bordered frame.
 *
 * Rendering:
 *   - Top border
 *   - Title bar with agent info
 *   - Separator
 *   - Scrolled text content
 *   - Scroll position indicator (when scrollable)
 *   - Bottom border with key hints
 *
 * Key bindings: up/down/pageup/pagedown/escape
 */
export class ResultViewer extends Container implements Component {
  private textLines: string[];
  private viewport: Container;
  private scrollOffset: number;
  private totalLines: number;
  private theme: Theme;
  private callbacks: ResultViewerCallbacks;
  private title: string;

  constructor(
    title: string,
    text: string,
    callbacks: ResultViewerCallbacks,
    theme: Theme,
  ) {
    super();

    this.title = title;
    this.textLines = text.split("\n");
    this.totalLines = this.textLines.length;
    this.scrollOffset = 0;
    this.callbacks = callbacks;
    this.theme = theme;

    // Build UI
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));

    // Title bar
    this.addChild(new Text(this.theme.fg("accent", theme.bold(` ${title}`)), 0, 0));
    this.addChild(new Spacer(1));

    // Separator
    this.addChild(new Text(this.theme.fg("muted", "─".repeat(72)), 0, 0));
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
      if (this.scrollOffset < this.totalLines - 1) {
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
      this.scrollOffset = Math.min(this.totalLines - 1, this.scrollOffset + PAGE_SIZE);
      this.updateViewport();
      return;
    }

    // Escape / Ctrl+C — close
    if (kb.matches(keyData, "tui.select.cancel")) {
      this.callbacks.onClose();
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
      this.scrollOffset = this.totalLines - 1;
      this.updateViewport();
      return;
    }
  }

  invalidate(): void {}

  private updateViewport(): void {
    this.viewport.clear();

    const visibleLines = Math.min(PAGE_SIZE + 4, this.totalLines - this.scrollOffset);
    for (let i = 0; i < visibleLines; i++) {
      const lineIdx = this.scrollOffset + i;
      const line = this.textLines[lineIdx] ?? "";
      this.viewport.addChild(new Text(`${line}`, 0, 0));
    }

    // Scroll position indicator
    if (this.totalLines > PAGE_SIZE + 4) {
      const pct = Math.round((this.scrollOffset / this.totalLines) * 100);
      const indicator = this.theme.fg(
        "muted",
        `  (${this.scrollOffset + 1}/${this.totalLines} lines · ${pct}%)`,
      );
      this.viewport.addChild(new Text(indicator, 0, 0));
    }
  }
}
