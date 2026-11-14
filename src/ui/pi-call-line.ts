/**
 * pi-call-line.ts — Tool call rows in the form pi's own call renderers give them.
 *
 * pi keeps these formatters in internal modules its package entry point does not publish, so the
 * viewer mirrors them here: one row per call, no path hyperlinks, no multi-line previews.
 */

import { homedir } from "node:os";
import type { Theme } from "./types.ts";
import { plainText } from "./sanitize.ts";

/** pi's limit on the collapsed preview of arguments it does not know how to present. */
const COLLAPSED_ARGS_CHARS = 100;

/** A call's arguments as the transcript holds them; pi's tools each read their own keys. */
type CallArgs = Record<string, unknown> | undefined;

/** pi's shell renderers, which differ only in the prompt they show in place of the tool name. */
const SHELL_PROMPTS = new Map([
  ["bash", "$"],
  ["powershell", "PS>"],
]);

/** The tools pi presents by name, each with its own one-row call line. */
const CURATED_LINES: Map<string, (args: CallArgs, theme: Theme) => string> = new Map([
  ["read", readLine],
  ["write", writeLine],
  ["edit", editLine],
  ["grep", grepLine],
  ["find", findLine],
  ["ls", lsLine],
]);

/**
 * One tool call's row in pi's call-line form, without the padding around it. `timing` is the
 * viewer's own duration, shown muted after pi's text the way pi shows its timer line.
 */
export function formatCallLine(name: string, args: CallArgs, theme: Theme, expanded: boolean, timing?: string): string {
  const timer = timing ? muted(timing, theme) : "";
  const prompt = SHELL_PROMPTS.get(name);
  if (prompt !== undefined) return shellLine(args, prompt, theme, timer);

  const curated = CURATED_LINES.get(name);
  return (curated ? curated(args, theme) : genericLine(name, args, theme, expanded)) + (timer ? `  ${timer}` : "");
}

function shellLine(args: CallArgs, prompt: string, theme: Theme, timer: string): string {
  const command = argText(args?.command);
  const display = command === null ? invalidArg(theme) : command ? command : theme.fg("toolOutput", "...");
  const timeout = args?.timeout;
  const suffix = timeout ? muted(` (timeout ${shown(timeout)}s)`, theme) : "";
  // pi's suffix already carries its own leading space, so only it needs a single space before the timing.
  const timingGap = suffix ? " " : "  ";
  return theme.fg("toolTitle", theme.bold(`${prompt} ${display}`)) + suffix + (timer ? `${timingGap}${timer}` : "");
}

function readLine(args: CallArgs, theme: Theme): string {
  const path = pathText(args?.file_path ?? args?.path, theme);
  const range = formatReadLineRange(args?.offset, args?.limit);
  return `${toolWord("read", theme)} ${path}${range ? theme.fg("warning", range) : ""}`;
}

/** pi shows the written content itself, which needs more than one row; the viewer counts its lines. */
function writeLine(args: CallArgs, theme: Theme): string {
  const content = argText(args?.content);
  const lines = content ? contentLines(content) : undefined;
  return `${toolWord("write", theme)} ${pathText(args?.file_path ?? args?.path, theme)}${
    lines === undefined ? "" : counted(lines, "line", theme)
  }`;
}

/** pi counts the edits it can preview: the `edits` list, or one edit given as plain text. */
function editCount(args: CallArgs): number | undefined {
  const edits = args?.edits;
  if (Array.isArray(edits) && edits.length > 0 && edits.every(isTextPair)) return edits.length;
  return typeof args?.oldText === "string" && typeof args?.newText === "string" ? 1 : undefined;
}

function isTextPair(edit: unknown): boolean {
  const { oldText, newText } = (edit ?? {}) as { oldText?: unknown; newText?: unknown };
  return typeof oldText === "string" && typeof newText === "string";
}

function editLine(args: CallArgs, theme: Theme): string {
  const edits = editCount(args);
  return `${toolWord("edit", theme)} ${pathText(args?.file_path ?? args?.path, theme)}${
    edits === undefined ? "" : counted(edits, "edit", theme)
  }`;
}

function muted(text: string, theme: Theme): string {
  return theme.fg("muted", text);
}

function counted(n: number, noun: string, theme: Theme): string {
  return muted(` (${n} ${noun}${n === 1 ? "" : "s"})`, theme);
}

