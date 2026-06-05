/**
 * worktree-validator.test.ts — Acceptance tests for worktree path validation.
 *
 * Covers the worktree-validator module:
 *   - Happy path: valid worktree path → resolved path + label
 *   - Error cases: each rejection reason from PRD
 *   - Edge cases: symlinks, relative paths, main checkout, empty paths
 *   - Label computation: root vs subdirectory, forward slashes
 *
 * The validator is a pure async function that takes pi.exec as a dependency.
 * We mock pi.exec for git commands and use temp dirs for filesystem checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fakePi } from "./fixtures";

/* ------------------------------------------------------------------ */
/*  Import the module under test (will fail until implementation)     */
/* ------------------------------------------------------------------ */

// The validator module does not exist yet — importing it confirms these
// tests are testing real behavior (Red phase). The import error itself
// is the "failing for the right reason" signal.
import {
  validateWorktreePath,
  computeWorktreeLabel,
} from "../src/worktree-validator.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

let tmpDir: string;

function makeTmpDir(prefix = "wt-validator-test"): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Create a fake pi that responds to git rev-parse --git-common-dir
 * with the specified common dir for a given cwd.
 */
function fakePiWithGit(commonDirMap: Map<string, string | Error>): any {
  return {
    exec: vi.fn(async (cmd: string, args: string[], opts?: any) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        const cwd = opts?.cwd ?? "";
        const result = commonDirMap.get(cwd);
        if (result instanceof Error) throw result;
        if (result !== undefined) return { stdout: result, stderr: "" };
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
    }),
  };
}

/* ------------------------------------------------------------------ */
/*  Test setup/teardown                                               */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

/* ================================================================== */
/*  VALIDATION — REJECTION CASES                                      */
/* ================================================================== */

describe("validateWorktreePath — rejection cases", () => {
  const parentCwd = "/home/dev/my-repo";

  it("returns error when path does not exist", async () => {
    const pi = fakePiWithGit(new Map());
    const result = await validateWorktreePath(pi, "/nonexistent/path", parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("returns error when path is a file, not a directory", async () => {
    const filePath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(filePath, "content");
    const pi = fakePiWithGit(new Map());

    const result = await validateWorktreePath(pi, filePath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a directory");
  });

  it("returns error when path is not inside a git repository", async () => {
    const dirPath = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(dirPath, { recursive: true });
    const pi = fakePiWithGit(new Map([
      [dirPath, new Error("not a git repository")],
    ]));

    const result = await validateWorktreePath(pi, dirPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not inside a git repository");
  });

  it("returns error when path is in a different repository than the parent", async () => {
    const targetPath = path.join(tmpDir, "other-repo");
    fs.mkdirSync(targetPath, { recursive: true });
    const parentCommonDir = "/home/dev/my-repo/.git";
    const targetCommonDir = "/home/dev/other-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, parentCommonDir],
      [targetPath, targetCommonDir],
    ]));

    const result = await validateWorktreePath(pi, targetPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a worktree|different repository|not the parent/i);
  });

  it("returns error when parent itself is not in a git repository", async () => {
    const targetPath = path.join(tmpDir, "target");
    fs.mkdirSync(targetPath, { recursive: true });
    const pi = fakePiWithGit(new Map([
      [parentCwd, new Error("not a git repository")],
      [targetPath, "/home/dev/some-repo/.git"],
    ]));

    const result = await validateWorktreePath(pi, targetPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parent.*not in a git repository|parent.*not a git/i);
  });

  it("returns error when git executable is not found", async () => {
    const targetPath = path.join(tmpDir, "target");
    fs.mkdirSync(targetPath, { recursive: true });
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "git") throw new Error("git: command not found");
        throw new Error("unexpected");
      }),
    };

    const result = await validateWorktreePath(pi, targetPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/git.*not found|git.*not installed|configuration error/i);
  });

  it("returns error when git command times out", async () => {
    const targetPath = path.join(tmpDir, "target");
    fs.mkdirSync(targetPath, { recursive: true });
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "git") throw new Error("timeout");
        throw new Error("unexpected");
      }),
    };

    const result = await validateWorktreePath(pi, targetPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout|configuration error/i);
  });
});

/* ================================================================== */
/*  VALIDATION — HAPPY PATH                                           */
/* ================================================================== */

describe("validateWorktreePath — happy path", () => {
  const parentCwd = "/home/dev/my-repo";

  it("accepts a valid worktree path and returns resolved path", async () => {
    const worktreePath = path.join(tmpDir, "wt-feature");
    fs.mkdirSync(worktreePath, { recursive: true });
    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [worktreePath, commonDir],
    ]));

    const result = await validateWorktreePath(pi, worktreePath, parentCwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(path.resolve(worktreePath));
    }
  });

  it("returns the worktree root and label on success", async () => {
    const worktreePath = path.join(tmpDir, "wt-feature");
    fs.mkdirSync(worktreePath, { recursive: true });
    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [worktreePath, commonDir],
    ]));

    const result = await validateWorktreePath(pi, worktreePath, parentCwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.worktreeRoot).toBeDefined();
      expect(typeof result.label).toBe("string");
      expect(result.label.length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/*  SYMLINK RESOLUTION                                                */
/* ================================================================== */

describe("validateWorktreePath — symlink resolution", () => {
  const parentCwd = "/home/dev/my-repo";

  it("resolves symlinks before validation", async () => {
    const realPath = path.join(tmpDir, "real-wt");
    const symlinkPath = path.join(tmpDir, "link-wt");
    fs.mkdirSync(realPath, { recursive: true });
    fs.symlinkSync(realPath, symlinkPath);

    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [realPath, commonDir],
    ]));

    const result = await validateWorktreePath(pi, symlinkPath, parentCwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The resolved path should be the real path, not the symlink
      expect(result.resolvedPath).toBe(path.resolve(realPath));
    }
  });

  it("rejects a symlink that resolves to a different repository", async () => {
    const otherRepoPath = path.join(tmpDir, "other-repo");
    const symlinkPath = path.join(tmpDir, "sneaky-link");
    fs.mkdirSync(otherRepoPath, { recursive: true });
    fs.symlinkSync(otherRepoPath, symlinkPath);

    const parentCommonDir = "/home/dev/my-repo/.git";
    const otherCommonDir = "/home/dev/other-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, parentCommonDir],
      [otherRepoPath, otherCommonDir],
    ]));

    const result = await validateWorktreePath(pi, symlinkPath, parentCwd);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a worktree|different repository/i);
  });
});

