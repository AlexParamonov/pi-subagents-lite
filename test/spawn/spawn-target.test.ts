/**
 * spawn-target.test.ts — Unit tests for the shared spawn-target computation.
 *
 * computeSpawnTarget combines worktree-path validation and the project-trust
 * decision into one silent result that both the live Agent tool path and the
 * restart path consume. Tests pin the composition contract: blank/omitted
 * paths are trusted non-targets, validation failures map to a self-correctable
 * error, warnings are collected (not notified), and the trust decision is
 * resolved from the validated path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DefaultProjectTrust } from "@earendil-works/pi-coding-agent";
import { fakeCtx, shellMock } from "../fixtures.js";
import type { SubagentTrustDeps } from "../../src/spawn/project-trust.js";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const { mockValidateWorktreePath, mockResolveSubagentTrust, mockCreateSubagentTrustDeps, trustDeps } = vi.hoisted(
  () => {
    const trustDeps: SubagentTrustDeps = {
      hasTrustRequiringProjectResources: vi.fn(() => true),
      getTrustDecision: vi.fn(() => null),
      getDefaultProjectTrust: vi.fn((): DefaultProjectTrust => "always"),
    };
    return {
      mockValidateWorktreePath: vi.fn(),
      mockResolveSubagentTrust: vi.fn(() => true),
      mockCreateSubagentTrustDeps: vi.fn(() => trustDeps),
      trustDeps,
    };
  },
);

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string) => resolved.split("/").pop() || resolved),
}));

vi.mock("../../src/spawn/project-trust.js", () => ({
  resolveSubagentTrust: mockResolveSubagentTrust,
  createSubagentTrustDeps: mockCreateSubagentTrustDeps,
  untrustedProjectWarning: vi.fn((targetPath: string) => `untrusted: ${targetPath}`),
}));

vi.mock("../../src/shell.js", () => shellMock({ sessionCtx: { cwd: "/session/cwd" }, pi: { exec: vi.fn() } }));

// Import after mocks are in place
import { computeSpawnTarget } from "../../src/spawn/spawn-target.js";

/* ------------------------------------------------------------------ */
/*  Shared setup                                                      */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; reset the stateful ones explicitly.
  mockValidateWorktreePath.mockReset();
  mockResolveSubagentTrust.mockReset().mockReturnValue(true);
});

/** Configure the validator to resolve a clean target. */
function validatedTarget(overrides: Partial<Extract<WorktreeValidationResult, { ok: true }>> = {}): void {
  mockValidateWorktreePath.mockResolvedValue({
    ok: true,
    resolvedPath: "/repo-b-resolved",
    worktreeRoot: "/repo-b-resolved",
    label: "repo-b-resolved",
    sameRepo: true,
    ...overrides,
  } satisfies WorktreeValidationResult);
}

/* ------------------------------------------------------------------ */
/*  Omitted / blank path                                              */
/* ------------------------------------------------------------------ */

describe("computeSpawnTarget — omitted and blank paths", () => {
  it("treats an omitted path as a trusted non-target without validating", async () => {
    const target = await computeSpawnTarget(fakeCtx(), undefined);

    expect(target).toEqual({ ok: true, projectTrusted: true, warnings: [] });
    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    expect(mockResolveSubagentTrust).not.toHaveBeenCalled();
  });

  it("treats a whitespace path as omitted (no bogus discovery dir downstream)", async () => {
    const target = await computeSpawnTarget(fakeCtx(), "   ");

    expect(target).toEqual({ ok: true, projectTrusted: true, warnings: [] });
    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Valid path — validation + trust composition                        */
/* ------------------------------------------------------------------ */

describe("computeSpawnTarget — validation plus trust", () => {
  it("validates against the session cwd and resolves trust from the validated path", async () => {
    validatedTarget({ sameRepo: false });
    mockResolveSubagentTrust.mockReturnValue(false);

    const target = await computeSpawnTarget(fakeCtx({ cwd: "/ctx/cwd" }), "/repo-b");

    expect(mockValidateWorktreePath).toHaveBeenCalledWith(
      expect.objectContaining({ exec: expect.any(Function) }),
      "/repo-b",
      "/session/cwd",
      expect.any(Function),
    );
    expect(mockResolveSubagentTrust).toHaveBeenCalledWith({
      targetPath: "/repo-b-resolved",
      sameRepo: false,
      deps: trustDeps,
    });
    expect(target).toEqual({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeLabel: "repo-b-resolved",
      projectTrusted: false,
      warnings: [],
    });
  });

  it("wires the trust gate from pi's building blocks at the parent cwd", async () => {
    validatedTarget({ sameRepo: false });

    await computeSpawnTarget(fakeCtx({ cwd: "/ctx/cwd" }), "/repo-b");

    expect(mockCreateSubagentTrustDeps).toHaveBeenCalledWith(expect.any(String), "/session/cwd");
  });

  it("collects validator warnings into the result instead of notifying", async () => {
    mockValidateWorktreePath.mockImplementation(async (_pi, _path, _cwd, onWarning) => {
      onWarning?.("git rev-parse failed somewhere");
      return {
        ok: true,
        resolvedPath: "/repo-b-resolved",
        worktreeRoot: "/repo-b-resolved",
        label: "repo-b-resolved",
        sameRepo: true,
      } satisfies WorktreeValidationResult;
    });

    const target = await computeSpawnTarget(fakeCtx(), "/repo-b");

    expect(target).toMatchObject({ ok: true, warnings: ["git rev-parse failed somewhere"] });
  });
});

/* ------------------------------------------------------------------ */
/*  Validation failures                                               */
/* ------------------------------------------------------------------ */

describe("computeSpawnTarget — validation failures", () => {
  it("maps a validation failure to ok:false with the validator's error, without a trust read", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "worktree_path is not inside a git repository",
    } satisfies WorktreeValidationResult);

    const target = await computeSpawnTarget(fakeCtx(), "/nope");

    expect(target).toEqual({
      ok: false,
      error: "worktree_path is not inside a git repository",
      warnings: [],
    });
    expect(mockResolveSubagentTrust).not.toHaveBeenCalled();
  });

  it("wraps a validator crash as a self-correctable validation failure", async () => {
    mockValidateWorktreePath.mockRejectedValue(new Error("boom"));

    const target = await computeSpawnTarget(fakeCtx(), "/x");

    expect(target).toEqual({ ok: false, error: "worktree_path validation failed: boom", warnings: [] });
  });
});
