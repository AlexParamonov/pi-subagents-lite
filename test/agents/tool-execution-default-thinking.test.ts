/**
 * tool-execution-default-thinking.test.ts — Regression tests for the
 * thinking-level chain in the LLM-driven spawn path.
 *
 * Two seams are covered:
 *   - toolCallListener: injects the spawn-effective thinking into the Agent
 *     tool call input as frontmatter > pi per-model > defaultThinking, never
 *     overwriting an explicit param. The per-model term carries the spawn
 *     target's trust decision into the settings read: an untrusted cross-repo
 *     worktree target's own settings file must not reach the spawn through the
 *     injected value, while the user's global layer still applies.
 *   - executeAgentTool: resolves explicit param > frontmatter and defers
 *     per-model / defaultThinking to the spawn runner (whose chain keeps
 *     per-model above defaultThinking)
 *
 * Tests observable behavior (the injected input / the spawn intent), not
 * internal call order.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fakeCtx } from "../fixtures.js";
import type { ExtensionAPI, ExtensionContext, CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { SpawnIntent } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { ThinkingLevel } from "../../src/types.js";
import type { WorktreeValidationResult } from "../../src/spawn/worktree-validator.js";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Mutable state so per-test values are visible to the hoisted mock factories.
const {
  mockGetAgentConfig,
  mockSpawn,
  mockGetRecord,
  mockDiscoverNewAgents,
  mockValidateWorktreePath,
  mockResolveSubagentTrust,
  storeState,
  perModelState,
} = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn<() => AgentConfig | undefined>(defaultAgentConfig),
  mockSpawn: vi.fn(),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(),
  mockValidateWorktreePath: vi.fn<() => Promise<WorktreeValidationResult>>(async () => ({
    ok: false,
    error: "no validation result configured",
  })),
  mockResolveSubagentTrust: vi.fn<() => boolean>(() => true),
  storeState: {
    defaultThinking: undefined as string | undefined,
    defaultMaxTurns: undefined as number | undefined,
    modelFor: undefined as string | undefined,
  },
  perModelState: {
    global: undefined as ThinkingLevel | undefined,
    project: undefined as ThinkingLevel | undefined,
  },
}));
/** Baseline agent config; tests override the fields under test. */
function defaultAgentConfig(): AgentConfig {
  return {
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
  };
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), ...overrides };
}

const VALID_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string) => resolved.split("/").pop() || resolved),
}));

// The trust decision is a controlled value: the listener must gate its
// per-model read on it exactly as the spawn runtime does.
vi.mock("../../src/spawn/project-trust.js", () => ({
  resolveSubagentTrust: mockResolveSubagentTrust,
  createSubagentTrustDeps: vi.fn(() => ({})),
  untrustedProjectWarning: vi.fn((targetPath: string) => `untrusted: ${targetPath}`),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  resolveTypeOrDiscover: vi.fn(async (type: string, _worktreeDir?: string) => {
    const resolution = { kind: "resolved" as const, key: type };
    return resolution;
  }),
  getAgentConfig: mockGetAgentConfig,
  discoverNewAgents: mockDiscoverNewAgents,
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn((value: unknown) => {
    if (typeof value !== "string") return null;
    const idx = value.indexOf("/");
    return idx <= 0 ? null : { provider: value.slice(0, idx), modelId: value.slice(idx + 1) };
  }),
  findModelInRegistry: vi.fn(() => undefined),
  // Faithful to the real parser: valid levels and `parent` pass, everything else is undefined.
  parseThinkingChoice: vi.fn((raw?: string) =>
    raw !== undefined && (VALID_THINKING.includes(raw) || raw === "parent") ? raw : undefined,
  ),
}));

