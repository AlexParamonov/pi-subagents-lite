/**
 * settings-list-wrapper.ts — Frames a list component with a title bar and separators.
 *
 * Wraps a SettingsList or SelectList with:
 * - Top separator line
 * - Header with title
 * - List content (SettingsList renders the highlighted item's description and a
 *   hint line below the items itself; SelectList renders inline descriptions)
 * - Bottom separator line
 *
 * The Back button has been removed. Menus still close via Escape, the
 * back-arrow key, and Ctrl-C — the underlying list components call their
 * `onCancel` on those keys, and the wrapper wires that to `closeMenu` for
 * SelectList (SettingsList receives its own `onCancel` at construction).
 */

import { type Component, isFocusable } from "@earendil-works/pi-tui";

export interface SettingsListWrapperTheme {
  bold: (text: string) => string;
  fg: (color: any, text: string) => string;
}

export interface SettingsListWrapperOptions {
  title: string;
  theme: SettingsListWrapperTheme;
  separatorChar?: string;
  /** If true, skip j/k→arrow and arrow→enter/escape conversion. Input passes through unchanged. */
  passthroughKeys?: boolean;
  onCancel?: () => void;
  /** Called with a rebuild(newItems) function so the caller can trigger in-place updates. */
  onRebuild?: (rebuild: (items: any[]) => void) => void;
}

export class SettingsListWrapper implements Component {
  private settingsList: Component;
  private title: string;
  private theme: SettingsListWrapperTheme;
  private separatorChar: string;
  private passthroughKeys: boolean;

  constructor(settingsList: Component, options: SettingsListWrapperOptions) {
    this.settingsList = settingsList;
    this.title = options.title;
    this.theme = options.theme;
    this.separatorChar = options.separatorChar ?? "─";
    this.passthroughKeys = options.passthroughKeys ?? false;

    const list = this.settingsList as any;

    // SelectList has no onCancel of its own; wire closeMenu so Escape,
    // back-arrow (converted to Escape below), and Ctrl-C close the menu.
    // SettingsList receives its own onCancel at construction, so leave it be.
    if (options.onCancel && !list.onCancel) {
      const closeMenu = options.onCancel;
      list.onCancel = () => closeMenu();
    }

    // Auto-skip __sep__ items when navigating, so the cursor never lands on a
    // separator section header. Menus push their own __sep__ items.
    if (options.onCancel && Array.isArray(list.items)) {
      const _rawIndex = Symbol("rawIndex");
      const isSep = (item: any) => item?.value === "__sep__" || item?.id === "__sep__";
      // Starting just past `start`, walk in `step` direction and return the
      // first non-separator index (or an out-of-bounds sentinel if none).
      const firstNonSepFrom = (start: number, step: number): number => {
        let next = start + step;
        while (next >= 0 && next < list.items.length && isSep(list.items[next])) next += step;
        return next;
      };
      const inBounds = (i: number) => i >= 0 && i < list.items.length;
      Object.defineProperty(list, "selectedIndex", {
        get() { return list[_rawIndex] ?? 0; },
        set(idx) {
          const items = list.items;
          const cur = list[_rawIndex] ?? 0;
          const clamped = Math.max(0, Math.min(idx, items.length - 1));
          if (!isSep(items[clamped])) {
            list[_rawIndex] = clamped;
            return;
          }
          // Landed on a separator: search in the travel direction first,
          // fall back to the opposite direction so the cursor always ends on
          // a real item (or stays put if everything is a separator).
          const step = idx > cur ? 1 : -1;
          const fwd = firstNonSepFrom(clamped, step);
          const back = firstNonSepFrom(clamped, -step);
          list[_rawIndex] = inBounds(fwd) ? fwd : inBounds(back) ? back : clamped;
        },
        configurable: true,
      });
      list[_rawIndex] = list.selectedIndex ?? 0;
    }

    // Expose rebuild callback. Items are set directly without appending any
    // wrapper-controlled items: descriptions are read dynamically at render
    // time, so they remain correct after a rebuild.
    if (options.onRebuild) {
      const rebuild = (newItems: any[]) => {
        list.items = newItems;
        list.filteredItems = newItems;
        list.selectedIndex = 0;
        list.submenuComponent = null;
      };
      options.onRebuild(rebuild);
    }
  }

  invalidate(): void {
    this.settingsList.invalidate?.();
  }

  private get hasSubmenu(): boolean {
    const submenu = (this.settingsList as any)?.submenuComponent ?? null;
    return isFocusable(submenu);
  }

  handleInput(data: string): void {
    if (this.passthroughKeys) {
      this.settingsList.handleInput?.(data);
      return;
    }
    if (data === "k" || data === "j") {
      if (this.hasSubmenu) {
        // Submenu: pass through as normal letters
        this.settingsList.handleInput?.(data);
      } else {
        // Main list: convert to arrow keys
        this.settingsList.handleInput?.(data === "k" ? "\x1b[A" : "\x1b[B");
      }
    } else if (data === "\x1b[C" || data === "\x1bOC" || data === "\x1b[D" || data === "\x1bOD") {
      if (this.hasSubmenu) {
        // Submenu: pass arrow keys through (Input needs them for cursor)
        this.settingsList.handleInput?.(data);
      } else {
        // Main list: → enters, ← escapes
        this.settingsList.handleInput?.(data.includes("C") ? "\r" : "\x1b");
      }
    } else {
      this.settingsList.handleInput?.(data);
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

    // SettingsList content — strip the hint line that pi-tui always appends
    // (empty line + "Enter/Space to change · Esc to cancel"). Descriptions
    // already explain what each item does, so the hint is redundant.
    const settingsLines = this.settingsList.render(width);
    const hintPattern = /Enter\/Space|Esc to cancel/;
    if (settingsLines.length >= 2 && hintPattern.test(settingsLines[settingsLines.length - 1] ?? "")) {
      lines.push(...settingsLines.slice(0, -2));
    } else {
      lines.push(...settingsLines);
    }

    // Bottom separator
    lines.push("");
    lines.push(this.separatorChar.repeat(width));

    return lines;
  }
}
