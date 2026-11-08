/**
 * viewer-images.ts — Inline images in the conversation viewer's tool results.
 *
 * Rendering is pi's own: pi-tui's `Image` component, so `terminal.images`
 * (settings override or autodetected protocol), the PNG transcoder pi registers
 * for non-PNG images and the text fallback all behave as in pi's chat. Only
 * the Kitty protocol is drawn inline here: it does not move the cursor, so the
 * viewer's border and padding can share a row with the image. Other terminals
 * get pi's text indicator (`[image/png 800x600]`), as when images are off.
 */

import { getCapabilities, getImageDimensions, getPngDimensions, Image, imageFallback } from "@earendil-works/pi-tui";

/** pi's default `terminal.imageWidthCells`. */
const DEFAULT_WIDTH_CELLS = 60;
const KITTY_PREFIX = "\x1b_G";

/** An image block of a tool result, as pi-ai types it. */
export interface ImageBlock {
  data: string;
  mimeType: string;
}

/**
 * Rows of a drawn image in the viewer's content lines. The terminal draws an
 * image whole from its anchor row, so when the viewer's window cuts it off the
 * visible part is re-placed with `cropKittyImageLine` (or, if that cannot be
 * done, a `placeholder` row over `blank` ones).
 */
export interface ImageSpan {
  start: number;
  rows: number;
  /** The image's first line: the Kitty sequence that places all `rows`. */
  line: string;
  /** A content row holding `text`, in the tool block's background and padding. */
  makeRow: (text: string) => string;
  blank: string;
  placeholder: string;
}

export interface ToolImageOptions {
  /** pi's `terminal.showImages`. Omitted -> shown. */
  showImages?: boolean;
  /** pi's `terminal.imageWidthCells`. Omitted -> pi's default. */
  imageWidthCells?: number;
}

function isImageBlock(block: unknown): block is { type: "image"; data?: string; mimeType?: string } {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
}

/** The image blocks of a tool result's content. */
export function imageBlocksOf(content: unknown): { data?: string; mimeType?: string }[] {
  return Array.isArray(content) ? content.filter(isImageBlock) : [];
}

export function isKittyImageLine(line: string): boolean {
  return line.includes(KITTY_PREFIX);
}

/**
 * `line` (an image's Kitty placement) cut down to rows [hiddenRows, hiddenRows + visibleRows) of its
 * `rows`: the same source-rectangle crop pi-tui applies in fullscreen mode, which it does not export.
 * Undefined when the sequence is not one `Image` made or its size cannot be read.
 */
export function cropKittyImageLine(
  line: string,
  rows: number,
  hiddenRows: number,
  visibleRows: number,
): string | undefined {
  // The sequence starts with ESC and ends at the next one (ST).
  // oxlint-disable-next-line no-control-regex
  const match = /\x1b_G([^;]*);([^\x1b]*)/.exec(line);
  if (!match || hiddenRows < 0 || visibleRows <= 0 || hiddenRows + visibleRows > rows) return undefined;
  // Kitty images are PNG here, and the first chunk of the payload holds the header.
  const heightPx = getPngDimensions(match[2])?.heightPx;
  if (!heightPx) return undefined;
  const sourceY = Math.floor((heightPx * hiddenRows) / rows);
  const sourceEnd = Math.ceil((heightPx * (hiddenRows + visibleRows)) / rows);
  const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
  controls.push(`y=${sourceY}`, `h=${Math.max(1, Math.min(heightPx, sourceEnd) - sourceY)}`, `r=${visibleRows}`);
  return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length - match[2].length)}`;
}

interface CachedImage {
  data: string;
  mimeType: string;
  maxRows: number;
  image: Image;
}

export class ToolImages {
  /** Images by `<toolCallId>:<n>`. Kept across re-renders so a Kitty image keeps its id and is replaced, not duplicated. */
  private cache = new Map<string, CachedImage>();

  constructor(
    private options: ToolImageOptions,
    private fallbackColor: (text: string) => string,
  ) {}

  /** Whether images are drawn in place (otherwise they get a text indicator). */
  inline(): boolean {
    return this.options.showImages !== false && getCapabilities().images === "kitty";
  }

  /** pi's text indicator for an image that is not drawn. */
  indicator(block: { data?: string; mimeType?: string }): string {
    const mimeType = block.mimeType ?? "image/unknown";
    const dimensions = block.data && block.mimeType ? getImageDimensions(block.data, block.mimeType) : null;
    return imageFallback(mimeType, dimensions ?? undefined);
  }

  /** Lines for an image `width` cells wide at most and `maxRows` tall at most. */
  render(key: string, block: ImageBlock, width: number, maxRows: number): string[] {
    const cached = this.cache.get(key);
    let image = cached?.image;
    if (!cached || cached.data !== block.data || cached.mimeType !== block.mimeType || cached.maxRows !== maxRows) {
      image = new Image(
        block.data,
        block.mimeType,
        { fallbackColor: this.fallbackColor },
        {
          maxWidthCells: this.options.imageWidthCells ?? DEFAULT_WIDTH_CELLS,
          maxHeightCells: maxRows,
          imageId: cached?.image.getImageId(),
        },
      );
      this.cache.set(key, { data: block.data, mimeType: block.mimeType, maxRows, image });
    }
    return image!.render(width);
  }

  /** Drop cached lines (theme, cell size or transcoder changed). */
  invalidate(): void {
    for (const { image } of this.cache.values()) image.invalidate();
  }
}
