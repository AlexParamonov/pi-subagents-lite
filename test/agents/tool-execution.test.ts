/**
 * worktree-tool-execution.test.ts — Acceptance tests for worktree_path
 * validation in the Agent tool execution flow.
 *
 * Verifies:
 *   - Valid worktree_path: validator is called, resolved path passed into spawn options
 *   - Invalid worktree_path: validator error returned to LLM, no spawn
 *   - Omitted worktree_path: no validator call, spawn uses parent cwd
 *   - Error details from validator are surfaced to the LLM
 *
 * Tests the integration boundary between executeAgentTool and the validator.
 * Mocks the validator module and the spawn flow; tests observable behavior
 * (tool result content) not internal call order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, makeResolvablePromise } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Use vi.hoisted so mock factories can reference these at hoisting time
const {
  mockValidateWorktreePath,
  mockSpawn,
  mockGetRecord,
  mockDiscoverNewAgents,
  mockResolveSubagentTrust,
  mockResolveType,
  mockStoreState,
} = vi.hoisted(() => ({
  mockValidateWorktreePath: vi.fn(),
  mockSpawn: vi.fn().mockReturnValue("agent-id-123"),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(),
  mockResolveSubagentTrust: vi.fn(),
  mockResolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  mockStoreState: { forceBackground: false },
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string, root: string) => {
    if (resolved === root) return root.split("/").pop() || root;
    const rel = resolved.slice(root.length + 1);
    return `${root.split("/").pop()}/${rel}`;
  }),
}));

vi.mock("../../src/spawn/project-trust.js", () => ({
  resolveSubagentTrust: mockResolveSubagentTrust,
  createSubagentTrustDeps: vi.fn(),
  untrustedProjectWarning: (p: string) => `Target project at ${p} is not trusted`,
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: mockResolveType,
  getAgentConfig: vi.fn(() => ({ maxTurns: 25, thinkingLevel: undefined })),
  discoverNewAgents: mockDiscoverNewAgents,
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => null),
  parseThinkingLevel: vi.fn(() => undefined),
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    get agent() {
      return { graceTurns: 5, forceBackground: mockStoreState.forceBackground };
    },
    modelFor(type: string, parentModelId: string, agentConfig?: any) {
      // Simplified model resolution for testing
      if (agentConfig?.model) return agentConfig.model;
      return parentModelId;
    },
  }),
  getPiInstance: () => ({ sendMessage: vi.fn(), exec: vi.fn() }),
  getSessionCtx: () => ({ cwd: "/home/test/project" }),
  getManager: () => ({
    spawn: mockSpawn,
    getRecord: mockGetRecord,
    listAgents: vi.fn(() => []),
    getTotalAgentCost: vi.fn(() => 0),
    abort: vi.fn(() => false),
  }),
  getWidget: () => ({
    ensureTimer: vi.fn(),
    update: vi.fn(),
  }),
  getCoordinator: () => ({
    spawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
      // Delegate to the mocked manager.spawn
      const manager = {
        spawn: mockSpawn,
        getRecord: mockGetRecord,
      };
      const id = mockSpawn(_pi, _ctx, intent.type, intent.prompt, {
        description: intent.description,
        model: intent.model,
        maxTurns: intent.maxTurns,
        thinkingLevel: intent.thinkingLevel,
        modelKey: intent.modelKey,
        graceTurns: intent.graceTurns,
        worktreePath: intent.worktreePath,
        worktreeLabel: intent.worktreeLabel,
        projectTrusted: intent.projectTrusted,
        isBackground: intent.runInBackground,
        signal: intent.signal,
      });
      const record = mockGetRecord(id);
      if (!intent.runInBackground && record?.execution?.promise) {
        await record.execution.promise;
      }
      return { agentId: id, record };
    }),
    isBackground: vi.fn(() => false),
    scheduleNudge: vi.fn(),
    onAgentComplete: vi.fn(),
    dispose: vi.fn(),
  }),
}));

vi.mock("../../src/agents/usage.js", () => ({
  addUsage: vi.fn(),
  getLifetimeTotal: vi.fn(() => 0),
  getSessionContextPercent: vi.fn(() => null),
}));

// Import after mocks are in place
import { executeAgentTool, formatResultContent } from "../../src/agents/tool-execution.js";

/* ------------------------------------------------------------------ */
/*  Factories                                                         */
/* ------------------------------------------------------------------ */

function makeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: "Do something useful",
    description: "Test agent",
    agent: "general-purpose",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — worktree_path validation", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("calls the validator when worktree_path is provided", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    await executeAgentTool("tc-1", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(mockValidateWorktreePath).toHaveBeenCalledWith(
      expect.anything(), // pi
      "/wt/feature",
      expect.any(String), // parent cwd
      expect.any(Function), // onWarning
    );
  });

  it("returns an error when worktree_path validation fails", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path '/etc' is not inside a git repository",
    });

    const result = await executeAgentTool("tc-2", makeParams({ worktree_path: "/etc" }), undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not inside a git repository");
    // Should NOT have spawned
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it("flushes validator warnings via ctx.ui.notify on validation failure", async () => {
    // Mock validateWorktreePath to invoke the onWarning callback before returning failure
    mockValidateWorktreePath.mockImplementation((_pi, _path, _cwd, onWarning) => {
      onWarning?.("git rev-parse --git-common-dir failed in /etc: EACCES permission denied");
      return Promise.resolve({
        ok: false,
        error: "worktree_path validation failed: git rev-parse failed: EACCES permission denied",
      });
    });

    ctx.ui = { notify: vi.fn() };
    const result = await executeAgentTool("tc-warn", makeParams({ worktree_path: "/etc" }), undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "[pi-subagents-lite] git rev-parse --git-common-dir failed in /etc: EACCES permission denied",
      "warning",
    );
  });

  it("does not call the validator when worktree_path is omitted", async () => {
    await executeAgentTool("tc-3", makeParams(), undefined, undefined, ctx);

    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("passes the resolved worktree path into spawn options", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    await executeAgentTool("tc-4", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    // Verify spawn received the worktree path via options
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnCall = mockSpawn.mock.calls[0];
    const spawnOptions = spawnCall[4]; // options is 5th arg (pi, ctx, type, prompt, options)
    expect(spawnOptions.worktreePath).toBe("/wt/feature");
  });

  it("surfaces specific validator error reasons to the LLM", async () => {
    const rejectionReasons = [
      { error: "Path does not exist", match: "does not exist" },
      { error: "Path is not a directory", match: "not a directory" },
      { error: "Path is not inside a git repository", match: "not inside a git" },
    ];

    for (const { error, match } of rejectionReasons) {
      vi.clearAllMocks();
      mockValidateWorktreePath.mockResolvedValue({ ok: false, error });

      const result = await executeAgentTool(
        "tc-err",
        makeParams({ worktree_path: "/some/path" }),
        undefined,
        undefined,
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(match);
    }
  });

  it("returns a successful result when worktree_path is valid", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });
    // Foreground spawn completes immediately
    mockGetRecord.mockReturnValue({
      id: "agent-id-123",
      result: "Agent completed successfully",
      display: { type: "general-purpose", description: "Test agent", worktreeLabel: "feature" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        toolUses: 3,
        turnCount: 2,
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool(
      "tc-ok",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Agent completed successfully");
  });

  it("does not crash the parent when validator throws unexpectedly", async () => {
    mockValidateWorktreePath.mockRejectedValue(new Error("Unexpected filesystem error"));

    const result = await executeAgentTool(
      "tc-crash",
      makeParams({ worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Should return an error result, not throw
    expect(result.isError).toBe(true);
  });
});

describe("executeAgentTool — worktree_path with background spawn", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-bg",
      display: { type: "general-purpose", description: "Test agent", worktreeLabel: "feature" },
      lifecycle: { status: "running", startedAt: Date.now() },
      execution: {},
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("validates worktree_path for background spawns too", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    const result = await executeAgentTool(
      "tc-bg",
      makeParams({ worktree_path: "/wt/feature", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockValidateWorktreePath).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("running");
  });

  it("returns error for invalid worktree_path in background spawn", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "Path does not exist",
    });

    const result = await executeAgentTool(
      "tc-bg-err",
      makeParams({ worktree_path: "/nonexistent", run_in_background: true }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — worktree_path discovery integration", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReset clears once-queues leaked by earlier tests in this describe;
    // re-establish the base identity implementation.
    mockResolveType.mockReset();
    mockResolveType.mockImplementation((t: string) => ({ kind: "resolved", key: t }));
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-disc",
      result: "Agent completed successfully",
      display: { type: "feature-reviewer", description: "Reviews feature" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        toolUses: 3,
        turnCount: 2,
        compactionCount: 0,
      },
    });
  });

  it("calls discoverNewAgents with worktree dir when type is not initially known", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });

    // First resolveType call returns not-found (type not known)
    mockResolveType.mockReturnValueOnce({ kind: "not-found" }); // first call — not found
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "feature-reviewer" }); // after discovery — found

    await executeAgentTool(
      "tc-disc",
      makeParams({ agent: "feature-reviewer", worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    // Should have called discoverNewAgents with the worktree's .pi/agents dir
    expect(mockDiscoverNewAgents).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith("/wt/feature/.pi/agents");
  });

  it("calls discoverNewAgents without worktree dir when type is not known and worktree_path omitted", async () => {
    // First resolveType call returns not-found (type not known)
    mockResolveType.mockReturnValueOnce({ kind: "not-found" }); // first call — not found
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "feature-reviewer" }); // after discovery — found

    await executeAgentTool("tc-disc-no-wt", makeParams({ agent: "feature-reviewer" }), undefined, undefined, ctx);

    // Should have called discoverNewAgents WITHOUT a worktree dir
    expect(mockDiscoverNewAgents).toHaveBeenCalledTimes(1);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith(undefined);
  });
});

