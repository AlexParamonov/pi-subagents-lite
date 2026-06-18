/**
 * Theme for terminal rendering — used by format.ts, renderer.ts, and UI widgets.
 * Defined here (not in ui/agent-widget.ts) so non-UI modules can import it
 * without depending on the UI layer.
 */
export type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic?: (text: string) => string;
};
