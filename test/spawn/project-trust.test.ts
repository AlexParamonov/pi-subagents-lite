/**
 * project-trust.test.ts — Trust gate resolution for cross-repo worktree targets.
 *
 * resolveSubagentTrust decides whether a subagent session treats the target
 * project as trusted:
 *   - Same-repo targets are never gated.
 *   - Cross-repo targets with no trust-requiring resources are never gated.
 *   - Cross-repo targets with trust-requiring resources resolve from the
 *     nearest saved trust decision; undecided falls back to the global
 *     defaultProjectTrust setting ("always" = trusted, anything else = not).
 *
 * The SDK building blocks (hasTrustRequiringProjectResources,
 * ProjectTrustStore, SettingsManager.getDefaultProjectTrust) are injected as
 * deps so the branching logic is unit-tested with fakes. An integration test
 * at the bottom exercises the real SDK functions against a temp agent dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSubagentTrust, type SubagentTrustDeps } from "../../src/spawn/project-trust.js";

function makeDeps(overrides: Partial<SubagentTrustDeps> = {}): SubagentTrustDeps {
  return {
    hasTrustRequiringProjectResources: () => false,
    getTrustDecision: () => null,
    getDefaultProjectTrust: () => "ask",
    ...overrides,
  };
}

describe("resolveSubagentTrust", () => {
  it("never gates same-repo targets, even with untrusted saved decisions", () => {
    const result = resolveSubagentTrust({
      targetPath: "/wt/feature",
      sameRepo: true,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => false,
      }),
    });
    expect(result).toEqual({ projectTrusted: true, gateApplied: false });
  });

  it("does not gate cross-repo targets without trust-requiring resources", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({ hasTrustRequiringProjectResources: () => false }),
    });
    expect(result).toEqual({ projectTrusted: true, gateApplied: false });
  });

  it("applies a saved untrusted decision for a cross-repo target", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => false,
      }),
    });
    expect(result).toEqual({ projectTrusted: false, gateApplied: true });
  });

  it("applies a saved trusted decision for a cross-repo target", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => true,
      }),
    });
    expect(result).toEqual({ projectTrusted: true, gateApplied: true });
  });

  it("falls back to defaultProjectTrust always → trusted when undecided", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "always",
      }),
    });
    expect(result).toEqual({ projectTrusted: true, gateApplied: true });
  });

  it("treats undecided targets as untrusted when the default is ask", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "ask",
      }),
    });
    expect(result).toEqual({ projectTrusted: false, gateApplied: true });
  });

  it("treats undecided targets as untrusted when the default is never", () => {
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => null,
        getDefaultProjectTrust: () => "never",
      }),
    });
    expect(result).toEqual({ projectTrusted: false, gateApplied: true });
  });

  it("only asks for the default when the store is undecided", () => {
    const getDefaultProjectTrust = (): "ask" | "always" | "never" => {
      throw new Error("should not be consulted when a decision exists");
    };
    const result = resolveSubagentTrust({
      targetPath: "/repo-b",
      sameRepo: false,
      deps: makeDeps({
        hasTrustRequiringProjectResources: () => true,
        getTrustDecision: () => true,
        getDefaultProjectTrust,
      }),
    });
    expect(result.projectTrusted).toBe(true);
  });
});

// ── Integration: the real SDK building blocks behind the deps ────────────
// Proves the extension wiring (hasTrustRequiringProjectResources +
// ProjectTrustStore + SettingsManager.getDefaultProjectTrust) resolves the
// same way against a real temp agent dir.

describe("resolveSubagentTrust — real SDK building blocks", () => {
  let agentDir: string;
  let targetDir: string;
  let parentDir: string;

  beforeEach(() => {
    const base = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    agentDir = join(base, "agent");
    targetDir = join(base, "repo-b");
    parentDir = join(base, "repo-a");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(parentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function realDeps() {
    const { hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager } =
      await import("@earendil-works/pi-coding-agent");
    const store = new ProjectTrustStore(agentDir);
    return {
      hasTrustRequiringProjectResources,
      getTrustDecision: (cwd: string) => store.get(cwd),
      getDefaultProjectTrust: () => SettingsManager.create(parentDir, agentDir).getDefaultProjectTrust(),
    };
  }

  it("gates an undecided target with .pi resources when the global default is ask", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    const deps = await realDeps();

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false, deps });

    expect(result).toEqual({ projectTrusted: false, gateApplied: true });
  });

  it("loads resources for an undecided target when the global default is always", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    const deps = await realDeps();

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false, deps });

    expect(result).toEqual({ projectTrusted: true, gateApplied: true });
  });

  it("respects a saved trusted decision over an ask default", async () => {
    mkdirSync(join(targetDir, ".pi"), { recursive: true });
    writeFileSync(join(targetDir, ".pi", "settings.json"), "{}");
    const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
    new ProjectTrustStore(agentDir).set(targetDir, true);
    const deps = await realDeps();

    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false, deps });

    expect(result).toEqual({ projectTrusted: true, gateApplied: true });
  });

  it("does not gate a target without trust-requiring resources", async () => {
    const deps = await realDeps();
    const result = resolveSubagentTrust({ targetPath: targetDir, sameRepo: false, deps });
    expect(result).toEqual({ projectTrusted: true, gateApplied: false });
    expect(existsSync(join(targetDir, ".pi"))).toBe(false);
  });
});
