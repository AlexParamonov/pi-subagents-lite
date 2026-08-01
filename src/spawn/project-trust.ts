/**
 * project-trust.ts — Resolve the trust state for a cross-repo worktree target.
 *
 * Cross-repo targets are gated by pi's existing trust framework, using pi's
 * exported building blocks only (never reimplemented, never reading trust.json
 * directly). Same-repo targets and targets without trust-requiring project
 * resources are never gated. An undecided target falls back to the global
 * `defaultProjectTrust` setting; anything other than "always" means untrusted.
 *
 * The SDK building blocks are injected as deps so the branching logic stays
 * unit-testable; the extension wires the real functions at the call site.
 */

import type { DefaultProjectTrust, ProjectTrustDecision } from "@earendil-works/pi-coding-agent";

/** The trust primitives the gate is built from. Injected for testability. */
export interface SubagentTrustDeps {
  /** pi's hasTrustRequiringProjectResources: `.pi` entries or `.agents/skills`. */
  hasTrustRequiringProjectResources: (cwd: string) => boolean;
  /** pi's ProjectTrustStore.get: nearest-ancestor decision, null when undecided. */
  getTrustDecision: (cwd: string) => ProjectTrustDecision;
  /** pi's SettingsManager.getDefaultProjectTrust: global default. */
  getDefaultProjectTrust: () => DefaultProjectTrust;
}

export interface SubagentTrustResult {
  /** Whether the subagent session should load the target's project resources. */
  projectTrusted: boolean;
  /** True when a trust gate actually applied (cross-repo + has resources). */
  gateApplied: boolean;
}

/**
 * Resolve whether a spawn into `targetPath` loads the target's project
 * resources. Same-repo targets are never gated; cross-repo targets are gated
 * only when they carry trust-requiring resources.
 */
export function resolveSubagentTrust(opts: {
  targetPath: string;
  /** False when the parent and target live in different git repos (or the parent is in none). */
  sameRepo: boolean;
  deps: SubagentTrustDeps;
}): SubagentTrustResult {
  if (opts.sameRepo) return { projectTrusted: true, gateApplied: false };
  if (!opts.deps.hasTrustRequiringProjectResources(opts.targetPath)) {
    return { projectTrusted: true, gateApplied: false };
  }
  const decision = opts.deps.getTrustDecision(opts.targetPath);
  if (decision !== null) return { projectTrusted: decision, gateApplied: true };
  return { projectTrusted: opts.deps.getDefaultProjectTrust() === "always", gateApplied: true };
}

/** Warning surfaced when a spawn proceeds into an untrusted cross-repo target. */
export const UNTRUSTED_PROJECT_WARNING = (targetPath: string): string =>
  `Target project at ${targetPath} is not trusted: its project resources (.pi/ settings, extensions, skills, prompts, themes, system prompt files, .agents/skills) will be ignored for this subagent`;