/** pi's search tools name the pattern, then say where they looked. */
function grepLine(args: CallArgs, theme: Theme): string {
  const pattern = argText(args?.pattern);
  const glob = argText(args?.glob);
  const limit = args?.limit;
  let text = `${toolWord("grep", theme)} ${pattern === null ? invalidArg(theme) : theme.fg("accent", `/${pattern}/`)}`;
  text += theme.fg("toolOutput", ` in ${searchPath(args?.path, theme)}`);
  if (glob) text += theme.fg("toolOutput", ` (${glob})`);
  if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${shown(limit)}`);
  return text;
}

function findLine(args: CallArgs, theme: Theme): string {
  const pattern = argText(args?.pattern);
  const limit = args?.limit;
  let text = `${toolWord("find", theme)} ${pattern === null ? invalidArg(theme) : theme.fg("accent", pattern)}`;
  text += theme.fg("toolOutput", ` in ${searchPath(args?.path, theme)}`);
  if (limit !== undefined) text += theme.fg("toolOutput", ` (limit ${shown(limit)})`);
  return text;
}

/** pi's `path` for a search tool: the directory it searched, `.` when none was given. */
function searchPath(value: unknown, theme: Theme): string {
  const raw = argText(value);
  return raw === null ? invalidArg(theme) : shortenPath(raw || ".");
}

function lsLine(args: CallArgs, theme: Theme): string {
  const limit = args?.limit;
  const path = pathText(args?.path, theme, ".");
  return `${toolWord("ls", theme)} ${path}${limit === undefined ? "" : theme.fg("toolOutput", ` (limit ${shown(limit)})`)}`;
}

/** pi's trimTrailingEmptyLines, so the count is the content a reader would see. */
function contentLines(text: string): number {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** pi's generic header: the bold tool name, then its arguments as muted `key=value` pairs. */
function genericLine(name: string, args: CallArgs, theme: Theme, expanded: boolean): string {
  const entries = argsTable(args);
  const head = toolWord(plainText(name), theme);
  if (!entries || entries.length === 0) return head;
  const pairs = entries.map(([key, value]) => `${plainText(key)}=${pairValue(value)}`).join(" ");
  const preview =
    !expanded && pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
  return `${head} ${muted(preview, theme)}`;
}

/** pi's argument table: an object's entries, one `args` entry for anything else, none when absent. */
function argsTable(args: CallArgs): [string, unknown][] | undefined {
  if (args == null) return undefined;
  if (typeof args !== "object" || Array.isArray(args)) return [["args", args]];
  return Object.entries(args);
}

/** The tool word pi puts first: bold, on the call row's title color. */
function toolWord(word: string, theme: Theme): string {
  return theme.fg("toolTitle", theme.bold(word));
}

/** pi's `str`: a string argument as it is, an absent one as "", anything else pi marks invalid. */
function argText(value: unknown): string | null {
  if (typeof value === "string") return plainText(value);
  if (value == null) return "";
  return null;
}

/** An argument value interpolated into pi's own text, stripped of the controls a tool could carry. */
function shown(value: unknown): string {
  return plainText(String(value));
}

/** An argument value as pi prints it inside a `key=value` pair. */
function pairValue(value: unknown): string {
  return plainText(JSON.stringify(value) ?? String(value));
}

function invalidArg(theme: Theme): string {
  return theme.fg("error", "[invalid arg]");
}

/** pi's `renderToolPath` without the hyperlink: accent path, `...` when absent, invalid when not a string. */
function pathText(path: unknown, theme: Theme, emptyFallback?: string): string {
  const raw = argText(path);
  if (raw === null) return invalidArg(theme);
  const value = raw || emptyFallback;
  if (!value) return theme.fg("toolOutput", "...");
  return theme.fg("accent", shortenPath(value));
}

/** pi's `shortenPath`: a home-directory prefix becomes `~`. */
function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function parseLineNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** pi's `formatReadLineRange`: `:start`, or `:start-end`, omitting a range it cannot read. */
function formatReadLineRange(offset: unknown, limit: unknown): string {
  if (offset == null && limit == null) return "";
  const start = offset == null ? 1 : parseLineNumber(offset);
  if (start === undefined) return "";
  if (limit == null) return `:${start}`;
  const count = parseLineNumber(limit);
  if (count === undefined) return "";
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}
