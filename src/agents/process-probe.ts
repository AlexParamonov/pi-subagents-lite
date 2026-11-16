import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * process-probe.ts — what a subagent's `bash` tool call is running right now. Linux only (/proc).
 *
 * pi spawns each bash call as a direct child of its own process and exposes the calling session's id to
 * it, so the shells of one session are the children of this process whose environ carries PI_SESSION_ID.
 * Children come from the parent's own task file /proc/<pid>/task/<pid>/children, never from a scan of
 * the process table, and the command string is never parsed. From such a shell the walk descends
 * through shell processes (subshells, `$(…)`, `&` groups) and wrapper programs (`timeout foo`), and
 * reports the first other program on each branch.
 *
 * Two cases report no programs instead of failing, both because no shell can be tied to a session: no
 * shell of that session is alive any more; or a shell's /proc/<pid>/environ cannot be read, which is
 * denied for a process that made itself non-dumpable or changed uid.
 */

export interface ProcessProbe {
  /** argv0 basenames of the programs currently running under the session's bash calls, one entry per process (repeats kept), in process-tree order. */
  runningPrograms(sessionId: string): Promise<string[]>;
}

/** Program names treated as transparent: the walk descends through them instead of reporting them. */
const SHELL_NAMES = new Set(["bash", "sh", "dash", "ash", "zsh", "ksh", "mksh", "fish"]);

/**
 * Programs that only launch another program: the walk reports what they run (`timeout 5 foo` → foo)
 * rather than them. One with no child yet (still starting up) is reported itself. Shell builtins
 * (`command`, `exec`) and the `time` keyword are absent: they never appear as a process.
 */
const WRAPPER_NAMES = new Set(["timeout", "env", "nice", "nohup", "stdbuf", "setsid", "ionice"]);

/** argv0 basename from raw /proc/<pid>/cmdline contents; a leading "-" (login shell) is dropped. Empty for zombies. */
export function parseProgramName(cmdline: string): string {
  const argv0 = cmdline.split("\0")[0] ?? "";
  return basename(argv0).replace(/^-/, "");
}

/** Pids listed in a /proc/<pid>/task/<tid>/children file (space separated). */
export function parseChildPids(children: string): number[] {
  return children
    .split(" ")
    .filter((token) => token !== "")
    .map(Number)
    .filter((pid) => Number.isInteger(pid));
}

/**
 * The probe reading `procRoot` for the process `ownPid`, or undefined when this kernel has no children
 * files (CONFIG_PROC_CHILDREN). Kernel support cannot change while pi runs, so it is settled here.
 */
export function createProcFsProbe(procRoot = "/proc", ownPid = process.pid): ProcessProbe | undefined {
  if (!existsSync(`${procRoot}/${ownPid}/task/${ownPid}/children`)) return undefined;

  // shortcut: reads only the parent's own task children file, so a child forked by a worker thread of a
  // looked-through parent is missed; pi forks its shells from its main thread, and the all-thread union
  // measured identical. Upgrade to a task/* scan if a looked-through parent can fork from a worker thread.
  const childrenOf = (pid: number): Promise<number[]> =>
    readFile(`${procRoot}/${pid}/task/${pid}/children`, "utf8").then(parseChildPids, () => [] as number[]);

  const programName = (pid: number): Promise<string> =>
    readFile(`${procRoot}/${pid}/cmdline`, "utf8").then(parseProgramName, () => "");

  const hasSessionId = (pid: number, sessionId: string): Promise<boolean> =>
    readFile(`${procRoot}/${pid}/environ`, "utf8").then(
      (environ) => environ.split("\0").includes(`PI_SESSION_ID=${sessionId}`),
      () => false,
    );

  return {
    async runningPrograms(sessionId) {
      const candidates = await childrenOf(ownPid);
      const matches = await Promise.all(candidates.map((pid) => hasSessionId(pid, sessionId)));
      const roots = candidates.filter((_, i) => matches[i]).sort((a, b) => a - b);

      const found: string[] = [];
      // The kernel documents the children file as unreliable while children exit concurrently, so a
      // wrong entry can name an ancestor or repeat a sibling. Visiting each pid once per sample keeps
      // the walk bounded by the process count instead of fanning out exponentially.
      const visited = new Set<number>();
      const visit = async (pid: number): Promise<void> => {
        if (visited.has(pid)) return;
        visited.add(pid);
        const name = await programName(pid);
        if (name === "") return;
        // A shell reported by its own name is bash after it exec'd its last command. A wrapper is
        // reported only while it has no child to look through.
        const lookThrough = SHELL_NAMES.has(name) || WRAPPER_NAMES.has(name);
        const kids = lookThrough ? [...(await childrenOf(pid))].sort((a, b) => a - b) : [];
        if (lookThrough && (SHELL_NAMES.has(name) || kids.length > 0)) {
          for (const child of kids) await visit(child);
          return;
        }
        found.push(name);
      };
      for (const root of roots) await visit(root);

      return found;
    },
  };
}

/** The probe for this platform, or undefined where none exists. */
export function createProcessProbe(platform: string = process.platform): ProcessProbe | undefined {
  return platform === "linux" ? createProcFsProbe() : undefined;
}
