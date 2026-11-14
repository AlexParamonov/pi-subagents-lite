/**
 * pi-call-line.test.ts — The viewer's mirror of pi's own call-line form.
 *
 * The marking theme below makes every color and the bolding visible in the returned text, so each
 * expectation pins one tool's row: its words, its order and the color each part carries.
 */

import { describe, it, expect } from "vite-plus/test";
import { homedir } from "node:os";
import type { Theme } from "../../src/ui/types.js";
import { expectNoTerminalControls } from "../fixtures.js";
import { formatCallLine } from "../../src/ui/pi-call-line.js";

const theme: Theme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
  italic: (text: string) => text,
};

function line(name: string, args?: Record<string, unknown>, timing?: string): string {
  return formatCallLine(name, args, theme, false, timing);
}

describe("pi call line", () => {
  it("shows the shell tools as their prompt and command in the title color", () => {
    expect(line("bash", { command: "ls -la" })).toBe("[toolTitle:*$ ls -la*]");
    expect(line("powershell", { command: "Get-ChildItem" })).toBe("[toolTitle:*PS> Get-ChildItem*]");
  });

  it("keeps a shell timeout as pi's muted suffix", () => {
    expect(line("bash", { command: "sleep 1", timeout: 30 })).toBe("[toolTitle:*$ sleep 1*][muted: (timeout 30s)]");
  });

  it("shows a read call as its path and pi's warning-colored line range", () => {
    expect(line("read", { path: "/notes.md" })).toBe("[toolTitle:*read*] [accent:/notes.md]");
    expect(line("read", { path: "/notes.md", offset: 148, limit: 30 })).toBe(
      "[toolTitle:*read*] [accent:/notes.md][warning::148-177]",
    );
  });

  it("shortens a path under the home directory to ~", () => {
    expect(line("read", { path: `${homedir()}/code/app.ts` })).toBe("[toolTitle:*read*] [accent:~/code/app.ts]");
  });

  it("counts a write call's content lines, singular or plural", () => {
    expect(line("write", { path: "/a.ts", content: "one" })).toBe(
      "[toolTitle:*write*] [accent:/a.ts][muted: (1 line)]",
    );
    expect(line("write", { path: "/a.ts", content: "one\ntwo" })).toBe(
      "[toolTitle:*write*] [accent:/a.ts][muted: (2 lines)]",
    );
  });

  it("counts an edit call's edits, singular or plural", () => {
    expect(line("edit", { path: "/a.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe(
      "[toolTitle:*edit*] [accent:/a.ts][muted: (1 edit)]",
    );
    expect(
      line("edit", {
        path: "/a.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      }),
    ).toBe("[toolTitle:*edit*] [accent:/a.ts][muted: (2 edits)]");
    expect(line("edit", { path: "/a.ts", oldText: "a", newText: "b" })).toBe(
      "[toolTitle:*edit*] [accent:/a.ts][muted: (1 edit)]",
    );
  });

  it("shows a grep call as pi's pattern, search path, glob and limit", () => {
    expect(line("grep", { pattern: "TODO", path: "/src", glob: "*.ts", limit: 5 })).toBe(
      "[toolTitle:*grep*] [accent:/TODO/][toolOutput: in /src][toolOutput: (*.ts)][toolOutput: limit 5]",
    );
  });

  it("shows a find call as pi's pattern, search path and limit", () => {
    expect(line("find", { pattern: "*.ts", path: "/src", limit: 20 })).toBe(
      "[toolTitle:*find*] [accent:*.ts][toolOutput: in /src][toolOutput: (limit 20)]",
    );
  });

  it("shows an ls call as its path, defaulting to the working directory", () => {
    expect(line("ls", { path: "/tmp", limit: 10 })).toBe("[toolTitle:*ls*] [accent:/tmp][toolOutput: (limit 10)]");
    expect(line("ls", {})).toBe("[toolTitle:*ls*] [accent:.]");
  });

  it("shows a tool pi does not know as its name and muted key=value pairs", () => {
    expect(line("mcp__search", { query: "pets", limit: 3 })).toBe(
      '[toolTitle:*mcp__search*] [muted:query="pets" limit=3]',
    );
  });

  it("shows pi's markers for a path that is not a string, is empty or is absent", () => {
    expect(line("read", { path: 7 })).toBe("[toolTitle:*read*] [error:[invalid arg]]");
    expect(line("read", { path: "" })).toBe("[toolTitle:*read*] [toolOutput:...]");
    expect(line("read")).toBe("[toolTitle:*read*] [toolOutput:...]");
  });

  it("shows pi's marker for a command or pattern that is not a string", () => {
    expect(line("bash", { command: 7 })).toBe("[toolTitle:*$ [error:[invalid arg]]*]");
    expect(line("grep", { pattern: 7, path: "/src" })).toBe(
      "[toolTitle:*grep*] [error:[invalid arg]][toolOutput: in /src]",
    );
  });

  it("appends the duration muted, after pi's own suffix", () => {
    expect(line("read", { path: "/notes.md" }, "Took 1.0s")).toBe(
      "[toolTitle:*read*] [accent:/notes.md]  [muted:Took 1.0s]",
    );
    expect(line("bash", { command: "sleep 1", timeout: 30 }, "Took 1.0s")).toBe(
      "[toolTitle:*$ sleep 1*][muted: (timeout 30s)] [muted:Took 1.0s]",
    );
  });

  it("keeps the timing two spaces from a shell command that has no timeout suffix", () => {
    expect(line("bash", { command: "ls -la" }, "Took 1.0s")).toBe("[toolTitle:*$ ls -la*]  [muted:Took 1.0s]");
    expect(line("powershell", { command: "Get-ChildItem" }, "Took 1.0s")).toBe(
      "[toolTitle:*PS> Get-ChildItem*]  [muted:Took 1.0s]",
    );
  });

  // Tool arguments are model- and MCP-produced text. Every position a row shows is a carrier, so
  // each one is pinned: the ABC below is what the hostile string is once its sequences are gone.
  it("strips terminal controls from every argument position a row shows", () => {
    const hostile = "A\u009b?1049hB\u001b]0;title\u0007C";
    const counted = "5\u001b]0;t\u00077";

    expect(line("read", { path: hostile })).toBe("[toolTitle:*read*] [accent:ABC]");
    expect(line("write", { path: hostile, content: "one\ntwo" })).toBe(
      "[toolTitle:*write*] [accent:ABC][muted: (2 lines)]",
    );
    expect(line("edit", { path: hostile, oldText: "a", newText: "b" })).toBe(
      "[toolTitle:*edit*] [accent:ABC][muted: (1 edit)]",
    );
    expect(line("ls", { path: hostile, limit: counted })).toBe("[toolTitle:*ls*] [accent:ABC][toolOutput: (limit 57)]");
    expect(line("grep", { pattern: hostile, path: hostile, glob: hostile, limit: counted })).toBe(
      "[toolTitle:*grep*] [accent:/ABC/][toolOutput: in ABC][toolOutput: (ABC)][toolOutput: limit 57]",
    );
    expect(line("find", { pattern: hostile, path: hostile, limit: counted })).toBe(
      "[toolTitle:*find*] [accent:ABC][toolOutput: in ABC][toolOutput: (limit 57)]",
    );
    expect(line("bash", { command: hostile, timeout: counted })).toBe("[toolTitle:*$ ABC*][muted: (timeout 57s)]");
    // JSON.stringify escapes C0 but hands the 8-bit CSI on to plainText untouched, so the generic
    // row is pinned with that form: pi's own `key=${JSON.stringify(value)}` stays visible around it.
    expect(line("uniq\u009b31mtool", { "pa\u009b?1049hth": "A\u009b?1049hB" })).toBe(
      '[toolTitle:*uniqtool*] [muted:path="AB"]',
    );

    expectNoTerminalControls([
      line("bash", { command: hostile, timeout: counted }),
      line("grep", { pattern: hostile, path: hostile, glob: hostile, limit: counted }),
      line("uniq\u009b31mtool", { "pa\u009b?1049hth": hostile }),
    ]);
  });
});
