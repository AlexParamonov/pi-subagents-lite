/**
 * worktree-validator.test.ts — Tests for worktree path validation.
 *
 * Covers: validation logic, resolution, label computation, error cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  validateWorktreePath,
  WORKTREE_VALIDATION_ERRORS,
  type WorktreeValidationSuccess,
  type WorktreeValidationFailure,
} from "../src/worktree-validator.js";

// ── helpers ──────────────────────────────────────────────────────

function makePi(gitCommonDirResults: Map<string, string | null>) {
  return {
    exec: vi.fn(async (cmd: string, args: string[], opts?: any) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        const cwd = opts?.cwd ?? "";
        const result = gitCommonDirResults.get(cwd);
        if (result === null || result === undefined) {
          return { code: 128, stdout: "", stderr: "not a git repo" };
        }
        return { code: 0, stdout: result, stderr: "" };
      }
      throw new Error(`Unexpected exec: ${cmd} ${args.join(" ")}`);
    }),
  };
}

function makeTempDir(prefix = "wt-test"): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Build a fake worktree directory with a git-common-dir we can control. */
function setupGitRepo(rootDir: string, commonDir: string) {
  // Create .git file (worktree style) or .git dir
  writeFileSync(join(rootDir, ".git"), `gitdir: ${commonDir}/.git/worktrees/wt\n`);
}

// ── tests ────────────────────────────────────────────────────────

