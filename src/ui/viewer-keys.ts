/**
 * viewer-keys.ts — Scroll key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** The `tui.select.*` keybinding ids the viewer resolves. */
export type ViewerScrollKeybinding = "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown";

/** Every keybinding id the viewer resolves: scrolling plus pi's tool-output toggle. */
export type ViewerKeybinding = ViewerScrollKeybinding | "app.tools.expand";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybinding): boolean;
  /** Keys bound to an id, for on-screen hints. Optional so partial managers still work. */
  getKeys?(keybinding: ViewerKeybinding): readonly string[];
}

/** pi's default for `app.tools.expand`; used when no keybinding manager is available. */
const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  /** pi's `app.tools.expand` (ctrl+o by default): toggle collapsed/expanded tool output. */
  toggleExpand(data: string): boolean;
  /** Label of the key bound to `toggleExpand`, for "(… to expand)" hints. */
  expandHint(): string;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    toggleExpand: (data) => matches(data, "app.tools.expand", DEFAULT_EXPAND_KEY),
    expandHint: () => keybindings?.getKeys?.("app.tools.expand")?.[0] ?? DEFAULT_EXPAND_KEY,
  };
}
