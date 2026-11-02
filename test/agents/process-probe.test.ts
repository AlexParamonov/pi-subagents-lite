/**
 * process-probe.test.ts — /proc-based discovery of the programs a subagent's bash call is running.
 * Drives the public probe against a fake /proc tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createProcessProbe,
  createProcFsProbe,
  parseChildPids,
  parseParentPid,
  parseProgramName,
} from "../../src/agents/process-probe.js";

const PI_PID = 100;

describe("parseParentPid", () => {
  it("reads the parent pid after the comm field", () => {
    expect(parseParentPid("123 (bash) S 100 123 123 0 -1")).toBe(100);
  });

  it("survives spaces and parentheses in comm", () => {
    expect(parseParentPid("123 (my (odd) proc) S 77 123 123 0 -1")).toBe(77);
  });

  it("returns undefined for malformed input", () => {
    expect(parseParentPid("garbage")).toBeUndefined();
  });
});

describe("parseProgramName", () => {
  it("takes the basename of argv0", () => {
    expect(parseProgramName("/usr/bin/sleep\0 5\0")).toBe("sleep");
  });

  it("drops the leading dash of a login shell", () => {
    expect(parseProgramName("-bash\0")).toBe("bash");
  });

  it("is empty for an empty cmdline (zombie)", () => {
    expect(parseProgramName("")).toBe("");
  });
});

describe("parseChildPids", () => {
  it("reads the space separated pids of a children file", () => {
    expect(parseChildPids("201 202 203 ")).toEqual([201, 202, 203]);
  });

  it("is empty for an empty file", () => {
    expect(parseChildPids("")).toEqual([]);
  });
});

// The same fake process tree is served two ways: with the kernel's per-thread children files,
// and without them (CONFIG_PROC_CHILDREN off), where the probe falls back to reading every stat.
describe.each([
  ["children files", true],
  ["process table fallback", false],
])("createProcFsProbe (%s)", (_mode, withChildrenFiles) => {
  let root: string;
  let processes: Map<number, number>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-probe-"));
    processes = new Map();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write /proc/<pid>/task/<pid>/children for pi and every added process. */
  function writeChildrenFiles(): void {
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of processes) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    for (const pid of new Set([PI_PID, ...processes.keys()])) {
      mkdirSync(join(root, String(pid), "task", String(pid)), { recursive: true });
      writeFileSync(
        join(root, String(pid), "task", String(pid), "children"),
        (kids.get(pid) ?? []).map((kid) => `${kid} `).join(""),
      );
    }
  }

  function addProcess(pid: number, ppid: number, argv: string[], env: string[] = []): void {
    processes.set(pid, ppid);
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), `${pid} (${argv[0] ?? "x"}) S ${ppid} ${pid} ${pid} 0 -1`);
    writeFileSync(join(dir, "cmdline"), argv.length > 0 ? `${argv.join("\0")}\0` : "");
    writeFileSync(join(dir, "environ"), env.length > 0 ? `${env.join("\0")}\0` : "");
  }

  const probe = () => {
    if (withChildrenFiles) writeChildrenFiles();
    return createProcFsProbe(root, PI_PID);
  };

  it("lists the programs of a pipeline inside a subshell, dropping the shells", async () => {
    addProcess(PI_PID, 1, ["pi"]);
    addProcess(200, PI_PID, ["/bin/bash", "-c", "x"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["bash", "-c", "x"]); // ( … ) subshell
    addProcess(202, 201, ["sleep", "5"]);
    addProcess(203, 201, ["cat"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep", "cat"]);
  });

  it("stops at the first non-shell program and does not report its children", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["pnpm", "test"]);
    addProcess(202, 201, ["node", "vitest"]);
    addProcess(203, 202, ["sh", "-c", "x"]);

    expect(await probe().runningPrograms("mine")).toEqual(["pnpm"]);
  });

  it("looks through wrappers like timeout and reports the program they run, in every pipeline stage", async () => {
    addProcess(200, PI_PID, ["bash", "-c", "x"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["timeout", "20", "foo"]);
    addProcess(202, 201, ["foo"]);
    addProcess(203, 200, ["bar"]);
    addProcess(204, 200, ["nice", "-n", "5", "env", "A=1", "baz"]);
    addProcess(205, 204, ["env", "A=1", "baz"]);
    addProcess(206, 205, ["baz"]);

    expect(await probe().runningPrograms("mine")).toEqual(["foo", "bar", "baz"]);
  });

  it("reports a wrapper that has not started its program yet", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["timeout", "20", "foo"]);

    expect(await probe().runningPrograms("mine")).toEqual(["timeout"]);
  });

  it("descends through nested shells and $(…) substitutions", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["bash"]);
    addProcess(202, 201, ["sh"]);
    addProcess(203, 202, ["grep", "x"]);

    expect(await probe().runningPrograms("mine")).toEqual(["grep"]);
  });

  it("reports the shell's own program when bash exec'd its last command", async () => {
    addProcess(200, PI_PID, ["sleep", "30"], ["PI_SESSION_ID=mine"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("reports nothing while the shell has no children", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("keeps repeated programs, one entry per process in tree order", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["curl"]);
    addProcess(202, 200, ["jq"]);
    addProcess(203, 200, ["curl"]);

    expect(await probe().runningPrograms("mine")).toEqual(["curl", "jq", "curl"]);
  });

  it("ignores shells of other sessions and processes not parented by pi", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=other"]);
    addProcess(201, 200, ["theirs"]);
    addProcess(300, 1, ["bash"], ["PI_SESSION_ID=mine"]); // same id, wrong parent
    addProcess(301, 300, ["stranger"]);
    addProcess(400, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(401, 400, ["ours"]);

    expect(await probe().runningPrograms("mine")).toEqual(["ours"]);
  });

  it("does not match a session id that merely starts with the requested one", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine-2"]);
    addProcess(201, 200, ["sleep"]);

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("covers every concurrent bash call of the session", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["make"]);
    addProcess(210, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(211, 210, ["tsc"]);

    expect(await probe().runningPrograms("mine")).toEqual(["make", "tsc"]);
  });

  it("skips zombies with an empty cmdline", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, []);
    addProcess(202, 200, ["sleep"]);

    expect(await probe().runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("skips processes whose files vanished or are unreadable", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    rmSync(join(root, "201", "cmdline"));
    mkdirSync(join(root, "202"), { recursive: true }); // no stat at all

    expect(await probe().runningPrograms("mine")).toEqual([]);
  });

  it("returns nothing when /proc does not exist", async () => {
    expect(await createProcFsProbe(join(root, "missing"), PI_PID).runningPrograms("mine")).toEqual([]);
  });

  it("finds this very test process's children on a real /proc", async () => {
    if (process.platform !== "linux") return;
    expect(await createProcFsProbe().runningPrograms(`no-such-session-${process.pid}`)).toEqual([]);
  });
});

describe("createProcFsProbe — reading only the processes it needs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-probe-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addProcess(pid: number, argv: string[], env: string[], threads: Record<number, number[]>): void {
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`);
    writeFileSync(join(dir, "environ"), env.length > 0 ? `${env.join("\0")}\0` : "");
    for (const [tid, kids] of Object.entries(threads)) {
      mkdirSync(join(dir, "task", tid), { recursive: true });
      writeFileSync(join(dir, "task", tid, "children"), kids.map((kid) => `${kid} `).join(""));
    }
  }

  it("follows children files without reading any process's stat", async () => {
    addProcess(PI_PID, ["pi"], [], { [PI_PID]: [200] });
    addProcess(200, ["bash"], ["PI_SESSION_ID=mine"], { 200: [201] });
    addProcess(201, ["sleep", "5"], [], { 201: [] });
    // Parented to pi by its stat but absent from every children file: a full-table scan would find it.
    mkdirSync(join(root, "500"));
    writeFileSync(join(root, "500", "stat"), `500 (bash) S ${PI_PID} 500 500 0 -1`);
    writeFileSync(join(root, "500", "cmdline"), "bash\0");
    writeFileSync(join(root, "500", "environ"), "PI_SESSION_ID=mine\0");

    expect(await createProcFsProbe(root, PI_PID).runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("collects children forked by any thread of the parent", async () => {
    addProcess(PI_PID, ["pi"], [], { [PI_PID]: [200], 101: [210] });
    addProcess(200, ["bash"], ["PI_SESSION_ID=mine"], { 200: [201] });
    addProcess(201, ["make"], [], { 201: [] });
    addProcess(210, ["bash"], ["PI_SESSION_ID=mine"], { 210: [211] });
    addProcess(211, ["tsc"], [], { 211: [] });

    expect(await createProcFsProbe(root, PI_PID).runningPrograms("mine")).toEqual(["make", "tsc"]);
  });

  it("does not look at the children of a program it reports", async () => {
    addProcess(PI_PID, ["pi"], [], { [PI_PID]: [200] });
    addProcess(200, ["bash"], ["PI_SESSION_ID=mine"], { 200: [201] });
    // 201's task dir is missing: reading its children would be a wasted (and here failing) read.
    mkdirSync(join(root, "201"));
    writeFileSync(join(root, "201", "cmdline"), "pnpm\0test\0");

    expect(await createProcFsProbe(root, PI_PID).runningPrograms("mine")).toEqual(["pnpm"]);
  });
});

describe("createProcessProbe", () => {
  it("exists on linux", () => {
    expect(createProcessProbe("linux")).toBeDefined();
  });

  it.each(["darwin", "win32", "freebsd"])("is absent on %s", (platform) => {
    expect(createProcessProbe(platform)).toBeUndefined();
  });
});
