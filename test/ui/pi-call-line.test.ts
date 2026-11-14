/**
 * pi-call-line.test.ts — The viewer's mirror of pi's own call-line form.
 *
 * The marking theme below makes every color and the bolding visible in the returned text, so each
 * expectation pins one tool's row: its words, its order and the color each part carries.
 */

import { describe, it, expect } from "vite-plus/test";
import { homedir } from "node:os";
import type { Theme } from "../../src/ui/types.js";
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
});
