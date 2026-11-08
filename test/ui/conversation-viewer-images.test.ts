/**
 * conversation-viewer-images.test.ts — Inline images in the viewer's tool results.
 *
 * Runs on the real pi-tui (its Image component, capability detection and width
 * math), so what is asserted is what a Kitty terminal would be sent.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resetCapabilitiesCache, setCapabilities, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ConversationViewer, type ToolDisplayOptions } from "../../src/ui/conversation-viewer.js";
import type { Theme } from "../../src/ui/types.js";
import { makeAgentRecord } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";

vi.mock("../../src/pi-settings.js", () => ({
  getHideThinkingBlock: vi.fn(() => false),
  readPiSettings: vi.fn(),
}));

/** 2x2 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4EIwESMolGFRCsEAGVDAgtxLPlvAAAAAElFTkSuQmCC";
const KITTY = "\x1b_G";

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

interface FakeSession {
  messages: unknown[];
  subscribe: () => () => void;
}

function sessionWithImage(content: unknown[] = [{ type: "image", data: PNG, mimeType: "image/png" }], lead = false) {
  const filler = {
    role: "assistant",
    content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `filler ${i}`).join("\n\n") }],
  };
  const session: FakeSession = {
    messages: [
      ...(lead ? [filler] : []),
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.png" } }] },
      { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content },
      ...(lead ? [filler] : []),
    ],
    subscribe: () => () => {},
  };
  return asAgentSession(session);
}

function open(options: ToolDisplayOptions = {}, termRows = 60, content?: unknown[], lead = false, compact = false) {
  const session = sessionWithImage(content, lead);
  const record = makeAgentRecord({ execution: { settled: false, settlementCount: 0, session } });
  const tui = { terminal: { rows: termRows, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
  return new ConversationViewer(tui, session, record, theme, vi.fn(), {
    toolDisplay: options,
    compactToolCalls: compact,
  });
}

function useImages(images: "kitty" | "iterm2" | null) {
  setCapabilities({ images, trueColor: true, hyperlinks: false });
}

/** Kitty `key=value` controls of the one image sequence in `lines`. */
function kittyControls(lines: string[]): Record<string, string> {
  const joined = lines.join("\n");
  // The sequence starts with ESC.
  // oxlint-disable-next-line no-control-regex
  const match = /\x1b_G([^;]*);/.exec(joined);
  if (!match) return {};
  return Object.fromEntries(match[1].split(",").map((pair) => pair.split("=") as [string, string]));
}

const sequenceRows = (lines: string[]) => lines.filter((line) => line.includes(KITTY));

afterEach(() => resetCapabilitiesCache());

