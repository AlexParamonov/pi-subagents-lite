/**
 * sanitize.ts — The trust boundary for text this extension did not author.
 *
 * Tool output, provider error bodies and child stderr reach the terminal as
 * painted rows; one surviving control sequence repaints the screen or is read
 * back as typed input. Keep this module dependency-free: UI modules import it
 * directly, so a test that stubs a formatting module cannot stub this away.
 */

/**
 * One terminal control sequence: CSI (`ESC [` parameters, intermediates and final
 * byte, or the 8-bit CSI introducing them directly), or a string sequence
 * (OSC/DCS/SOS/PMC/APC) ended by BEL or ST, or a lone `ESC`. Parameters cannot hold
 * a terminator and string sequences stop at the next `ESC`, BEL or ST, so text
 * after an unterminated sequence survives.
 *
 * Shaped like pi's own `stripAnsi`, which is what its `getTextOutput` runs over
 * tool output. Two library helpers were rejected: pi-tui's `stripTerminalSequences`
 * recognises only `m`, `G`, `K`, `H` and `J` as CSI terminators, so DEC private
 * modes (`ESC[?1049h` alternate screen, `ESC[?25l` hide cursor), `ESC[6n` (the
 * terminal's reply arrives on stdin, i.e. as typed input) and window manipulation
 * pass through it; `stripAnsi` itself is not exported from the package entry point.
 */
const CONTROL_SEQUENCE =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|[PX^_][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)|][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C))|\u009B[0-?]*[ -/]*[@-~]/g;

/**
 * C0 except tab/LF, DEL, C1, Unicode bidi controls and interlinear annotation
 * controls. Carriage return is removed as a C0 control, as pi's `getTextOutput` does.
 * Leftover introducers and terminators the sequence pattern did not consume go
 * here, so no control character reaches the terminal whatever its encoding.
 * Every member is a single UTF-16 code unit, so surrogate pairs are never split.
 */
// oxlint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Bidi_Control}\uFFF9-\uFFFB]/gu;

/**
 * Text with terminal control sequences and control characters removed, in both the
 * 7-bit (`ESC [`) and the 8-bit (`CSI`) encodings, as pi's own `getTextOutput` does.
 * Tabs stay as they are: pi-tui counts a tab as three cells and expands it when it
 * writes the line, which is what pi's `replaceTabs` asks for.
 */
export function plainText(text: string): string {
  return text.replace(CONTROL_SEQUENCE, "").replace(CONTROL_CHARACTER, "");
}
