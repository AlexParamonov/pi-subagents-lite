/**
 * process-probe.test.ts — which programs the probe reports for a session.
 * Everything is driven through the probe's own port over a fake /proc, so the kernel file formats
 * (cmdline, environ, task/<tid>/children) are exercised by the answers they produce, not directly.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { ProcessProbe } from "../../src/agents/process-probe.js";
import { createProcessProbe, createProcFsProbe } from "../../src/agents/process-probe.js";

const PI_PID = 100;
const MINE = ["PI_SESSION_ID=mine"];

/** A process of the fake tree; nesting says which one forked which. */
interface Node {
  argv: string;
  env?: string[];
  kids: Node[];
}

const n = (argv: string, ...kids: Node[]): Node => ({ argv, kids });
/** A shell pi spawned for this subagent's session: the only root the probe may start from. */
const shell = (node: Node): Node => ({ ...node, env: MINE });

const cmdPath = (root: string, pid: number) => join(root, String(pid), "cmdline");
const envPath = (root: string, pid: number) => join(root, String(pid), "environ");
const kidsPath = (root: string, pid: number) => join(root, String(pid), "task", String(pid), "children");

/** One scratch root for the file; each fake tree is a sibling directory, removed together at the end. */
const fileRoot = mkdtempSync(join(tmpdir(), "proc-probe-"));
afterAll(() => rmSync(fileRoot, { recursive: true, force: true }));
let trees = 0;

/**
 * Write `roots` the way the kernel serves it — pids from 200 in tree order, an environ and a children
 * file for every process (an empty listing for a childless one, as /proc serves) — then hand back the
 * probe for it. The probe is built before `spoil` ruins a file, so a
 * spoiled read is one that failed mid-run rather than a kernel that never had the file.
 */ function probeFor(roots: Node[], spoil?: (root: string) => void): ProcessProbe {
  const root = join(fileRoot, String(trees++));
  const nul = (line: string) => (line === "" ? "" : `${line.split(" ").join("\0")}\0`);
  mkdirSync(join(root, String(PI_PID), "task", String(PI_PID)), { recursive: true });
  let next = 200;
  const write = (node: Node): number => {
    const pid = next++;
    mkdirSync(join(root, String(pid)));
    writeFileSync(cmdPath(root, pid), nul(node.argv));
    writeFileSync(envPath(root, pid), nul((node.env ?? []).join(" ")));
    const kids = node.kids.map(write);
    mkdirSync(join(root, String(pid), "task", String(pid)), { recursive: true });
    writeFileSync(kidsPath(root, pid), kids.map((kid) => `${kid} `).join(""));
    return pid;
  };
  writeFileSync(
    kidsPath(root, PI_PID),
    roots
      .map(write)
      .map((pid) => `${pid} `)
      .join(""),
  );
  const probe = createProcFsProbe(root, PI_PID);
  if (!probe) throw new Error(`probe unavailable for ${root}`);
  spoil?.(root);
  return probe;
}

/** One contract: the tree the kernel shows in, the program names the widget would list out. */
interface ProbeCase {
  name: string;
  roots: Node[];
  spoil?: (root: string) => void;
  expected: string[];
}

