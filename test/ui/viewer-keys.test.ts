/**
 * viewer-keys.test.ts — The viewer's key resolution, against pi-tui's real matcher.
 *
 * The viewer can be built with or without pi's keybinding manager, so both paths
 * are pinned here: the fallback must recognize every input format pi delivers
 * (which is pi-tui's matcher doing it, pinned once below), and the manager path
 * must resolve the id rather than a literal key.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import { matchesKey } from "@earendil-works/pi-tui";
import { createViewerKeys } from "../../src/ui/viewer-keys.js";

const LEGACY_CTRL_O = "\u000f"; // control char
const KITTY_CTRL_O = "\x1b[111;5u"; // kitty / modifyOtherKeys encoding of ctrl+o
const ALT_E = "\x1be";

describe("createViewerKeys", () => {
  it("recognizes ctrl+o in every input format pi delivers when no manager is given", () => {
    const keys = createViewerKeys();

    expect(matchesKey(LEGACY_CTRL_O, "ctrl+o")).toBe(true); // lib contract behind the fallback
    expect(keys.toggleExpand(LEGACY_CTRL_O)).toBe(true);
    expect(keys.toggleExpand(KITTY_CTRL_O)).toBe(true);
    expect(keys.toggleExpand("o")).toBe(false);
    expect(keys.toggleExpand("\x03")).toBe(false);
  });

  it("uses the configured expand key instead of the default", () => {
    const matches = vi.fn<(data: string, id: string) => boolean>(
      (data, id) => id === "app.tools.expand" && data === ALT_E,
    );
    const keys = createViewerKeys({ matches, getKeys: () => ["alt+e", "ctrl+o"] });

    expect(keys.toggleExpand(LEGACY_CTRL_O)).toBe(false); // the default, unbound for this user
    expect(keys.toggleExpand(ALT_E)).toBe(true);
  });

  it("keeps scrolling on the manager's select ids", () => {
    const matches = vi.fn<(data: string, id: string) => boolean>((_data, id) => id === "tui.select.pageUp");
    const keys = createViewerKeys({ matches });

    expect(keys.pageUp("\x1b[5~")).toBe(true);
    expect(keys.scrollUp("k")).toBe(true); // the vim key is local to the viewer
    expect(keys.pageDown("\x1b[6~")).toBe(false);
  });
});
