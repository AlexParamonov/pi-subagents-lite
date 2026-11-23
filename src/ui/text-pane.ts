/**
 * text-pane.ts — The extension's scrolling text overlay.
 *
 * One read-only bordered pane: a title, rows the caller already painted, and a footer naming the keys
 * it owns. Rows are read again on every render, so a source that changes while the pane is open is
 * followed; `refreshMs` is what asks for that repaint when nothing else would.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { overlayViewportRows } from "./overlay.ts";
import type { Theme } from "./types.ts";

/** Fixed chrome rows: top border + title + separator + footer + bottom border. */
const CHROME_ROWS = 5;

export interface TextPane {
  /** The title row, as text: the pane paints it as it paints every title. */
  title: string;
  /** The rows to show, painted for the pane's theme. Read again on every render. */
  rows: (theme: Theme) => string[];
  /** Repaint interval for a source that changes while the pane is open. Omitted for a frozen text. */
  refreshMs?: number;
}

/** Show one pane over the conversation, and answer when it closes. */
export function showTextPane(ui: ExtensionUIContext, pane: TextPane): Promise<void> {
  return ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const border = theme.fg("border", "\u2502");
      const viewportRows = () => overlayViewportRows(tui.terminal.rows, CHROME_ROWS);
      let scrollOffset = 0;
      let autoScroll = true;
      /** The rows the last render painted, so a tick that changed nothing asks for no frame. */
      let painted = "";
      const timer =
        pane.refreshMs === undefined
          ? undefined
          : setInterval(() => {
              const rows = pane.rows(theme).join("\n");
              if (rows !== painted) tui.requestRender();
            }, pane.refreshMs);

      const component: Component & { dispose(): void } = {
        invalidate() {},
        render(width: number) {
          const innerW = width - 4;
          const rows = pane.rows(theme);
          painted = rows.join("\n");
          const out: string[] = [theme.fg("border", `\u256d${"\u2500".repeat(width - 2)}\u256e`)];

          const titleStr = theme.bold(theme.fg("accent", pane.title));
          const titlePad = Math.max(0, innerW - visibleWidth(titleStr));
          out.push(`${border} ${truncateToWidth(titleStr + " ".repeat(titlePad), innerW, "...", true)} ${border}`);
          out.push(`${border} ${theme.fg("dim", "\u2500".repeat(innerW))} ${border}`);

          const viewport = viewportRows();
          const maxScroll = Math.max(0, rows.length - viewport);
          if (autoScroll) scrollOffset = maxScroll;
          const from = Math.min(scrollOffset, maxScroll);
          for (let row = 0; row < viewport; row++) {
            const line = truncateToWidth(rows[from + row] ?? "", innerW, "...", true);
            const pad = Math.max(0, innerW - visibleWidth(line));
            out.push(`${border} ${line}${" ".repeat(pad)} ${border}`);
          }

          const percent = rows.length <= viewport ? "100%" : `${Math.round(((from + viewport) / rows.length) * 100)}%`;
          const count = theme.fg("dim", `${rows.length} lines \u00b7 ${percent}`);
          const keys = theme.fg("dim", "q/Esc close");
          const gap = Math.max(1, innerW - visibleWidth(count) - visibleWidth(keys));
          out.push(`${border} ${count}${" ".repeat(gap)}${keys} ${border}`);
          out.push(theme.fg("border", `\u2570${"\u2500".repeat(width - 2)}\u256f`));
          return out;
        },
        handleInput(data: string) {
          if (matchesKey(data, "q") || matchesKey(data, "escape")) {
            done();
            return;
          }
          const viewport = viewportRows();
          const maxScroll = Math.max(0, pane.rows(theme).length - viewport);
          const jump = (offset: number): void => {
            scrollOffset = Math.max(0, Math.min(maxScroll, offset));
            autoScroll = scrollOffset >= maxScroll;
          };

          if (matchesKey(data, "up")) jump(scrollOffset - 1);
          else if (matchesKey(data, "down")) jump(scrollOffset + 1);
          else if (matchesKey(data, "pageUp")) jump(scrollOffset - viewport);
          else if (matchesKey(data, "pageDown")) jump(scrollOffset + viewport);
          else if (matchesKey(data, "home") || data === "g") jump(0);
          else if (matchesKey(data, "end") || data === "G") jump(maxScroll);
        },
        dispose() {
          if (timer !== undefined) clearInterval(timer);
        },
      };
      return component;
    },
    { overlay: true },
  );
}