/* ================================================================== */
/*  RELATIVE PATH RESOLUTION                                          */
/* ================================================================== */

describe("validateWorktreePath — relative path resolution", () => {
  it("resolves relative paths against parent cwd", async () => {
    const parentCwd = "/home/dev/my-repo";
    const relativePath = "./wt/feature";
    const absolutePath = path.resolve(parentCwd, relativePath);

    // Create the directory at the expected absolute path
    fs.mkdirSync(absolutePath, { recursive: true });

    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [absolutePath, commonDir],
    ]));

    const result = await validateWorktreePath(pi, relativePath, parentCwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(absolutePath);
    }
  });

  it("resolves parent-relative paths (../wt/feature)", async () => {
    const parentCwd = "/home/dev/my-repo/sub";
    const relativePath = "../wt/feature";
    const absolutePath = path.resolve(parentCwd, relativePath);

    fs.mkdirSync(absolutePath, { recursive: true });

    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [absolutePath, commonDir],
    ]));

    const result = await validateWorktreePath(pi, relativePath, parentCwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(absolutePath);
    }
  });
});

/* ================================================================== */
/*  MAIN CHECKOUT ACCEPTANCE                                          */
/* ================================================================== */

describe("validateWorktreePath — main checkout acceptance", () => {
  it("accepts the main checkout path when parent is in a linked worktree", async () => {
    const parentCwd = "/home/dev/my-repo.wt/feature";
    const mainCheckout = "/home/dev/my-repo";
    fs.mkdirSync(mainCheckout, { recursive: true });

    const commonDir = "/home/dev/my-repo/.git";
    const pi = fakePiWithGit(new Map([
      [parentCwd, commonDir],
      [mainCheckout, commonDir],
    ]));

    const result = await validateWorktreePath(pi, mainCheckout, parentCwd);
    expect(result.ok).toBe(true);
  });
});

/* ================================================================== */
/*  EMPTY / WHITESPACE PATH                                           */
/* ================================================================== */

describe("validateWorktreePath — empty and whitespace paths", () => {
  it("treats empty string as omitted (returns success with parent cwd)", async () => {
    const pi = fakePiWithGit(new Map());
    const result = await validateWorktreePath(pi, "", "/home/dev/repo");
    // Empty path should be treated as omitted — the validator returns
    // a "use parent cwd" result or a "skipped" result
    expect(result.skipped).toBe(true);
  });

  it("treats whitespace-only string as omitted", async () => {
    const pi = fakePiWithGit(new Map());
    const result = await validateWorktreePath(pi, "   ", "/home/dev/repo");
    expect(result.skipped).toBe(true);
  });
});

/* ================================================================== */
/*  LABEL COMPUTATION                                                 */
/* ================================================================== */

describe("computeWorktreeLabel", () => {
  it("returns basename when requested path equals the worktree root", () => {
    const label = computeWorktreeLabel("/wt/feature", "/wt/feature");
    expect(label).toBe("feature");
  });

  it("returns basename/subpath when requested path is a subdirectory of the root", () => {
    const label = computeWorktreeLabel("/wt/feature/packages/web", "/wt/feature");
    expect(label).toBe("feature/packages/web");
  });

  it("uses forward slashes for path separators", () => {
    // Simulate Windows-style path (label should always use forward slashes)
    const label = computeWorktreeLabel("/wt/feature/packages/web", "/wt/feature");
    expect(label).not.toContain("\\");
    expect(label).toContain("/");
  });

  it("handles deeply nested subdirectories", () => {
    const label = computeWorktreeLabel("/wt/feature/a/b/c/d", "/wt/feature");
    expect(label).toBe("feature/a/b/c/d");
  });

  it("handles worktree root with trailing slash normalization", () => {
    const label = computeWorktreeLabel("/wt/feature", "/wt/feature/");
    // Should still produce "feature" regardless of trailing slash
    expect(label).toBe("feature");
  });
});

/* ================================================================== */
/*  CROSS-PLATFORM PATH SEPARATORS                                    */
/* ================================================================== */

describe("computeWorktreeLabel — cross-platform", () => {
  it("produces forward-slash labels from Windows-style path inputs", () => {
    // Using path.win32 to simulate Windows paths on any host
    const winRoot = "C:\\Users\\dev\\my-repo\\wt\\feature";
    const winSubdir = "C:\\Users\\dev\\my-repo\\wt\\feature\\packages\\web";
    // The label function should normalize to forward slashes
    const label = computeWorktreeLabel(winSubdir, winRoot);
    expect(label).not.toContain("\\");
    expect(label).toMatch(/feature\/packages\/web/);
  });

  it("produces forward-slash labels from mixed separator inputs", () => {
    const root = "/wt/feature";
    const mixed = "/wt/feature/packages\\web";
    const label = computeWorktreeLabel(mixed, root);
    expect(label).not.toContain("\\");
  });
});
