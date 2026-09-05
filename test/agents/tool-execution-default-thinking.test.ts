/**
 * tool-execution-default-thinking.test.ts — Regression tests for the
 * thinking-level chain in the LLM-driven spawn path.
 *
 * Two seams are covered:
 *   - toolCallListener: injects the spawn-effective thinking into the Agent
 *     tool call input as frontmatter > pi per-model > defaultThinking, never
 *     overwriting an explicit param
 *   - executeAgentTool: resolves explicit param > frontmatter and defers
 *     per-model / defaultThinking to the spawn runner (whose chain keeps
 *     per-model above defaultThinking)
 *
 * Tests observable behavior (the injected input / the spawn intent), not
 * internal call order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx } from "../fixtures.js";
import type { ExtensionAPI, ExtensionContext, CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { SpawnIntent } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { ThinkingLevel } from "../../src/types.js";

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
  storeState,
  perModelState,
} = vi.hoisted(() => ({
  mockGetAgentConfig: vi.fn<() => AgentConfig | undefined>(defaultAgentConfig),
  mockSpawn: vi.fn(),
  mockGetRecord: vi.fn(),
  mockDiscoverNewAgents: vi.fn(),
  mockValidateWorktreePath: vi.fn(),
  storeState: {
    defaultThinking: undefined as string | undefined,
    defaultMaxTurns: undefined as number | undefined,
    modelFor: undefined as string | undefined,
  },
  perModelState: { value: undefined as ThinkingLevel | undefined },
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

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => ({ kind: "resolved", key: type })),
  resolveTypeOrDiscover: vi.fn(async (type: string, worktreeDir?: string) => {
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
  // Faithful to the real parser: valid levels pass through, everything else is undefined.
  parseThinkingLevel: vi.fn((raw?: string) => (raw !== undefined && VALID_THINKING.includes(raw) ? raw : undefined)),
}));

// The per-model read is the injection's pi-settings seam; the target cwd and
// provider/modelId key are pinned by the listener tests below.
vi.mock("../../src/pi-settings.js", () => ({
  getPiModelThinkingLevel: vi.fn(
    (_cwd: string, _provider: string, _modelId: string, _agentDir?: string) => perModelState.value,
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
      return { agentId: "agent-id-123", record };
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
import { getPiModelThinkingLevel } from "../../src/pi-settings.js";

/* ------------------------------------------------------------------ */
/*  Shared setup                                                      */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  storeState.defaultThinking = undefined;
  storeState.defaultMaxTurns = undefined;
  storeState.modelFor = undefined;
  perModelState.value = undefined;
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
    perModelState.value = "high";
    storeState.defaultThinking = "max";
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("high");
  });

  it("reads the per-model level keyed by the parent model's provider/modelId", async () => {
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(vi.mocked(getPiModelThinkingLevel)).toHaveBeenCalledWith("/home/test/project", "test", "model");
  });

  it("reads the per-model level at the spawn's target cwd and model when resolved by the store chain", async () => {
    perModelState.value = "low";
    storeState.modelFor = "anthropic/claude-opus-4-1";
    const event = makeEvent({ worktree_path: "/repo-b" });

    await toolCallListener(event, fakeCtx({ cwd: "/home/test/project" }));

    expect(vi.mocked(getPiModelThinkingLevel)).toHaveBeenCalledWith("/repo-b", "anthropic", "claude-opus-4-1");
    expect(event.input.thinking).toBe("low");
  });

  it("prefers agent frontmatter thinking over the per-model level", async () => {
    perModelState.value = "high";
    mockGetAgentConfig.mockReturnValue(makeAgentConfig({ thinkingLevel: "low" }));
    const event = makeEvent();

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("low");
  });

  it("keeps an explicit thinking param unchanged", async () => {
    storeState.defaultThinking = "max";
    perModelState.value = "high";
    const event = makeEvent({ thinking: "medium" });

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("medium");
    // An explicit param means the chain is never consulted.
    expect(vi.mocked(getPiModelThinkingLevel)).not.toHaveBeenCalled();
  });

  it("leaves thinking undefined when nothing is configured (inherit parent)", async () => {
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
