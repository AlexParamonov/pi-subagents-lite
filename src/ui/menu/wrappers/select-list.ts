/**
 * select-list-wrapper.ts — Wrapper component that adds header/footer to SelectList.
 *
 * Wraps a SelectList with:
 * - Top separator line
 * - Header with title (bold, accent-colored)
 * - SelectList content
 * - Bottom separator line
 */

import { type Component, isFocusable, SelectList } from "@earendil-works/pi-tui";

export interface SelectListWrapperTheme {
  bold: (text: string) => string;
  fg: (color: any, text: string) => string;
}

export interface SelectListWrapperOptions {
  title: string;
  theme: SelectListWrapperTheme;
  separatorChar?: string;
  onCancel?: () => void;
}

export class SelectListWrapper implements Component {
  private selectList: Component;
  private title: string;
  private theme: SelectListWrapperTheme;
  private separatorChar: string;

  constructor(selectList: Component, options: SelectListWrapperOptions) {
    this.selectList = selectList;
    this.title = options.title;
    this.theme = options.theme;
    this.separatorChar = options.separatorChar ?? "─";

    // Append Back item and wire cancel
    if (options.onCancel) {
      const list = this.selectList as any;
      list.items = [...list.items, { value: "", label: "", description: "" }, { value: "__back__", label: "Back", description: "" }];
      const prevOnSelect = list.onSelect;
      list.onSelect = (item: any) => {
        if (item.value === "__back__") {
          options.onCancel!();
        } else {
          prevOnSelect?.(item);
        }
      };
      list.onCancel = () => options.onCancel!();
    }
  }

  invalidate(): void {
    this.selectList.invalidate?.();
  }

  private get hasSubmenu(): boolean {
    const submenu = (this.selectList as any).submenuComponent;
    return submenu != null && isFocusable(submenu);
  }

  handleInput(data: string): void {
    if (data === "k" || data === "j") {
      if (this.hasSubmenu) {
        this.selectList.handleInput?.(data);
      } else {
        this.selectList.handleInput?.(data === "k" ? "\x1b[A" : "\x1b[B");
      }
    } else if (data === "\x1b[C" || data === "\x1bOC" || data === "\x1b[D" || data === "\x1bOD") {
      if (this.hasSubmenu) {
        this.selectList.handleInput?.(data);
      } else {
        this.selectList.handleInput?.(data.includes("C") ? "\r" : "\x1b");
      }
    } else {
      this.selectList.handleInput?.(data);
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Top separator
    lines.push(this.separatorChar.repeat(width));
    lines.push("");

    // Header (left-aligned with spacing, bold and colored)
    const styledTitle = this.theme.bold(this.theme.fg("accent", this.title));
    lines.push("  " + styledTitle);
    lines.push("");

    // SelectList content
    const listLines = this.selectList.render(width);
    lines.push(...listLines);

    // Bottom separator
    lines.push("");
    lines.push(this.separatorChar.repeat(width));

    return lines;
  }
}
