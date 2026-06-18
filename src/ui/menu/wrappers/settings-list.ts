/**
 * settings-list-wrapper.ts — Frames a list component with a title bar and separators.
 *
 * Wraps a SettingsList or SelectList with:
 * - Top separator line
 * - Header with title
 * - List content
 * - Bottom separator line
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

    // Append Back item when onCancel provided
    if (options.onCancel) {
      const list = this.settingsList as any;
      if (Array.isArray(list.items)) {
        const closeMenu = options.onCancel;
        // SelectList has onSelect; SettingsList has onChange. Push correct item shape.
        const isSelectList = !!list.onSelect;
        if (isSelectList) {
          // SelectList expects SelectItem shape: { value, label }
          list.items.push(
            { value: "__sep__", label: " " },
            { value: "__back__", label: "Back" },
          );
          // Intercept onSelect so the Back item closes the menu. SelectList
          // reads its own onSelect property at dispatch time (this.onSelect on
          // the target), so reassigning it here is what actually works — a Proxy
          // cannot intercept the dispatch.
          const prevOnSelect = list.onSelect;
          list.onSelect = (item: any) => {
            if (item.value === "__back__") {
              closeMenu();
              return;
            }
            if (item.value === "__sep__") return;
            prevOnSelect?.(item);
          };
          list.onCancel = () => closeMenu();
        } else {
          // SettingsList expects SettingItem shape: { id, label, currentValue, submenu }
          list.items.push(
            { id: "__sep__", label: " ", currentValue: "" },
            {
              id: "__back__",
              label: "Back",
              currentValue: "",
              submenu: (_v: string, subDone: (v?: string) => void) => {
                subDone();
                closeMenu();
                return undefined as any;
              },
            },
          );
        }
        }

        // Auto-skip __sep__ items when navigating.
        const _rawIndex = Symbol("rawIndex");
        const isSep = (item: any) => item?.value === "__sep__" || item?.id === "__sep__";
        Object.defineProperty(list, "selectedIndex", {
          get() { return list[_rawIndex] ?? 0; },
          set(idx) {
            const curItems = list.items;
            const cur = list[_rawIndex] ?? 0;
            let i = Math.max(0, Math.min(idx, curItems.length - 1));
            if (isSep(curItems[i])) {
              const down = idx > cur;
              if (down) {
                let next = i + 1;
                while (next < curItems.length && isSep(curItems[next])) next++;
                if (next < curItems.length) i = next;
                else {
                  next = i - 1;
                  while (next >= 0 && isSep(curItems[next])) next--;
                  if (next >= 0) i = next;
                }
              } else {
                let next = i - 1;
                while (next >= 0 && isSep(curItems[next])) next--;
                if (next >= 0) i = next;
                else {
                  next = i + 1;
                  while (next < curItems.length && isSep(curItems[next])) next++;
                  if (next < curItems.length) i = next;
                }
              }
            }
            list[_rawIndex] = i;
          },
          configurable: true,
        });
        list[_rawIndex] = list.selectedIndex ?? 0;

      // Expose rebuild callback
      if (options.onRebuild) {
        const isSelectList = !!list.onSelect;
        const rebuild = (newItems: any[]) => {
          const wrapperItems = [
            isSelectList
              ? { value: "__sep__", label: " " }
              : { id: "__sep__", label: " ", currentValue: "" },
            isSelectList
              ? { value: "__back__", label: "Back" }
              : { id: "__back__", label: "Back", currentValue: "" },
          ];
          const fullItems = [...newItems, ...wrapperItems];
          list.items = fullItems;
          list.filteredItems = fullItems;
          list.selectedIndex = 0;
          list.submenuComponent = null;
        };
        options.onRebuild(rebuild);
      }
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

    // SettingsList content
    const settingsLines = this.settingsList.render(width);
    lines.push(...settingsLines);

    // Bottom separator
    lines.push("");
    lines.push(this.separatorChar.repeat(width));

    return lines;
  }
}