describe("executeAgentTool — case-insensitive type resolution", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveType.mockReset();
    mockResolveType.mockImplementation((t: string) => ({ kind: "resolved", key: t }));
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-ci",
      result: "Agent completed successfully",
      display: { type: "Explore", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("Agent completed successfully") },
      stats: {
        lifetimeUsage: { input: 100, output: 50, cacheWrite: 0, cost: 0.01 },
        toolUses: 3,
        turnCount: 2,
        compactionCount: 0,
      },
    });
  });

  it("spawns with the canonical registered name for a case-insensitive match", async () => {
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "Explore" });

    const result = await executeAgentTool("tc-ci", makeParams({ agent: "EXPLORE" }), undefined, undefined, ctx);

    expect(result.isError).toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][2]).toBe("Explore");
  });

  it("returns an error naming both candidates for an ambiguous type and spawns nothing", async () => {
    mockResolveType.mockReturnValueOnce({ kind: "ambiguous", candidates: ["Explore", "explore"] });

    const result = await executeAgentTool("tc-amb", makeParams({ agent: "EXPLORE" }), undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ambiguous agent type: EXPLORE");
    expect(result.content[0].text).toContain("Explore");
    expect(result.content[0].text).toContain("explore");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does not trigger a filesystem re-scan when the initial resolution is ambiguous", async () => {
    mockResolveType.mockReturnValueOnce({ kind: "ambiguous", candidates: ["Explore", "explore"] });

    await executeAgentTool("tc-amb-2", makeParams({ agent: "EXPLORE" }), undefined, undefined, ctx);

    expect(mockDiscoverNewAgents).not.toHaveBeenCalled();
  });

  it("resolves case-insensitively against agents discovered from the worktree", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/wt/feature",
      worktreeRoot: "/wt/feature",
      label: "feature",
    });
    // Not known before discovery, then a worktree agent matches case-insensitively
    mockResolveType.mockReturnValueOnce({ kind: "not-found" });
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "Wt-Agent" });

    await executeAgentTool(
      "tc-wt-ci",
      makeParams({ agent: "wt-agent", worktree_path: "/wt/feature" }),
      undefined,
      undefined,
      ctx,
    );

    expect(mockDiscoverNewAgents).toHaveBeenCalledWith("/wt/feature/.pi/agents");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][2]).toBe("Wt-Agent");
  });

  it("returns the existing unknown-type error for unresolvable types", async () => {
    mockResolveType.mockReturnValueOnce({ kind: "not-found" });
    mockResolveType.mockReturnValueOnce({ kind: "not-found" });
    mockDiscoverNewAgents.mockResolvedValue(0);

    const result = await executeAgentTool("tc-unknown", makeParams({ agent: "nope" }), undefined, undefined, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown agent type: nope");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
describe("executeAgentTool — cross-repo trust gate", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-trust",
      result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  function crossRepoValidation(sameRepo: boolean) {
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b",
      worktreeRoot: "/repo-b",
      label: "repo-b",
      sameRepo,
    });
  }

  it("passes the validator's sameRepo flag to the trust resolver", async () => {
    crossRepoValidation(false);
    await executeAgentTool("tc-tr-1", makeParams({ worktree_path: "/repo-b" }), undefined, undefined, ctx);

    expect(mockResolveSubagentTrust).toHaveBeenCalledWith(
      expect.objectContaining({
        targetPath: "/repo-b",
        sameRepo: false,
      }),
    );
  });

  it("spawns with projectTrusted=false and warns for an untrusted cross-repo target", async () => {
    crossRepoValidation(false);
    mockResolveSubagentTrust.mockReturnValue(false);
    // Force the on-demand discovery path so the .pi/agents skip is observable
    mockResolveType.mockReturnValueOnce({ kind: "not-found" });
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "general-purpose" });

    await executeAgentTool("tc-tr-2", makeParams({ worktree_path: "/repo-b" }), undefined, undefined, ctx);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.projectTrusted).toBe(false);
    // Warning surfaced to the user
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not trusted"), "warning");
    // Target .pi/agents discovery is skipped for untrusted targets
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith(undefined);
  });

  it("does not warn and spawns trusted for a trusted cross-repo target", async () => {
    crossRepoValidation(false);
    mockResolveSubagentTrust.mockReturnValue(true);
    mockResolveType.mockReturnValueOnce({ kind: "not-found" });
    mockResolveType.mockReturnValueOnce({ kind: "resolved", key: "general-purpose" });

    await executeAgentTool("tc-tr-3", makeParams({ worktree_path: "/repo-b" }), undefined, undefined, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.projectTrusted).toBe(true);
    expect(mockDiscoverNewAgents).toHaveBeenCalledWith("/repo-b/.pi/agents");
  });

  it("passes sameRepo: true and spawns with projectTrusted: true when the resolver returns true", async () => {
    crossRepoValidation(true);
    await executeAgentTool("tc-tr-4", makeParams({ worktree_path: "/wt/feature" }), undefined, undefined, ctx);

    expect(mockResolveSubagentTrust).toHaveBeenCalledWith(expect.objectContaining({ sameRepo: true }));
    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.projectTrusted).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("spawns trusted for a cross-repo target when the trust resolver returns true (no warning)", async () => {
    crossRepoValidation(false);
    mockResolveSubagentTrust.mockReturnValue(true);

    await executeAgentTool("tc-tr-5", makeParams({ worktree_path: "/repo-b" }), undefined, undefined, ctx);

    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.projectTrusted).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

describe("executeAgentTool — foreground error result", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = fakeCtx();
  });

  it("returns an isError result containing type, model, and provider error for a failed run", async () => {
    mockGetRecord.mockReturnValue({
      id: "agent-id-err",
      result: "",
      error: "feature-reviewer (anthropic/claude-sonnet-4): model failed to load",
      display: { type: "feature-reviewer", description: "Reviews feature" },
      lifecycle: { status: "error", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });

    const result = await executeAgentTool(
      "tc-err",
      makeParams({ agent: "feature-reviewer" }),
      undefined,
      undefined,
      ctx,
    );

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("feature-reviewer");
    expect(text).toContain("anthropic/claude-sonnet-4");
    expect(text).toContain("model failed to load");
  });
});

