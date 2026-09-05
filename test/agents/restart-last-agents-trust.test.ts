/**
 * restart-last-agents-trust.test.ts — Restart applies the live spawn's trust
 * gate to historical worktree_path values.
 *
 * Seam: handleRestartLastAgents → resolveAndSpawn → the shared
 * computeSpawnTarget (spied via a pass-through module mock, so the same
 * definition the live Agent tool path uses is exercised) → coordinator.spawn
 * intent. Tests pin the exact projectTrusted value forwarded per call, the
 * trust-gated .pi/agents discovery dir, the surfaced warnings, and the
 * skipped line for invalid targets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionCommandContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fakeCtx, shellMock } from "../fixtures.js";
import { asCommandContext } from "../pi-boundaries.js";
import type { AgentRecord } from "../../src/types.js";
import type { SpawnIntent, SpawnResult } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { TypeResolution } from "../../src/agents/agent-types.js";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

const {
  mockCoordinatorSpawn,
  mockValidateWorktreePath,
  mockResolveSubagentTrust,
  mockResolveTypeOrDiscover,
  mockGetAgentConfig,
  mockComputeSpawnTarget,
  storeState,
} = vi.hoisted(() => ({
  mockCoordinatorSpawn: vi.fn<(pi: unknown, ctx: unknown, intent: SpawnIntent) => Promise<SpawnResult>>(async () => ({
    agentId: "agent-id-1",
    record: fakeRecord(),
  })),
  mockValidateWorktreePath: vi.fn(),
  mockResolveSubagentTrust: vi.fn(() => true),
  mockResolveTypeOrDiscover: vi.fn(async (type: string, _worktreeDir?: string): Promise<TypeResolution> => ({
    kind: "resolved",
    key: type,
  })),
  mockGetAgentConfig: vi.fn<() => AgentConfig | undefined>(defaultAgentConfig),
  mockComputeSpawnTarget: vi.fn(),
  storeState: { loadExtensionsImplicitly: undefined as boolean | undefined },
}));

/** Baseline agent config; getAgentConfig always resolves. */
function defaultAgentConfig(): AgentConfig {
  return {
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
  };
}

/** Minimal settled-shaped record for the coordinator spawn result. */
function fakeRecord(): AgentRecord {
  return {
    id: "agent-id-1",
    display: { type: "general-purpose", description: "Do it" },
    lifecycle: { status: "running", startedAt: Date.now(), started: false },
    execution: { settled: false, settlementCount: 0 },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      toolUses: 0,
      compactionCount: 0,
    },
  };
}

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string) => resolved.split("/").pop() || resolved),
}));

vi.mock("../../src/spawn/project-trust.js", () => ({
  resolveSubagentTrust: mockResolveSubagentTrust,
  createSubagentTrustDeps: vi.fn(() => ({})),
  untrustedProjectWarning: vi.fn((targetPath: string) => `untrusted: ${targetPath}`),
}));

// Pass-through spy: pins that restart resolves spawn targets through the
// same shared computeSpawnTarget the live Agent tool path uses — one trust
// decision, one definition (AC-7).
vi.mock("../../src/spawn/spawn-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/spawn/spawn-target.js")>();
  mockComputeSpawnTarget.mockImplementation(actual.computeSpawnTarget);
  return { computeSpawnTarget: mockComputeSpawnTarget };
});

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveTypeOrDiscover: mockResolveTypeOrDiscover,
  getAgentConfig: mockGetAgentConfig,
  resolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/shell.js", () =>
  shellMock({
    coordinator: { spawn: mockCoordinatorSpawn },
    store: {
      get agent() {
        return {
          graceTurns: 6,
          forceBackground: false,
          defaultMaxTurns: 25,
          loadExtensionsImplicitly: storeState.loadExtensionsImplicitly,
        };
      },
      modelFor: () => "", // falsy → no model override resolves
    },
  }),
);

// Import after mocks are in place
import { handleRestartLastAgents } from "../../src/agents/restart-last-agents.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function messageEntry(id: string, role: "user" | "assistant", content: unknown[]): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content },
  } as SessionMessageEntry;
}

function agentToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: "toolCall",
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    name: "Agent",
    arguments: args,
  };
}

function entriesWithCalls(calls: Record<string, unknown>[]): SessionMessageEntry[] {
  return [messageEntry("a1", "assistant", calls.map(agentToolCall))];
}

function commandCtx(entries: SessionMessageEntry[]): ExtensionCommandContext {
  const ctx = asCommandContext(fakeCtx());
  vi.mocked(ctx.sessionManager.getEntries).mockReturnValue(entries);
  return ctx;
}

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

function lastSpawnIntent(call = 0): SpawnIntent {
  return mockCoordinatorSpawn.mock.calls[call][2];
}

function notifyCalls(ctx: ExtensionCommandContext): Array<[string, string]> {
  return (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
}

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; reset the stateful ones explicitly.
  mockValidateWorktreePath.mockReset();
  mockResolveSubagentTrust.mockReset().mockReturnValue(true);
  storeState.loadExtensionsImplicitly = undefined; // config default: !== false → discovery allowed
});

/* ------------------------------------------------------------------ */
/*  Trusted / same-repo target — behavior unchanged                    */
/* ------------------------------------------------------------------ */

describe("restart with a trusted or same-repo worktree_path", () => {
  it("spawns with projectTrusted true, the validated path, and discovers the target .pi/agents types", async () => {
    validatedTarget({ sameRepo: true, label: "repo-b-resolved" });

    const result = await handleRestartLastAgents(
      commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }])),
    );

    expect(result).toEqual({ restarted: ["general-purpose: Do it"], skipped: [] });
    const intent = lastSpawnIntent();
    expect(intent.projectTrusted).toBe(true);
    expect(intent.worktreePath).toBe("/repo-b-resolved");
    expect(intent.worktreeLabel).toBe("repo-b-resolved");
    expect(mockResolveTypeOrDiscover).toHaveBeenCalledWith("general-purpose", "/repo-b-resolved/.pi/agents");
  });

  it("keeps target discovery off when loadExtensionsImplicitly is disabled (behavior unchanged)", async () => {
    storeState.loadExtensionsImplicitly = false;
    validatedTarget({ sameRepo: true });

    await handleRestartLastAgents(commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }])));

    // The spawn itself stays trusted; only the worktree type scan is gated.
    expect(lastSpawnIntent().projectTrusted).toBe(true);
    expect(mockResolveTypeOrDiscover).toHaveBeenCalledWith("general-purpose", undefined);
  });
});

/* ------------------------------------------------------------------ */
/*  Untrusted cross-repo target                                        */
/* ------------------------------------------------------------------ */

describe("restart with an untrusted cross-repo worktree_path", () => {
  it("forwards projectTrusted false, hides the target .pi/agents types, and still spawns", async () => {
    validatedTarget({ sameRepo: false });
    mockResolveSubagentTrust.mockReturnValue(false);

    const result = await handleRestartLastAgents(
      commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }])),
    );

    // Untrusted targets spawn with resources ignored — never degraded to a skip.
    expect(result.restarted).toEqual(["general-purpose: Do it"]);
    expect(lastSpawnIntent().projectTrusted).toBe(false);
    expect(mockResolveTypeOrDiscover).toHaveBeenCalledWith("general-purpose", undefined);
  });

  it("surfaces the untrusted-project warning through the notify channel", async () => {
    validatedTarget({ sameRepo: false });
    mockResolveSubagentTrust.mockReturnValue(false);
    const ctx = commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }]));

    await handleRestartLastAgents(ctx);

    expect(notifyCalls(ctx)).toContainEqual(["[pi-subagents-lite] untrusted: /repo-b-resolved", "warning"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Invalid worktree_path                                              */
/* ------------------------------------------------------------------ */

describe("restart with an invalid worktree_path", () => {
  it("skips the call with the validation error and spawns nothing", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "worktree_path is not inside a git repository",
    } satisfies WorktreeValidationResult);

    const result = await handleRestartLastAgents(
      commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/nope" }])),
    );

    expect(result.restarted).toEqual([]);
    expect(result.skipped).toEqual(["general-purpose: Do it (worktree_path is not inside a git repository)"]);
    expect(mockCoordinatorSpawn).not.toHaveBeenCalled();
    expect(mockResolveTypeOrDiscover).not.toHaveBeenCalled();
  });

  it("surfaces validator warnings via the notify channel", async () => {
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
    const ctx = commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }]));

    await handleRestartLastAgents(ctx);

    expect(notifyCalls(ctx)).toContainEqual(["[pi-subagents-lite] git rev-parse failed somewhere", "warning"]);
  });
});

