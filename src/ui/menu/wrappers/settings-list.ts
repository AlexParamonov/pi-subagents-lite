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
 * The Back button was removed; menus close via Escape, back-arrow, and Ctrl-C.
 * The list components call `onCancel` on those keys, which the wrapper wires
 * to `closeMenu` for SelectList (SettingsList gets its own at construction).
 */

import { type Component, isFocusable } from "@earendil-works/pi-tui";
import { installSeparatorSkip } from "../helpers.js";

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

/**
 * Horizontal arrow encodings (with and without the CSI "O" prefix) mapped to
 * the key they act as on the main list: → enters the selected item, ←
 * escapes. On a submenu they pass through unchanged (Input needs them for
 * cursor movement).
 */
const HORIZONTAL_ARROWS = new Map<string, string>([
  ["\x1b[C", "\r"],
  ["\x1bOC", "\r"],
  ["\x1b[D", "\x1b"],
  ["\x1bOD", "\x1b"],
]);

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

    // Auto-skip separator items when navigating, so the cursor never lands on a
    // section header. Menus push their own SEPARATOR_ID items.
    if (options.onCancel) {
      installSeparatorSkip(list);
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

  private get submenuComponent(): Component | null {
    return ((this.settingsList as any)?.submenuComponent ?? null) as Component | null;
  }

  private get hasSubmenu(): boolean {
    return isFocusable(this.submenuComponent);
  }

  /**
   * True when the active submenu's leaf accepts text input, so j/k must stay
   * letters (SearchableSelectDialog filter, Input fields). Walks delegator
   * wrappers (getActive) to the leaf — nested delegators (mode picker →
   * nested level picker) are two hops; the walk is unbounded by construction.
   * Duck-typed on the text API: getValue (Input) or searchInput
   * (SearchableSelectDialog).
   */
  private isTextInputSubmenu(): boolean {
    let leaf = this.submenuComponent;
    while (leaf && typeof (leaf as any).getActive === "function") {
      leaf = ((leaf as any).getActive() as Component | null) ?? null;
    }
    if (!leaf) return false;
    const anyLeaf = leaf as any;
    return typeof anyLeaf.getValue === "function" || anyLeaf.searchInput != null;
  }

  handleInput(data: string): void {
    if (this.passthroughKeys) {
      this.settingsList.handleInput?.(data);
      return;
    }
    // j/k move the main list and list-type submenus; they stay letters only
    // when the active submenu accepts text (searchable picker filter,
    // numeric/text fields).
    if (data === "k" || data === "j") {
      const arrow = data === "k" ? "\x1b[A" : "\x1b[B";
      const isTextInput = this.hasSubmenu && this.isTextInputSubmenu();
      this.settingsList.handleInput?.(isTextInput ? data : arrow);
      return;
    }
    // Main list: → enters, ← escapes. Submenu: pass arrow keys through
    // (Input needs them for cursor movement).
    const mainListKey = HORIZONTAL_ARROWS.get(data);
    if (mainListKey !== undefined && !this.hasSubmenu) {
      this.settingsList.handleInput?.(mainListKey);
      return;
    }
    this.settingsList.handleInput?.(data);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Top separator
    lines.push(this.separatorChar.repeat(width));
    lines.push("");

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