describe("formatResultContent", () => {
  function makeContentRecord(overrides: Record<string, unknown> = {}) {
    return {
      result: "done",
      lifecycle: { status: "completed", startedAt: Date.now() },
      ...overrides,
    } as any;
  }

  it("appends the recorded error message for error status", () => {
    const content = formatResultContent(
      makeContentRecord({ lifecycle: { status: "error", startedAt: Date.now() }, error: "model failed to load" }),
    );

    expect(content).toBe("done\n\nError: model failed to load");
  });

  it("keeps completed output unchanged (no error block)", () => {
    expect(formatResultContent(makeContentRecord())).toBe("done");
  });

  it("keeps aborted output unchanged", () => {
    const content = formatResultContent(makeContentRecord({ lifecycle: { status: "aborted", startedAt: Date.now() } }));

    expect(content).toBe("done (hit the turn limit before completion; output may be incomplete)");
  });

  it("keeps turn_limited output unchanged", () => {
    const content = formatResultContent(
      makeContentRecord({ lifecycle: { status: "turn_limited", startedAt: Date.now() } }),
    );

    expect(content).toBe("done (wrapped up at the turn limit — output may be partial)");
  });

  it("does not append a dangling error block when error text is missing", () => {
    const content = formatResultContent(makeContentRecord({ lifecycle: { status: "error", startedAt: Date.now() } }));

    expect(content).toBe("done");
  });

  it("surfaces the watchdog reason with tool name and duration for watchdog stops", () => {
    const content = formatResultContent(
      makeContentRecord({
        lifecycle: {
          status: "stopped",
          startedAt: Date.now(),
          stoppedBy: "watchdog",
          stopDetail: { kind: "tool", toolName: "bash", elapsedMs: 46 * 60_000 },
        },
      }),
    );

    expect(content).toContain("STOPPED BY WATCHDOG");
    expect(content).toContain("bash");
    expect(content).toContain("46m");
  });
  it("appends the stopped note to partial output for a ran-then-stopped agent", () => {
    const content = formatResultContent(
      makeContentRecord({
        result: "partial work",
        lifecycle: { status: "stopped", startedAt: Date.now(), stoppedBy: "user", started: true },
      }),
    );

    expect(content).toContain("partial work");
    expect(content).toContain("STOPPED BY THE USER");
    expect(content).toContain("output is partial");
  });

  it("never claims partial output for a never-started stopped record", () => {
    const content = formatResultContent(
      makeContentRecord({
        result: "",
        lifecycle: { status: "stopped", startedAt: Date.now(), stoppedBy: "user", started: false },
      }),
    );

    expect(content).toContain("before the agent started");
    expect(content).toContain("NOT attempted");
    expect(content).not.toContain("output is partial");
  });

  it("does not append an error block to a stopped record even when the run recorded an error", () => {
    const content = formatResultContent(
      makeContentRecord({
        result: "partial",
        error: "boom",
        lifecycle: { status: "stopped", startedAt: Date.now(), stoppedBy: "user" },
      }),
    );

    expect(content).toContain("partial");
    expect(content).not.toContain("Error: boom");
  });
});

