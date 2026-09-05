/**
 * spawn-target.ts — The spawn target a `worktree_path` resolves to.
 *
 * Combines the two spawn-target primitives (worktree-validator,
 * project-trust) into one silent computation: path validation plus the
 * project-trust decision. computeSpawnTarget is that decision, defined once
 * and consumed by the live Agent tool path, the tool-call listener, and the
 * restart path. surfaceSpawnTargetWarnings is its user-facing half — the one
 * notify policy (prefix, level, untrusted-project warning) shared by every
 * consumer that surfaces warnings.
 */

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, getPiInstance } from "../shell.js";
import { validateWorktreePath } from "./worktree-validator.js";
import { resolveSubagentTrust, createSubagentTrustDeps, untrustedProjectWarning } from "./project-trust.js";

/** The spawn target a `worktree_path` resolves to, plus warnings to surface. */
export type SpawnTarget =
  | { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Compute the spawn target for a `worktree_path` value: path validation plus
 * the project-trust decision, silently — warnings are collected into the
 * result, not notified. Callers own the consequences (execution throws or
 * proceeds; the restart path reports skips) and surface the warnings through
 * surfaceSpawnTargetWarnings; the tool-call listener consumes the trust
 * decision without notifying.
 *
 * The raw value comes from unchecked tool arguments and replayed history, so
 * anything that is not a non-blank string counts as omitted — the convention
 * the live path established, enforced here so both entry points share it.
 */
export async function computeSpawnTarget(ctx: ExtensionContext, rawWorktreePath: unknown): Promise<SpawnTarget> {
  // Non-strings and empty/whitespace → omitted: nothing to validate, nothing
  // to gate.
  if (typeof rawWorktreePath !== "string" || rawWorktreePath.trim() === "") {
    return { ok: true, projectTrusted: true, warnings: [] };
  }
  const warnings: string[] = [];
  try {
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, (msg) =>
      warnings.push(msg),
    );
    if (!validation.ok) {
      return { ok: false, error: validation.error, warnings };
    }

    const resolvedPath = validation.resolvedPath!; // non-empty paths always resolve

    // Cross-repo targets are gated by pi's trust framework. Same-repo paths
    // are never gated; an untrusted target still spawns but with its project
    // resources ignored and a warning surfaced.
    const projectTrusted = resolveSubagentTrust({
      targetPath: resolvedPath,
      sameRepo: validation.sameRepo === true,
      deps: createSubagentTrustDeps(getAgentDir(), parentCwd),
    });
    return {
      ok: true,
      resolvedPath,
      worktreeLabel: validation.label,
      projectTrusted,
      warnings,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worktree_path validation failed: ${msg}`, warnings };
  }
}

/**
 * Surface a spawn target's warnings through a notify sink: validator warnings
 * always, the untrusted-project warning only for a resolved untrusted target
 * (an invalid one has no path to warn about). The shared notify policy —
 * prefix and warning level included — so both the live Agent tool path and
 * the restart path reach the user identically. A missing ui or notify sink
 * stays silent, matching the previous per-caller guards.
 */
export function surfaceSpawnTargetWarnings(
  ui: { notify?: (message: string, type?: "info" | "warning" | "error") => void } | undefined,
  target: SpawnTarget,
): void {
  if (!ui?.notify) return;
  for (const msg of target.warnings) {
    ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
  }
  if (target.ok && !target.projectTrusted && target.resolvedPath) {
    ui.notify(`[pi-subagents-lite] ${untrustedProjectWarning(target.resolvedPath)}`, "warning");
  }
}