describe("ConversationViewer tool result images", () => {
  it("draws a Kitty image in place, inside the borders, for pi's imageWidthCells", () => {
    useImages("kitty");
    const lines = open().render(80);

    const [row] = sequenceRows(lines);
    expect(sequenceRows(lines)).toHaveLength(1);
    expect(row.startsWith("│ ")).toBe(true);
    expect(row.endsWith(" │")).toBe(true);
    // The image sequence takes no columns: every row, drawn or not, is exactly as wide as the viewer.
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
    const controls = kittyControls(lines);
    expect(controls.C).toBe("1"); // cursor stays put, so the right border still lands in place
    expect(Number(controls.c)).toBeLessThanOrEqual(60);
  });

  describe("in compact mode", () => {
    const call = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.png` } });
    const text = (id: string) => ({
      role: "toolResult",
      toolCallId: id,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
    const image = (id: string) => ({
      role: "toolResult",
      toolCallId: id,
      isError: false,
      content: [{ type: "image", data: PNG, mimeType: "image/png" }],
    });
    const openCompact = (messages: unknown[]) => {
      const session = asAgentSession({ messages, subscribe: () => () => {} } satisfies FakeSession);
      const record = makeAgentRecord({ execution: { settled: false, settlementCount: 0, session } });
      const tui = { terminal: { rows: 60, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
      return new ConversationViewer(tui, session, record, theme, vi.fn(), { compactToolCalls: true });
    };

    it("draws the image right after its call's row", () => {
      useImages("kitty");
      const lines = open({}, 60, undefined, false, true).render(80);

      const callRow = lines.findIndex((line) => line.includes("read"));
      const imageRow = lines.findIndex((line) => line.includes(KITTY));
      expect(callRow).toBeGreaterThan(-1);
      // One blank row separates the call from its image, as in pi.
      expect(lines[callRow + 1].replace(/[│ ]/g, "")).toBe("");
      expect(imageRow).toBe(callRow + 2);
    });

    it("lists no image text line, because compact mode prints no result text", () => {
      useImages("kitty");
      const lines = open({}, 60, undefined, false, true).render(80);

      expect(lines.some((line) => line.includes("[Image"))).toBe(false);
    });

    it("keeps a call with a drawn image out of a run, so the image follows that call", () => {
      useImages("kitty");
      const lines = openCompact([
        { role: "assistant", content: [call("a"), call("b"), call("c")] },
        text("a"),
        image("b"),
        text("c"),
      ]).render(80);

      expect(lines.some((line) => line.includes("tools ("))).toBe(false);
      expect(sequenceRows(lines)).toHaveLength(1);
    });

    it("still summarizes a run when no image is drawn", () => {
      useImages(null);
      const lines = openCompact([
        { role: "assistant", content: [call("a"), call("b"), call("c")] },
        text("a"),
        image("b"),
        text("c"),
      ]).render(80);

      expect(lines.some((line) => line.includes("3 tools (read)"))).toBe(true);
    });
  });

  it("reserves the image's rows below the sequence", () => {
    useImages("kitty");
    const lines = open().render(80);
    const rows = Number(kittyControls(lines).r);
    const start = lines.findIndex((line) => line.includes(KITTY));

    expect(rows).toBeGreaterThan(1);
    for (const line of lines.slice(start + 1, start + rows)) expect(line.replace(/[│ ]/g, "")).toBe("");
  });

  it("honors terminal.imageWidthCells", () => {
    useImages("kitty");
    const lines = open({ imageWidthCells: 10 }).render(80);

    expect(Number(kittyControls(lines).c)).toBe(10);
  });

  it("keeps the image id when it is re-rendered at another width", () => {
    useImages("kitty");
    const viewer = open();
    const first = kittyControls(viewer.render(80)).i;

    expect(first).toBeDefined();
    expect(kittyControls(viewer.render(100)).i).toBe(first);
  });

  it("caps the image height to what fits the viewer", () => {
    useImages("kitty");
    const short = Number(kittyControls(open({}, 30).render(80)).r);
    const tall = Number(kittyControls(open({}, 60).render(80)).r);

    // 30 rows -> viewport of 14 rows, so the image is at most 12 rows
    expect(short).toBeLessThanOrEqual(12);
    expect(tall).toBeGreaterThan(short);
  });

  it("re-fits the image when the terminal height changes", () => {
    useImages("kitty");
    const session = sessionWithImage();
    const record = makeAgentRecord({ execution: { settled: false, settlementCount: 0, session } });
    const terminal = { rows: 60, columns: 100 };
    const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
    const viewer = new ConversationViewer(tui, session, record, theme, vi.fn(), { compactToolCalls: false });
    const before = Number(kittyControls(viewer.render(80)).r);

    terminal.rows = 30;

    expect(Number(kittyControls(viewer.render(80)).r)).toBeLessThan(before);
  });

  describe("when the image is not drawn", () => {
    it.each([
      ["images are off in the terminal", () => useImages(null), {}],
      ["terminal.showImages is false", () => useImages("kitty"), { showImages: false }],
      ["the terminal uses the iTerm2 protocol", () => useImages("iterm2"), {}],
    ])("lists it like pi does when %s", (_name, setup, options) => {
      setup();
      const lines = open(options).render(80);

      expect(lines.join("\n")).not.toContain("\x1b_G");
      expect(lines.join("\n")).not.toContain("\x1b]1337");
      expect(lines.some((line) => line.includes("[Image: [image/png] 2x2]"))).toBe(true);
    });

    it("lists an image block that has no data, even when images are drawn", () => {
      useImages("kitty");
      const lines = open({}, 60, [{ type: "image" }]).render(80);

      expect(sequenceRows(lines)).toHaveLength(0);
      expect(lines.some((line) => line.includes("[Image: [image/unknown]]"))).toBe(true);
    });
  });

  describe("scrolling", () => {
    // 40 terminal rows -> 21-row viewport, images capped at 12 rows.
    // Filler above and below, so the image can be scrolled through the window.
    const tall = () => {
      const viewer = open({}, 40, undefined, true);
      viewer.render(80); // the first render sets the width scrolling works with
      return viewer;
    };
    const separators = (frame: string[]) => frame.map((line, n) => (line.includes("─") ? n : -1)).filter((n) => n >= 0);

    it("draws the image below the tool block, outside its background", () => {
      useImages("kitty");
      const viewer = tall();
      // Scroll down from the top until the image is whole in the window.
      viewer.handleInput("\x1b[H");
      let frame: string[] = [];
      for (let i = 0; i < 200 && sequenceRows(frame).length === 0; i++) {
        viewer.handleInput("\x1b[B");
        frame = viewer.render(80);
      }
      const at = frame.findIndex((line) => line.includes(KITTY));

      expect(at).toBeGreaterThan(0);
      expect(frame[at - 1].replace(/[│ ]/g, "")).toBe(""); // blank row above, like pi's spacer
    });

    it("re-places only the visible rows of a partly scrolled image, inside the viewport", () => {
      useImages("kitty");
      const viewer = tall();
      viewer.handleInput("\x1b[H"); // top
      let whole = 0;
      let cropped = 0;
      for (let i = 0; i < 200; i++) {
        viewer.handleInput("\x1b[B"); // down, one row at a time
        const frame = viewer.render(80);
        const controls = kittyControls(frame);
        if (controls.r === undefined) continue;
        const rows = Number(controls.r);
        whole = Math.max(whole, rows);
        const start = frame.findIndex((line) => line.includes(KITTY));
        const seps = separators(frame);
        // every drawn row sits between the header separator and the footer separator
        expect(start).toBeGreaterThan(seps[1]);
        expect(start + rows).toBeLessThanOrEqual(seps[2]);
        if (rows < whole) {
          cropped++;
          expect(controls.h).toBeDefined(); // a source rectangle, not a squashed image
          expect(Number(controls.h)).toBeLessThanOrEqual(2); // never taller than the 2px source
        }
      }
      expect(whole).toBeGreaterThan(1);
      expect(cropped).toBeGreaterThan(0);
    });

    it("anchors the crop at the first visible row once the image's own first row has scrolled off", () => {
      useImages("kitty");
      const viewer = tall();
      const frames: string[][] = [];
      viewer.handleInput("\x1b[H"); // top
      for (let i = 0; i < 200; i++) {
        viewer.handleInput("\x1b[B");
        frames.push(viewer.render(80));
      }
      const topCropped = frames.find((frame) => Number(kittyControls(frame).y) > 0);

      expect(topCropped).toBeDefined();
      const seps = separators(topCropped!);
      expect(topCropped!.findIndex((line) => line.includes(KITTY))).toBe(seps[1] + 1);
    });

    it("draws nothing when the image is scrolled out of the viewport", () => {
      useImages("kitty");
      const viewer = tall();
      viewer.handleInput("\x1b[H"); // top: the image is far below

      expect(sequenceRows(viewer.render(80))).toHaveLength(0);
    });
  });
});