describe("executeAgentTool — parent signal forwarding", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.forceBackground = false;
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
    mockGetRecord.mockReturnValue({
      id: "agent-id-sig",
      result: "done",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 1000, completedAt: Date.now() },
      execution: { promise: Promise.resolve("done") },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    });
  });

  it("forwards the execute signal to a foreground spawn", async () => {
    const controller = new AbortController();
    await executeAgentTool("tc-sig", makeParams(), controller.signal, undefined, ctx);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.signal).toBe(controller.signal);
  });

  it("does not forward the signal to an explicit run_in_background spawn", async () => {
    const controller = new AbortController();
    await executeAgentTool("tc-bg-sig", makeParams({ run_in_background: true }), controller.signal, undefined, ctx);

    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.isBackground).toBe(true);
    expect(spawnOptions.signal).toBeUndefined();
  });

  it("does not forward the signal when forceBackground is enabled", async () => {
    mockStoreState.forceBackground = true;
    const controller = new AbortController();
    await executeAgentTool("tc-fg-sig", makeParams(), controller.signal, undefined, ctx);

    const spawnOptions = mockSpawn.mock.calls[0][4];
    expect(spawnOptions.isBackground).toBe(true);
    expect(spawnOptions.signal).toBeUndefined();
  });
});

describe("executeAgentTool — queued foreground spawn", () => {
  let ctx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.forceBackground = false;
    ctx = fakeCtx();
    mockResolveSubagentTrust.mockReturnValue(true);
  });

  it("returns the real result for a queued foreground spawn, never an early empty string", async () => {
    const gate = makeResolvablePromise();
    const record: any = {
      id: "agent-id-queued",
      result: undefined,
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "queued", startedAt: Date.now() },
      execution: { promise: gate.promise },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        compactionCount: 0,
      },
    };
    mockGetRecord.mockReturnValue(record);

    let toolSettled = false;
    const toolResult = executeAgentTool("tc-queued", makeParams(), undefined, undefined, ctx);
    void toolResult.then(() => {
      toolSettled = true;
    });

    // The subagent is queued — the tool call must stay suspended.
    await Promise.resolve();
    await Promise.resolve();
    expect(toolSettled).toBe(false);

    // A slot frees: the subagent starts and settles with its full result.
    record.lifecycle.status = "completed";
    record.result = "full result text";
    gate.resolve("full result text");
    const result = await toolResult;

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("full result text");
    expect(result.content[0].text).not.toBe("");
  });
});
