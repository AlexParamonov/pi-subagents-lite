/**
 * process-probe.test.ts — /proc-based discovery of the programs a subagent's bash call is running.
 * Drives the public probe against a fake /proc tree of children files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ProcessProbe } from "../../src/agents/process-probe.js";
import {
  createProcessProbe,
  createProcFsProbe,
  parseChildPids,
  parseProgramName,
} from "../../src/agents/process-probe.js";

const PI_PID = 100;

/** A fake /proc that lacks children files has no probe; tests need one to drive. */
function probeAt(procRoot: string, ownPid = PI_PID): ProcessProbe {
  const probe = createProcFsProbe(procRoot, ownPid);
  if (!probe) throw new Error(`probe unavailable for ${procRoot}`);
  return probe;
}

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

describe("createProcFsProbe", () => {
  let root: string;
  /** pid -> ppid of the fake tree, the source of the children files. */
  let processes: Map<number, number>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-probe-"));
    processes = new Map();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addProcess(pid: number, ppid: number, argv: string[], env: string[] = []): void {
    processes.set(pid, ppid);
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cmdline"), argv.length > 0 ? `${argv.join("\0")}\0` : "");
    writeFileSync(join(dir, "environ"), env.length > 0 ? `${env.join("\0")}\0` : "");
  }

  /** The tree as the kernel serves it: one children file per process, in its own task directory. */
  function probe(): ProcessProbe {
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of processes) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    for (const pid of new Set([PI_PID, ...processes.keys()])) {
      const dir = join(root, String(pid), "task", String(pid));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "children"), (kids.get(pid) ?? []).map((kid) => `${kid} `).join(""));
    }
    return probeAt(root);
  }

  it("lists the programs of a pipeline inside a subshell, dropping the shells", async () => {
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

  it("skips a process whose cmdline vanished before it was read", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    const running = probe();
    rmSync(join(root, "201", "cmdline"));

    expect(await running.runningPrograms("mine")).toEqual([]);
  });

  it("reports nothing when the kernel denies reading the shell's environ", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    rmSync(join(root, "200", "environ"));
    mkdirSync(join(root, "200", "environ")); // a directory, so the read fails as it does under a restrictive ptrace_scope
    const running = probe();

    expect(await running.runningPrograms("mine")).toEqual([]);
  });

  it("reports only processes listed in a children file, never one found by scanning proc", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    mkdirSync(join(root, "500"), { recursive: true });
    writeFileSync(join(root, "500", "cmdline"), "bash\0");
    writeFileSync(join(root, "500", "environ"), "PI_SESSION_ID=mine\0");

    expect(await probe().runningPrograms("mine")).toEqual(["sleep"]);
  });

  it("reports nothing instead of fanning out when children files name each other", async () => {
    // The kernel documents this file as unreliable while children exit concurrently, so entries can
    // name an ancestor or a sibling. Visiting each pid once ends the sample; anything else and one
    // repaint costs an exponential sweep.
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sh", "-c", "x"]);
    addProcess(202, 200, ["bash", "-c", "y"]);
    const running = probe();
    writeFileSync(join(root, "201", "task", "201", "children"), "200 202 ");
    writeFileSync(join(root, "202", "task", "202", "children"), "200 201 ");

    expect(await running.runningPrograms("mine")).toEqual([]);
  });

  it("reports a program whose own children file cannot be read", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["pnpm", "test"]);
    const running = probe();
    rmSync(join(root, "201", "task"), { recursive: true, force: true });

    expect(await running.runningPrograms("mine")).toEqual(["pnpm"]);
  });

  it("returns nothing once pi's own children file stops being readable", async () => {
    addProcess(200, PI_PID, ["bash"], ["PI_SESSION_ID=mine"]);
    addProcess(201, 200, ["sleep"]);
    const running = probe();
    rmSync(join(root, String(PI_PID), "task"), { recursive: true, force: true });

    expect(await running.runningPrograms("mine")).toEqual([]);
  });

  it("finds this very test process's children on a real /proc", async () => {
    if (process.platform !== "linux") return;
    expect(await probeAt("/proc", process.pid).runningPrograms(`no-such-session-${process.pid}`)).toEqual([]);
  });
});

describe("createProcFsProbe without children files", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "proc-probe-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is absent when the own task children file is missing", () => {
    mkdirSync(join(root, String(PI_PID), "task", String(PI_PID)), { recursive: true });
    writeFileSync(join(root, String(PI_PID), "cmdline"), "pi\0");

    expect(createProcFsProbe(root, PI_PID)).toBeUndefined();
  });

  it("is absent when the proc root does not exist", () => {
    expect(createProcFsProbe(join(root, "missing"), PI_PID)).toBeUndefined();
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
