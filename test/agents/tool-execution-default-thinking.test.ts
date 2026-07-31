/**
 * tool-execution-default-thinking.test.ts — Regression tests for
 * defaultThinking fallback in the LLM-driven spawn path.
 *
 * Verifies the resolution chain for thinking level:
 *   explicit param > agent frontmatter > store.agent.defaultThinking > undefined (inherit)
 *
 * Two seams are covered:
 *   - toolCallListener: injects thinking into the Agent tool call input
 *   - executeAgentTool: resolves thinkingLevel passed to the spawn coordinator
 *
 * Tests observable behavior (the injected input / the spawn intent), not
 * internal call order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx } from "../fixtures.ts";

/* ------------------------------------------------------------------ */
/*  Mock setup                                                        */
/* ------------------------------------------------------------------ */

// Mutable state so per-test values are visible to the hoisted mock factories.
const { mockGetAgentConfig, mockSpawn, mockGetRecord, mockDiscoverNewAgents, mockValidateWorktreePath, storeState } =
  vi.hoisted(() => ({
    mockGetAgentConfig: vi.fn(() => ({ maxTurns: 25, thinkingLevel: undefined })),
    mockSpawn: vi.fn(),
    mockGetRecord: vi.fn(),
    mockDiscoverNewAgents: vi.fn(),
    mockValidateWorktreePath: vi.fn(),
    storeState: { defaultThinking: undefined as string | undefined },
  }));

const VALID_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

vi.mock("../../src/spawn/worktree-validator.js", () => ({
  validateWorktreePath: mockValidateWorktreePath,
  computeLabel: vi.fn((resolved: string) => resolved.split("/").pop() || resolved),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((type: string) => type),
  getAgentConfig: mockGetAgentConfig,
  discoverNewAgents: mockDiscoverNewAgents,
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => undefined),
  // Faithful to the real parser: valid levels pass through, everything else is undefined.
  parseThinkingLevel: vi.fn((raw?: string) =>
    raw !== undefined && VALID_THINKING.includes(raw) ? raw : undefined,
  ),
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    get agent() {
      return {
        graceTurns: 5,
        forceBackground: false,
        defaultThinking: storeState.defaultThinking,
      };
    },
    modelFor: vi.fn(() => undefined),
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
    spawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
      mockSpawn(_pi, _ctx, intent.type, intent.prompt, {
        thinkingLevel: intent.thinkingLevel,
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

/* ------------------------------------------------------------------ */
/*  Shared setup                                                      */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  storeState.defaultThinking = undefined;
  mockGetAgentConfig.mockReturnValue({ maxTurns: 25, thinkingLevel: undefined });
});

/* ------------------------------------------------------------------ */
/*  toolCallListener — defaultThinking injection                       */
/* ------------------------------------------------------------------ */

describe("toolCallListener — defaultThinking injection", () => {
  function makeEvent(input: Record<string, unknown> = {}) {
    return { toolName: "Agent", input: { agent: "general-purpose", prompt: "do it", ...input } };
  }

  it("injects store defaultThinking when no explicit thinking and no agent frontmatter", async () => {
    storeState.defaultThinking = "max";
    const event = makeEvent() as any;

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("max");
  });

  it("prefers agent frontmatter thinking over store defaultThinking", async () => {
    storeState.defaultThinking = "max";
    mockGetAgentConfig.mockReturnValue({ maxTurns: 25, thinkingLevel: "low" });
    const event = makeEvent() as any;

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("low");
  });

  it("keeps an explicit thinking param unchanged", async () => {
    storeState.defaultThinking = "max";
    const event = makeEvent({ thinking: "high" }) as any;

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBe("high");
  });

  it("leaves thinking undefined when nothing is configured (inherit parent)", async () => {
    const event = makeEvent() as any;

    await toolCallListener(event, fakeCtx());

    expect(event.input.thinking).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  executeAgentTool — defaultThinking fallback                        */
/* ------------------------------------------------------------------ */

describe("executeAgentTool — defaultThinking fallback", () => {
  let ctx: any;

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

  it("falls back to store defaultThinking when no explicit param and no frontmatter", async () => {
    storeState.defaultThinking = "max";

    await executeAgentTool("tc-1", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBe("max");
  });

  it("prefers agent frontmatter thinking over store defaultThinking", async () => {
    storeState.defaultThinking = "max";
    mockGetAgentConfig.mockReturnValue({ maxTurns: 25, thinkingLevel: "low" });

    await executeAgentTool("tc-2", { agent: "general-purpose", prompt: "do it" }, undefined, undefined, ctx);

    expect(spawnThinkingLevel()).toBe("low");
  });

  it("prefers explicit thinking param over frontmatter and default", async () => {
    storeState.defaultThinking = "max";
    mockGetAgentConfig.mockReturnValue({ maxTurns: 25, thinkingLevel: "low" });

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