// The per-model read is the injection's pi-settings seam; the target cwd and
// provider/modelId key are pinned by the listener tests below. The fake is
// faithful to pi's scope rule: an untrusted project's layer is dropped, the
// user's global layer stays.
vi.mock("../../src/pi-settings.js", () => ({
  getPiModelThinkingLevel: vi.fn((_cwd: string, _provider: string, _modelId: string, scope?: PiSettingsScope) =>
    scope?.projectTrusted === false ? perModelState.global : (perModelState.project ?? perModelState.global),
  ),
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    get agent() {
      return {
        graceTurns: 5,
        forceBackground: false,
        defaultThinking: storeState.defaultThinking,
        defaultMaxTurns: storeState.defaultMaxTurns,
      };
    },
    modelFor: vi.fn(() => storeState.modelFor),
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
  getCoordinator: () => ({
    spawn: vi.fn(async (pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent) => {
      mockSpawn(pi, ctx, intent.type, intent.prompt, {
        thinkingLevel: intent.thinkingLevel,
        maxTurns: intent.maxTurns,
      });
      const record = mockGetRecord("agent-id-123");
      if (!intent.runInBackground && record?.execution?.promise) {
        await record.execution.promise;
      }
      return { agentId: "agent-id-123", record, isBackground: intent.runInBackground };
    }),
    isBackground: vi.fn(() => false),
    scheduleNudge: vi.fn(),
    onAgentComplete: vi.fn(),
    dispose: vi.fn(),
  }),
  getWidget: () => ({ ensureTimer: vi.fn(), update: vi.fn() }),
}));

vi.mock("../../src/agents/usage.js", () => ({
  addUsage: vi.fn(),
  getLifetimeTotal: vi.fn(() => 0),
  getSessionContextPercent: vi.fn(() => null),
}));

// Import after mocks are in place
import { executeAgentTool, toolCallListener } from "../../src/agents/tool-execution.js";
import { getPiModelThinkingLevel, type PiSettingsScope } from "../../src/pi-settings.js";

/* ------------------------------------------------------------------ */
/*  Shared setup                                                      */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; reset the stateful ones explicitly.
  mockValidateWorktreePath.mockReset();
  mockResolveSubagentTrust.mockReset().mockReturnValue(true);
  storeState.defaultThinking = undefined;
  storeState.defaultMaxTurns = undefined;
  storeState.modelFor = undefined;
  perModelState.global = undefined;
  perModelState.project = undefined;
  mockGetAgentConfig.mockReturnValue(defaultAgentConfig());
});

/* ------------------------------------------------------------------ */
/*  toolCallListener — spawn-effective thinking injection              */
/* ------------------------------------------------------------------ */