/* ------------------------------------------------------------------ */
/*  No worktree_path — unchanged behavior                              */
/* ------------------------------------------------------------------ */

describe("restart without a worktree_path", () => {
  it("performs no validation or trust resolution and spawns as before", async () => {
    const result = await handleRestartLastAgents(commandCtx(entriesWithCalls([{ prompt: "Do it" }])));

    expect(result).toEqual({ restarted: ["general-purpose: Do it"], skipped: [] });
    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    expect(mockResolveSubagentTrust).not.toHaveBeenCalled();
    expect(lastSpawnIntent().projectTrusted).toBe(true);
    expect(lastSpawnIntent().worktreePath).toBeUndefined();
    expect(mockResolveTypeOrDiscover).toHaveBeenCalledWith("general-purpose", undefined);
  });

  it("treats a blank worktree_path as omitted (keys off the resolved target, not the raw string)", async () => {
    await handleRestartLastAgents(commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "   " }])));

    expect(mockValidateWorktreePath).not.toHaveBeenCalled();
    const intent = lastSpawnIntent();
    expect(intent.projectTrusted).toBe(true);
    expect(intent.worktreePath).toBeUndefined();
    expect(mockResolveTypeOrDiscover).toHaveBeenCalledWith("general-purpose", undefined);
  });
});

/* ------------------------------------------------------------------ */
/*  Shared helper + per-call resolution                                */
/* ------------------------------------------------------------------ */

describe("restart resolves each call through the shared spawn target", () => {
  it("goes through the same computeSpawnTarget the live Agent tool path uses", async () => {
    validatedTarget({ sameRepo: true });
    const ctx = commandCtx(entriesWithCalls([{ prompt: "Do it", worktree_path: "/repo-b" }]));

    await handleRestartLastAgents(ctx);

    expect(mockComputeSpawnTarget).toHaveBeenCalledWith(ctx, "/repo-b");
  });

  it("resolves the trust decision per call, not per restart", async () => {
    mockValidateWorktreePath
      .mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/repo-a-resolved",
        worktreeRoot: "/repo-a-resolved",
        label: "repo-a-resolved",
        sameRepo: true,
      } satisfies WorktreeValidationResult)
      .mockResolvedValueOnce({
        ok: true,
        resolvedPath: "/repo-b-resolved",
        worktreeRoot: "/repo-b-resolved",
        label: "repo-b-resolved",
        sameRepo: false,
      } satisfies WorktreeValidationResult);
    mockResolveSubagentTrust.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await handleRestartLastAgents(
      commandCtx(
        entriesWithCalls([
          { prompt: "Task one", description: "One", worktree_path: "/repo-a" },
          { prompt: "Task two", description: "Two", worktree_path: "/repo-b" },
        ]),
      ),
    );

    expect(result.restarted).toEqual(["general-purpose: One", "general-purpose: Two"]);
    expect(lastSpawnIntent(0).projectTrusted).toBe(true);
    expect(lastSpawnIntent(1).projectTrusted).toBe(false);
    expect(mockResolveTypeOrDiscover).toHaveBeenNthCalledWith(1, "general-purpose", "/repo-a-resolved/.pi/agents");
    expect(mockResolveTypeOrDiscover).toHaveBeenNthCalledWith(2, "general-purpose", undefined);
  });
});
