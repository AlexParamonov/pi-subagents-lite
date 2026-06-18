/**
 * settings-list-wrapper.ts — Wrapper component that adds header/footer to SettingsList.
 *
 * Wraps a SettingsList with:
 * - Top separator line
 * - Header with title
 * - SettingsList content
 * - Bottom separator line
 * - Footer with navigation hints
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
  footerText?: string;
  /** If true, skip j/k→arrow and arrow→enter/escape conversion. Input passes through unchanged. */
  passthroughKeys?: boolean;
  onCancel?: () => void;
}

export class SettingsListWrapper implements Component {
  private settingsList: Component;
  private title: string;
  private theme: SettingsListWrapperTheme;
  private separatorChar: string;
  private footerText: string;
  private passthroughKeys: boolean;

  constructor(settingsList: Component, options: SettingsListWrapperOptions) {
    this.settingsList = settingsList;
    this.title = options.title;
    this.theme = options.theme;
    this.separatorChar = options.separatorChar ?? "─";
    this.footerText = options.footerText ?? "Enter/→ to change · Esc to cancel";
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
            { value: "__sep__", label: "" },
            { value: "__back__", label: "Back" },
          );
          // Proxy to intercept onSelect assignment (caller sets it after constructor)
          let selectHandler: ((item: any) => void) | undefined;
          const proxied = new Proxy(list, {
            set(target, prop, value) {
              if (prop === "onSelect") {
                selectHandler = value;
                return true;
              }
              target[prop] = value;
              return true;
            },
            defineProperty(_target, prop, descriptor) {
              if (prop === "onSelect" && descriptor.value) {
                selectHandler = descriptor.value;
                return true;
              }
              return Reflect.defineProperty(_target, prop, descriptor);
            },
          });
          // Replace onSelect with wrapper that handles Back + delegates
          proxied.onSelect = (item: any) => {
            if (item.value === "__back__") {
              closeMenu();
              return;
            }
            if (selectHandler) selectHandler(item);
          };
          this.settingsList = proxied;
        } else {
          // SettingsList expects SettingItem shape: { id, label, currentValue, submenu }
          list.items.push(
            { id: "__sep__", label: "", currentValue: "" },
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
