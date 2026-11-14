/**
 * overlay.ts — Geometry shared by the extension's full-window overlays.
 */

/** Floor for the content rows an overlay shows, however short the terminal is. */
const MIN_VIEWPORT_ROWS = 3;
/** Overlay height as a share of terminal rows, so the bordered box fits without clipping. */
const HEIGHT_PCT = 70;

/**
 * Content rows an overlay may paint: the capped window height minus its fixed
 * chrome (borders, header, footer). Each overlay counts its own chrome, so one
 * restyle cannot leave an overlay rendering more rows than the window shows.
 */
export function overlayViewportRows(terminalRows: number, chromeRows: number): number {
  return Math.max(MIN_VIEWPORT_ROWS, Math.floor((terminalRows * HEIGHT_PCT) / 100) - chromeRows);
}