describe("validateWorktreePath", () => {
  let tmpDir: string;
  let cleanupFn: () => void;

  beforeEach(() => {
    const tmp = makeTempDir();
    tmpDir = tmp.dir;
    cleanupFn = tmp.cleanup;
  });

  afterEach(() => {
    cleanupFn();
  });

  // ── happy path ────────────────────────────────────────────────

  it("accepts a valid worktree path that shares git-common-dir with parent", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const commonDir = join(tmpDir, "shared.git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, commonDir],
      [worktreePath, commonDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBe(worktreePath);
    expect(success.worktreeRoot).toBe(worktreePath);
    expect(success.label).toBe("feature");
  });

  it("accepts the main checkout (parent and target share git-common-dir via .git dir)", async () => {
    const parentCwd = join(tmpDir, "linked-wt");
    const mainCheckout = join(tmpDir, "main-checkout");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(mainCheckout, { recursive: true });

    const sharedGitDir = join(tmpDir, ".git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, sharedGitDir],
      [mainCheckout, sharedGitDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), mainCheckout, parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBe(mainCheckout);
  });

  // ── relative path resolution ──────────────────────────────────

  it("resolves a relative path against parent cwd", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = "feature-wt";
    const absolutePath = join(parentCwd, "feature-wt");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(absolutePath, { recursive: true });

    const commonDir = join(tmpDir, "shared.git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, commonDir],
      [absolutePath, commonDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBe(absolutePath);
  });

  it("resolves ./wt/feature style relative path", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = "./wt/feature";
    const absolutePath = join(parentCwd, "wt", "feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(absolutePath, { recursive: true });

    const commonDir = join(tmpDir, "shared.git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, commonDir],
      [absolutePath, commonDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBe(absolutePath);
  });

  // ── label computation ─────────────────────────────────────────

  it("computes label as basename when path equals worktree root", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "my-feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const commonDir = join(tmpDir, "shared.git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, commonDir],
      [worktreePath, commonDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(true);
    expect((result as WorktreeValidationSuccess).label).toBe("my-feature");
  });

  // ── rejection: path does not exist ────────────────────────────

  it("rejects a path that does not exist", async () => {
    const parentCwd = join(tmpDir, "parent");
    mkdirSync(parentCwd, { recursive: true });
    const nonExistent = join(tmpDir, "nonexistent");

    const result = await validateWorktreePath(makePi(new Map()), nonExistent, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("does not exist");
  });

  // ── rejection: not a directory ────────────────────────────────

  it("rejects a path that is a file (not a directory)", async () => {
    const parentCwd = join(tmpDir, "parent");
    mkdirSync(parentCwd, { recursive: true });
    const filePath = join(tmpDir, "file.txt");
    writeFileSync(filePath, "content");

    const result = await validateWorktreePath(makePi(new Map()), filePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not a directory");
  });

  // ── rejection: parent not in git repo ─────────────────────────

  it("rejects when parent is not in a git repo", async () => {
    const parentCwd = join(tmpDir, "no-git-parent");
    const worktreePath = join(tmpDir, "feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const gitResults = new Map<string, string | null>([
      [parentCwd, null], // not a git repo
      [worktreePath, "/some/.git"],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not inside a git repository");
  });

  // ── rejection: target not in git repo ─────────────────────────

  it("rejects when target path is not in a git repo", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "no-git");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const gitResults = new Map<string, string | null>([
      [parentCwd, "/some/.git"],
      [worktreePath, null], // not in git repo
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not inside a git repository");
  });

  // ── rejection: different repo ─────────────────────────────────

  it("rejects when target is in a different git repo", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "other-repo");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const gitResults = new Map<string, string | null>([
      [parentCwd, join(tmpDir, "repo-a", ".git")],
      [worktreePath, join(tmpDir, "repo-b", ".git")],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), worktreePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not a worktree of the parent");
  });

  // ── rejection: git timeout ────────────────────────────────────

  it("rejects when git command times out", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const pi = {
      exec: vi.fn(async () => {
        throw new Error("Command timed out");
      }),
    };

    const result = await validateWorktreePath(pi, worktreePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("timed out");
  });

  // ── rejection: git not found ──────────────────────────────────

  it("rejects when git executable is not found", async () => {
    const parentCwd = join(tmpDir, "parent");
    const worktreePath = join(tmpDir, "feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "git") throw new Error("ENOENT: git not found");
        throw new Error("Unexpected");
      }),
    };

    const result = await validateWorktreePath(pi, worktreePath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not found");
  });

  // ── empty / whitespace path ───────────────────────────────────

  it("treats empty string as omitted (returns ok with no path)", async () => {
    const parentCwd = join(tmpDir, "parent");
    mkdirSync(parentCwd, { recursive: true });

    const result = await validateWorktreePath(makePi(new Map()), "", parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBeUndefined();
  });

  it("treats whitespace-only string as omitted", async () => {
    const parentCwd = join(tmpDir, "parent");
    mkdirSync(parentCwd, { recursive: true });

    const result = await validateWorktreePath(makePi(new Map()), "   ", parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBeUndefined();
  });

  // ── symlink resolution ────────────────────────────────────────

  it("resolves symlinks before validation", async () => {
    const parentCwd = join(tmpDir, "parent");
    const realPath = join(tmpDir, "real-feature");
    const symlinkPath = join(tmpDir, "link-to-feature");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(realPath, { recursive: true });
    symlinkSync(realPath, symlinkPath);

    const commonDir = join(tmpDir, "shared.git");
    const gitResults = new Map<string, string | null>([
      [parentCwd, commonDir],
      [realPath, commonDir],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), symlinkPath, parentCwd);

    expect(result.ok).toBe(true);
    const success = result as WorktreeValidationSuccess;
    expect(success.resolvedPath).toBe(realPath);
  });

  it("rejects a symlink whose target is in a different repo", async () => {
    const parentCwd = join(tmpDir, "parent");
    const otherRepoPath = join(tmpDir, "other-repo-dir");
    const symlinkPath = join(tmpDir, "sneaky-link");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(otherRepoPath, { recursive: true });
    symlinkSync(otherRepoPath, symlinkPath);

    const gitResults = new Map<string, string | null>([
      [parentCwd, join(tmpDir, "repo-a", ".git")],
      [otherRepoPath, join(tmpDir, "repo-b", ".git")],
    ]);

    const result = await validateWorktreePath(makePi(gitResults), symlinkPath, parentCwd);

    expect(result.ok).toBe(false);
    expect((result as WorktreeValidationFailure).error).toContain("not a worktree of the parent");
  });
});

// ── error constants ──────────────────────────────────────────────

describe("WORKTREE_VALIDATION_ERRORS", () => {
  it("has all expected error message constants", () => {
    expect(WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.NOT_A_DIRECTORY).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.DIFFERENT_REPO).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.PARENT_NOT_IN_GIT_REPO).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND).toBeDefined();
    expect(WORKTREE_VALIDATION_ERRORS.GIT_TIMEOUT).toBeDefined();
  });

  it("each constant is a non-empty string", () => {
    for (const msg of Object.values(WORKTREE_VALIDATION_ERRORS)) {
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