describe("createProcFsProbe", () => {
  it.each([
    {
      name: "one entry per process of a pipeline, with the shells dropped",
      // ( sleep 5 & cat ) inside the call's shell; argv0 arrives as the path it was exec'd from.
      roots: [shell(n("/bin/bash -c x", n("bash -c x", n("/usr/bin/sleep 5"), n("/bin/cat"))))],
      expected: ["sleep", "cat"],
    },
    {
      name: "looks through wrappers in each process-tree branch",
      roots: [
        shell(n("bash -c x", n("timeout 20 foo", n("foo")), n("nice -n 5 env A=1 baz", n("env A=1 baz", n("baz"))))),
        shell(n("tokf", n("sleep"))),
        shell(n("rtk", n("git"))),
      ],
      expected: ["foo", "baz", "sleep", "git"],
    },
    {
      name: "a wrapper that has not started its program yet",
      roots: [shell(n("bash", n("timeout 20 foo")))],
      expected: ["timeout"],
    },
    {
      name: "nested shells, and a login shell named -bash looked through by its real name",
      roots: [shell(n("-bash", n("sh -c y", n("grep x"))))],
      expected: ["grep"],
    },
    {
      name: "a program's own children, which are its business",
      roots: [shell(n("bash", n("pnpm test", n("node vitest"))))],
      expected: ["pnpm"],
    },
    {
      name: "the shell's own program once bash exec'd its last command",
      roots: [shell(n("sleep 30"))],
      expected: ["sleep"],
    },
    { name: "nothing while the shell has spawned nothing", roots: [shell(n("bash"))], expected: [] },
    {
      name: "repeats, one entry per process",
      roots: [shell(n("bash", n("curl"), n("jq"), n("curl")))],
      expected: ["curl", "jq", "curl"],
    },
    {
      name: "every concurrent shell of the session",
      roots: [shell(n("bash", n("make"))), shell(n("bash", n("tsc")))],
      expected: ["make", "tsc"],
    },
    {
      name: "another session's shell, and a tagged shell no children file lists",
      roots: [
        { ...n("bash", n("theirs")), env: ["PI_SESSION_ID=other"] },
        shell(n("bash", n("ours"))),
        shell(n("bash", n("stranger"))), // carries the id, but pi never listed it as a child
      ],
      spoil: (root) => writeFileSync(kidsPath(root, PI_PID), "200 202 "),
      expected: ["ours"],
    },
    {
      name: "a session id that only shares a prefix with the requested one",
      roots: [{ ...n("bash", n("sleep")), env: ["PI_SESSION_ID=mine-2"] }],
      expected: [],
    },
    {
      name: "a child that exited after its pid was listed, so its cmdline reads empty",
      roots: [shell(n("bash", n(""), n("sleep")))],
      expected: ["sleep"],
    },
    {
      name: "nothing once the shell's environ cannot be read, as for a non-dumpable process",
      roots: [shell(n("bash", n("sleep")))],
      spoil: (root) => rmSync(envPath(root, 200)),
      expected: [],
    },
    {
      name: "nothing when a cmdline vanishes before it is read",
      roots: [shell(n("bash", n("sleep")))],
      spoil: (root) => rmSync(cmdPath(root, 201)),
      expected: [],
    },
    {
      name: "nothing once pi's own children file stops being readable",
      roots: [shell(n("bash", n("sleep")))],
      spoil: (root) => rmSync(join(root, String(PI_PID), "task"), { recursive: true }),
      expected: [],
    },
    {
      // The kernel lists siblings in whatever order it likes; the line must not reshuffle with it.
      name: "children files that list the newest child first",
      roots: [shell(n("bash", n("curl"), n("jq"))), shell(n("bash", n("make"), n("tsc")))],
      spoil: (root) => {
        for (const pid of [PI_PID, 200, 203]) {
          const file = kidsPath(root, pid);
          const list = readFileSync(file, "utf8").trim().split(" ").filter(Boolean);
          writeFileSync(
            file,
            list
              .reverse()
              .map((kid) => `${kid} `)
              .join(""),
          );
        }
      },
      expected: ["curl", "jq", "make", "tsc"],
    },
    {
      // The kernel documents children as unreliable while children exit concurrently, so an entry can
      // name an ancestor or a sibling. Each pid is visited once, so one sample stays bounded.
      name: "nothing instead of an endless sweep when children files name each other",
      roots: [shell(n("bash", n("bash -c x"), n("bash -c y")))],
      spoil: (root) => {
        for (const [pid, list] of [
          [201, "200 202 "],
          [202, "200 201 "],
        ] as const) {
          writeFileSync(kidsPath(root, pid), list);
        }
      },
      expected: [],
    },
  ] satisfies ProbeCase[])("$name", async ({ roots, spoil, expected }) => {
    expect(await probeFor(roots, spoil).runningPrograms("mine")).toEqual(expected);
  });

  it("is absent where the kernel has no children files", () => {
    const root = join(fileRoot, `bare-${trees++}`);
    mkdirSync(join(root, String(PI_PID), "task", String(PI_PID)), { recursive: true });

    expect(createProcFsProbe(root, PI_PID)).toBeUndefined();
    expect(createProcFsProbe(join(root, "missing"), PI_PID)).toBeUndefined();
  });

  it("gives no probe to a platform with no /proc", () => {
    expect(createProcessProbe("darwin")).toBeUndefined();
    expect(createProcessProbe("win32")).toBeUndefined();
  });

  it("reports nothing for an unknown session on a real /proc", async () => {
    const probe = createProcessProbe();
    if (!probe) return; // a platform whose kernel has no children files

    expect(await probe.runningPrograms(`no-such-session-${process.pid}`)).toEqual([]);
  });
});
