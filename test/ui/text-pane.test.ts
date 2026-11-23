/**
 * text-pane.test.ts — The extension's scrolling text overlay.
 *
 * The seam is `showTextPane` driven through a `ui.custom` that hands back the component it was
 * given, so every assertion reads the frame the pane paints and the input it accepts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "../../src/ui/types.js";
import { showTextPane, type TextPane } from "../../src/ui/text-pane.js";
import { defaultTheme } from "../mock-utils.js";
import { asTui, asUiCustom } from "../pi-boundaries.js";

/** What `ui.custom` hands pi: the frame, the keys, and the teardown on close. */
interface PaneComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

const requestRender = vi.fn<() => void>();
const done = vi.fn<(result: undefined) => void>();

let pane: PaneComponent | undefined;
let customOptions: unknown;

const ui = {
  custom: asUiCustom(async (factory: unknown, options?: unknown) => {
    customOptions = options;
    pane = (factory as (tui: unknown, theme: Theme, kb: unknown, done: (r: undefined) => void) => PaneComponent)(
      asTui({ terminal: { rows: 40, cols: 120 }, requestRender }),
      defaultTheme,
      undefined,
      done,
    );
    return undefined;
  }),
} as unknown as ExtensionUIContext;

/** The viewport rows: everything under the title's separator, footer and border removed. */
function shownRows(): string[] {
  const frame = pane!.render(80).map((line) => line.replace(/^│ /, "").replace(/ │$/, "").trimEnd());
  const separator = frame.findIndex((line) => /^─+$/.test(line));
  const rows = frame.slice(separator + 1, frame.length - 2);
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

function open(source: Partial<TextPane> & { rows: TextPane["rows"] }): Promise<void> {
  pane = undefined;
  return showTextPane(ui, { title: "audit · a1b2c3d4", ...source });
}

beforeEach(() => {
  vi.clearAllMocks();
  customOptions = undefined;
});

describe("the rows a pane shows", () => {
  it("paints the caller's rows in order, and nothing else", async () => {
    const opened = open({
      rows: () => ["\u25b6 analysis dispatched", "  analysis tool read_file", "  Inspecting the diff."],
    });

    expect(shownRows()).toEqual(["\u25b6 analysis dispatched", "  analysis tool read_file", "  Inspecting the diff."]);
    await opened;
  });

  it("shows the newest rows in place of the ones it showed, never after them", async () => {
    let items = ["\u25b6 analysis dispatched"];
    const opened = open({ rows: () => items });
    pane!.render(80);

    items = ["\u2713 analysis completed", "  Inspecting the diff."];
    pane!.render(80);

    expect(shownRows()).toEqual(["\u2713 analysis completed", "  Inspecting the diff."]);
    await opened;
  });

  it("keeps the last row of a source longer than the viewport on screen", async () => {
    const items = Array.from({ length: 40 }, (_unused, index) => `line ${index}`);
    const opened = open({ rows: () => items });

    const rows = shownRows();

    expect(rows).toHaveLength(23);
    expect(rows[0]).toBe("line 17");
    expect(rows.at(-1)).toBe("line 39");
    await opened;
  });
});

describe("the keys a pane owns", () => {
  it("closes on q", async () => {
    const opened = open({ rows: () => ["one"] });

    pane!.handleInput("q");

    expect(done).toHaveBeenCalledTimes(1);
    await opened;
  });

  it("closes on Escape", async () => {
    const opened = open({ rows: () => ["one"] });

    pane!.handleInput("\u001b");

    expect(done).toHaveBeenCalledTimes(1);
    await opened;
  });

  it("scrolls back to a row above the viewport and forward again", async () => {
    const items = Array.from({ length: 40 }, (_unused, index) => `line ${index}`);
    const opened = open({ rows: () => items });
    pane!.render(80);

    pane!.handleInput("\u001b[H");
    const top = shownRows();
    pane!.handleInput("\u001b[F");
    const bottom = shownRows();

    expect(top[0]).toBe("line 0");
    expect(bottom.at(-1)).toBe("line 39");
    await opened;
  });
});

describe("a pane opened over the conversation", () => {
  it("opens as an overlay, so the run's rows are shown wherever the pane was opened from", async () => {
    const opened = open({ rows: () => ["one"] });

    expect(customOptions).toEqual({ overlay: true });
    await opened;
  });
});

describe("repainting a live source", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a repaint when the rows it shows are no longer the rows its source has", async () => {
    let items = ["\u25b6 analysis dispatched"];
    const opened = open({ rows: () => items, refreshMs: 250 });
    pane!.render(80);
    requestRender.mockClear();

    items = ["\u2713 analysis completed"];
    vi.advanceTimersByTime(250);

    expect(requestRender).toHaveBeenCalled();
    expect(shownRows()[0]).toBe("\u2713 analysis completed");
    await opened;
  });

  it("asks for no repaint while its source has nothing new to show", async () => {
    const opened = open({ rows: () => ["\u25b6 analysis dispatched"], refreshMs: 250 });
    pane!.render(80);
    requestRender.mockClear();

    vi.advanceTimersByTime(1000);

    expect(requestRender).not.toHaveBeenCalled();
    await opened;
  });

  it("stops asking once closed", async () => {
    let items = ["\u25b6 analysis dispatched"];
    const opened = open({ rows: () => items, refreshMs: 250 });
    pane!.render(80);
    requestRender.mockClear();

    pane!.dispose!();
    items = ["\u2713 analysis completed"];
    vi.advanceTimersByTime(1000);

    expect(requestRender).not.toHaveBeenCalled();
    await opened;
  });
});
