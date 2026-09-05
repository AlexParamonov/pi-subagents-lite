/**
 * spawn-target.ts — The spawn target a `worktree_path` resolves to.
 *
 * Combines the two spawn-target primitives (worktree-validator,
 * project-trust) into one silent computation: path validation plus the
 * project-trust decision, without user-facing notifications. Shared by the
 * live Agent tool path (resolveWorktree wraps it and surfaces the warnings;
 * the tool-call listener calls it directly to gate its per-model prediction)
 * and the restart path (which surfaces the warnings through its own command
 * context) so both make exactly one trust decision.
 */

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionCtx, getPiInstance } from "../shell.js";
import { validateWorktreePath } from "./worktree-validator.js";
import { resolveSubagentTrust, createSubagentTrustDeps } from "./project-trust.js";

/** The spawn target a `worktree_path` resolves to, plus warnings to surface. */
export type SpawnTarget =
  | { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/**
 * Compute the spawn target for a `worktree_path` value: path validation plus
 * the project-trust decision, without user-facing notifications. Callers own
 * the warnings (execution notifies them; the tool-call listener and restart
 * consume the trust decision silently or through their own channels).
 */
export async function computeSpawnTarget(
  ctx: ExtensionContext,
  rawWorktreePath: string | undefined,
): Promise<SpawnTarget> {
  // Empty/whitespace → omitted: nothing to validate, nothing to gate.
  if (!rawWorktreePath || rawWorktreePath.trim() === "") {
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