describe("toolCallListener — thinking injection (frontmatter > per-model > defaultThinking)", () => {
  function makeEvent(input: Record<string, unknown> = {}): CustomToolCallEvent {
    return {
      type: "tool_call",
      toolName: "Agent",
      toolCallId: "call-1",
      input: { agent: "general-purpose", prompt: "do it", ...input },
    };
  }

  it("injects store defaultThinking when no explicit thinking, frontmatter, or per-model level", async () => {
    storeState.defaultThinking = "max";
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("max");
  });

  it("injects the per-model level, which beats defaultThinking", async () => {
    perModelState.global = "high";
    storeState.defaultThinking = "max";
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("high");
  });

  it("reads the per-model level keyed by the parent model's provider/modelId", async () => {
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(vi.mocked(getPiModelThinkingLevel)).toHaveBeenCalledWith("/home/test/project", "test", "model", {
      projectTrusted: true,
    });
  });

  it("reads the per-model level at the resolved target path and model when the target is trusted", async () => {
    perModelState.project = "low";
    storeState.modelFor = "anthropic/claude-opus-4-1";
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeRoot: "/repo-b-resolved",
      label: "repo-b-resolved",
      sameRepo: true,
    });
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    // Keyed by the validated path (what the spawn will use), not the raw argument.
    expect(vi.mocked(getPiModelThinkingLevel)).toHaveBeenCalledWith(
      "/repo-b-resolved",
      "anthropic",
      "claude-opus-4-1",
      {
        projectTrusted: true,
      },
    );
    expect(event.input.thinking).toBe("low");
  });

  it("keeps the global per-model entry when the target project is untrusted", async () => {
    perModelState.global = "high";
    perModelState.project = "max";
    storeState.modelFor = "anthropic/claude-opus-4-1";
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeRoot: "/repo-b-resolved",
      label: "repo-b-resolved",
      sameRepo: false,
    });
    mockResolveSubagentTrust.mockReturnValue(false);
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    // pi ignores only the untrusted project's layer on the child's settings
    // instance, so the user's own global entry still decides.
    expect(event.input.thinking).toBe("high");
  });

  it("a global per-model entry still beats a `parent` defaultThinking on an untrusted target", async () => {
    // The documented order is unchanged by the target's trust: per-model sits
    // above defaultThinking, so blanking the per-model term let `parent` win a
    // position it does not hold.
    perModelState.global = "high";
    perModelState.project = "max";
    storeState.defaultThinking = "parent";
    storeState.modelFor = "anthropic/claude-opus-4-1";
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeRoot: "/repo-b-resolved",
      label: "repo-b-resolved",
      sameRepo: false,
    });
    mockResolveSubagentTrust.mockReturnValue(false);
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project", thinkingLevel: "minimal" }));

    expect(event.input.thinking).toBe("high");
  });

  it("does not let an untrusted target's project layer set the level (project-trust gate)", async () => {
    perModelState.project = "max";
    storeState.modelFor = "anthropic/claude-opus-4-1";
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeRoot: "/repo-b-resolved",
      label: "repo-b-resolved",
      sameRepo: false,
    });
    mockResolveSubagentTrust.mockReturnValue(false);
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    // The untrusted project's settings file must not set the spawn's thinking
    // through the injected value (it would win as the explicit param).
    expect(event.input.thinking).toBeUndefined();
  });

  it("still injects frontmatter and defaultThinking for an untrusted target, without the per-model term", async () => {
    storeState.defaultThinking = "medium";
    mockValidateWorktreePath.mockResolvedValue({
      ok: true,
      resolvedPath: "/repo-b-resolved",
      worktreeRoot: "/repo-b-resolved",
      label: "repo-b-resolved",
      sameRepo: false,
    });
    mockResolveSubagentTrust.mockReturnValue(false);
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    expect(event.input.thinking).toBe("medium");
  });

  it("skips the per-model read when worktree validation fails (no spawn will run)", async () => {
    mockValidateWorktreePath.mockResolvedValue({
      ok: false,
      error: "worktree_path does not exist: the specified path was not found on disk",
    });
    const event = makeEvent({ worktree_path: "/missing" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    expect(vi.mocked(getPiModelThinkingLevel)).not.toHaveBeenCalled();
  });

  it("prefers agent frontmatter thinking over the per-model level", async () => {
    perModelState.global = "high";
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "low" }));
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("low");
  });

  it("keeps an explicit thinking param unchanged", async () => {
    storeState.defaultThinking = "max";
    perModelState.global = "high";
    const event = makeEvent({ thinking: "medium" });

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("medium");
    // An explicit param means the chain is never consulted.
    expect(vi.mocked(getPiModelThinkingLevel)).not.toHaveBeenCalled();
  });

  it("leaves thinking undefined when nothing is configured", async () => {
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBeUndefined();
  });

  it("injects the parent session's level when frontmatter holds `parent`, beating per-model", async () => {
    perModelState.global = "high";
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "parent" }));
    const event = makeEvent();

    await toolCallListener(event, fakeCtx({ thinkingLevel: "minimal" }));

    expect(event.input.thinking).toBe("minimal");
  });

  it("injects the parent session's level when defaultThinking holds `parent`", async () => {
    storeState.defaultThinking = "parent";
    const event = makeEvent();

    await toolCallListener(event, fakeCtx({ thinkingLevel: "low" }));

    expect(event.input.thinking).toBe("low");
  });

  it("injects nothing when the only `parent` source has no parent level to follow", async () => {
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "parent" }));
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  executeAgentTool — defaultThinking fallback                        */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — explicit/frontmatter resolution, per-model + defaultThinking deferred", () => {
  let ctx: ExtensionContext;

  beforeEach(() => {
    ctx = fakeCtx();
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

  function spawnThinkingLevel(): unknown {
    return mockSpawn.mock.calls[0]?.[4]?.thinkingLevel;
  }

  it("defers defaultThinking to the spawn runner (its chain keeps per-model above it)", async () => {
    storeState.defaultThinking = "max";

    await executeAgentTool("tc-1", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBeUndefined();
  });

  it("prefers agent frontmatter thinking over store defaultThinking", async () => {
    storeState.defaultThinking = "max";
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "low" }));

    await executeAgentTool("tc-2", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBe("low");
  });

  it("prefers explicit thinking param over frontmatter and default", async () => {
    storeState.defaultThinking = "max";
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "low" }));

    await executeAgentTool(
      "tc-3",
      { agent: "general-purpose", prompt: "do it", thinking: "medium" },
      undefined,
      undefined,
      ctx,
    );

    expect(spawnThinkingLevel()).toBe("medium");
  });

  it("keeps thinking undefined when nothing is configured (inherit parent)", async () => {
    await executeAgentTool("tc-4", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBeUndefined();
  });

  it("spawns at the parent session's level when frontmatter holds `parent`", async () => {
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "parent" }));

    await executeAgentTool(
      "tc-5",
      { agent: "general-purpose", prompt: "do it" },
      undefined,
      undefined,
      fakeCtx({ thinkingLevel: "minimal" }),
    );

    expect(spawnThinkingLevel()).toBe("minimal");
  });

  it("never spawns with the `parent` value itself when no parent level is available", async () => {
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "parent" }));

    await executeAgentTool("tc-6", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBeUndefined();
  });

  it("resolves a `parent` value in a replayed thinking param against this session's parent level", async () => {
    await executeAgentTool(
      "tc-7",
      { agent: "general-purpose", prompt: "do it", thinking: "parent" },
      undefined,
      undefined,
      fakeCtx({ thinkingLevel: "low" }),
    );

    expect(spawnThinkingLevel()).toBe("low");
  });
});

