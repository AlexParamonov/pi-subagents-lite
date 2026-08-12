/**
 * markdown-theme.ts — Builds a minimal MarkdownTheme from our Theme.
 *
 * Pi's Markdown component requires a MarkdownTheme for rendering. We build
 * one from our Theme wrapper which delegates to Pi's internal theme.
 */

import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { Theme } from "./types.js";

export function makeMarkdownTheme(th: Theme): MarkdownTheme {
  return {
    heading: (t: string) => th.bold(t),
    link: (t: string) => t,
    linkUrl: (t: string) => th.fg("dim", t),
    code: (t: string) => t,
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => th.fg("dim", t),
    quote: (t: string) => th.fg("dim", t),
    quoteBorder: (t: string) => th.fg("dim", t),
    hr: (t: string) => th.fg("dim", t),
    listBullet: (t: string) => t,
    bold: th.bold,
    italic: th.italic ?? ((t: string) => t),
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
    highlightCode: (code: string) => code.split("\n"),
  };
}
