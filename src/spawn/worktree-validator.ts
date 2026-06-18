/**
 * worktree-validator.ts — Validate, resolve, and label a worktree path.
 *
 * Pure async functions that validate a `worktree_path` value against the parent's
 * git repository. Depends on `pi.exec` for git commands.
 *
 * Validation strategy: compare `git-common-dir` of the parent and target paths.
 * If they share the same common dir, the target is a worktree of the parent's repo.
 */

import * as path from "node:path";
import { existsSync, statSync, realpathSync } from "node:fs";

/** Timeout for git commands (ms). */
const GIT_EXEC_TIMEOUT_MS = 5000;

/** Specific error messages returned to the LLM for self-correction. */
export const WORKTREE_VALIDATION_ERRORS = {
  PATH_DOES_NOT_EXIST: "worktree_path does not exist: the specified path was not found on disk",
  NOT_A_DIRECTORY: "worktree_path is not a directory: the specified path exists but is not a directory",
  PARENT_NOT_IN_GIT_REPO: "worktree_path validation failed: the parent session is not inside a git repository",
  NOT_IN_GIT_REPO: "worktree_path is not inside a git repository",
  DIFFERENT_REPO: "worktree_path is not a worktree of the parent's repository",
  GIT_NOT_FOUND: "worktree_path validation failed: git executable not found on this host",
  GIT_TIMEOUT: "worktree_path validation failed: git command timed out",
} as const;

/** Successful validation result. */
export interface WorktreeValidationSuccess {
  ok: true;
  /** Resolved absolute path (symlinks followed, relative resolved). Undefined when path is empty/omitted. */
  resolvedPath?: string;
  /** Worktree root directory. */
  worktreeRoot?: string;
  /** Short display label for the widget. */
  label?: string;
}

/** Failed validation result. */
export interface WorktreeValidationFailure {
  ok: false;
  /** Human-readable error describing the specific failure reason. */
  error: string;
}

export type WorktreeValidationResult = WorktreeValidationSuccess | WorktreeValidationFailure;

/**
 * Minimal interface for the pi exec function — only what the validator needs.
 */
interface PiExec {
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Run `git rev-parse --git-common-dir` and return the trimmed result.
 * Returns a failure result if the command fails or git is unavailable.
 */
async function getGitCommonDir(
  pi: PiExec,
  cwd: string,
  notInRepoError: string,
): Promise<{ ok: true; commonDir: string } | { ok: false; error: string }> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    if (result.code !== 0) return { ok: false, error: notInRepoError };
    const commonDir = result.stdout.trim();
    if (!commonDir) return { ok: false, error: notInRepoError };
    return { ok: true, commonDir };
  } catch (err: unknown) {
    const msg = String(err instanceof Error ? err.message : err);
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      return { ok: false, error: WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND };
    }
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.GIT_TIMEOUT };
  }
}

/**
 * Validate a worktree path against the parent's git repository.
 *
 * Resolution order:
 * 1. Empty/whitespace → treated as omitted (return ok with no path)
 * 2. Resolve relative against parent cwd
 * 3. Resolve symlinks (realpath)
 * 4. Check exists + is directory
 * 5. Get and compare git-common-dir for parent and target
 * 6. Get worktree root via --show-toplevel
 * 7. Normalize and compute display label
 *
 * @param pi - Minimal exec interface (pi.exec)
 * @param worktreePath - The raw worktree_path value from the LLM
 * @param parentCwd - The parent session's working directory
 * @returns Validation result with resolved path + label, or error
 */
export async function validateWorktreePath(
  pi: PiExec,
  worktreePath: string,
  parentCwd: string,
): Promise<WorktreeValidationResult> {
  // Step 1: Empty / whitespace → treat as omitted
  if (!worktreePath || worktreePath.trim() === "") {
    return { ok: true };
  }

  // Step 2: Resolve relative paths against parent cwd
  const resolved = path.isAbsolute(worktreePath)
    ? worktreePath
    : path.resolve(parentCwd, worktreePath);

  // Step 3: Check existence
  if (!existsSync(resolved)) {
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST };
  }

  // Step 4: Check is directory (resolve symlinks first via stat)
  let realPath: string;
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: WORKTREE_VALIDATION_ERRORS.NOT_A_DIRECTORY };
    }
    // Resolve symlinks — use realpathSync to get the canonical path
    realPath = realpathSync(resolved);
  } catch {
    // stat failed — likely a broken symlink or permission issue
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST };
  }

  // Step 5: Get and compare git-common-dir for parent and target
  const parentResult = await getGitCommonDir(pi, parentCwd, WORKTREE_VALIDATION_ERRORS.PARENT_NOT_IN_GIT_REPO);
  if (!parentResult.ok) return parentResult;

  const targetResult = await getGitCommonDir(pi, realPath, WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO);
  if (!targetResult.ok) return targetResult;

  // Compare common dirs — must share the same repo
  const parentCommonAbs = path.isAbsolute(parentResult.commonDir)
    ? parentResult.commonDir
    : path.resolve(parentCwd, parentResult.commonDir);
  const targetCommonAbs = path.isAbsolute(targetResult.commonDir)
    ? targetResult.commonDir
    : path.resolve(realPath, targetResult.commonDir);

  if (parentCommonAbs !== targetCommonAbs) {
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.DIFFERENT_REPO };
  }

  // Step 6: Get the worktree root via git rev-parse --show-toplevel
  let worktreeRoot: string;
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: realPath, timeout: GIT_EXEC_TIMEOUT_MS });
    if (result.code !== 0) {
      worktreeRoot = realPath;
    } else {
      const raw = result.stdout.trim();
      worktreeRoot = raw ? (path.isAbsolute(raw) ? raw : path.resolve(realPath, raw)) : realPath;
    }
  } catch {
    worktreeRoot = realPath;
  }

  // Step 7: Normalize and compute display label
  const normalizedRealPath = realPath.replace(/\\/g, "/");
  const normalizedRoot = worktreeRoot.replace(/\\/g, "/");
  const label = computeLabel(normalizedRealPath, normalizedRoot);

  return {
    ok: true,
    resolvedPath: normalizedRealPath,
    worktreeRoot: normalizedRoot,
    label,
  };
}

/**
 * Compute a short display label for the worktree path.
 *
 * Rules:
 * - Root of worktree → basename (e.g., "/wt/feature" → "feature")
 * - Subdirectory → basename/relative (e.g., "/wt/feature/packages/web" → "feature/packages/web")
 * - Always forward slashes regardless of host OS
 */
export function computeLabel(resolvedPath: string, worktreeRoot: string): string {
  // Normalize both paths to forward slashes for cross-platform comparison
  const normalizedResolved = resolvedPath.replace(/\\/g, "/");
  const normalizedRoot = worktreeRoot.replace(/\\/g, "/");

  const rootBasename = normalizedRoot.split("/").filter(Boolean).pop() ?? "";

  if (normalizedResolved === normalizedRoot) {
    return rootBasename;
  }

  // Compute relative path using posix separator
  const relative = path.posix.relative(normalizedRoot, normalizedResolved);

  return `${rootBasename}/${relative}`;
}