/* ------------------------------------------------------------------ */
/*  executeAgentTool — defaultMaxTurns fallback                        */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — defaultMaxTurns fallback", () => {
  let ctx: ExtensionContext;

  beforeEach(() => {
    ctx = fakeCtx();
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

  function spawnMaxTurns(): unknown {
    return mockSpawn.mock.calls[0]?.[4]?.maxTurns;
  }

  it("falls back to store defaultMaxTurns when no explicit param and no frontmatter", async () => {
    storeState.defaultMaxTurns = 50;
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: undefined }));

    await executeAgentTool("tc-mt-1", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnMaxTurns()).toBe(50);
  });

  it("prefers explicit max_turns param over store defaultMaxTurns", async () => {
    storeState.defaultMaxTurns = 50;

    await executeAgentTool(
      "tc-mt-2",
      { agent: "general-purpose", prompt: "do it", max_turns: 10 },
      undefined,
      undefined,
      ctx,
    );

    expect(spawnMaxTurns()).toBe(10);
  });

  it("prefers agent frontmatter maxTurns over store defaultMaxTurns", async () => {
    storeState.defaultMaxTurns = 50;
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: 30 }));

    await executeAgentTool("tc-mt-3", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnMaxTurns()).toBe(30);
  });

  it("keeps maxTurns undefined when nothing is configured", async () => {
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ maxTurns: undefined }));

    await executeAgentTool("tc-mt-4", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnMaxTurns()).toBeUndefined();
  });
});
