/**
 * restart-last-agents-thinking.test.ts — Thinking resolution on the replay path.
 *
 * Seam: handleRestartLastAgents → resolveAndSpawn → coordinator.spawn intent.
 * A replayed run resolves a `parent` value against its own parent session, so a
 * level frozen into the historical tool call never pins the replay, and the
 * `parent` value itself never reaches the spawn intent or invocation record.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { ExtensionCommandContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { fakeCtx, shellMock } from "../fixtures.js";
import { asCommandContext } from "../pi-boundaries.js";
import type { AgentRecord, ThinkingChoice, ThinkingLevel } from "../../src/types.js";
import type { SpawnIntent, SpawnResult } from "../../src/spawn/spawn-coordinator.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { TypeResolution } from "../../src/agents/agent-types.js";

const { mockCoordinatorSpawn, mockGetAgentConfig, storeState } = vi.hoisted(() => ({
  mockCoordinatorSpawn: vi.fn<(pi: unknown, ctx: unknown, intent: SpawnIntent) => Promise<SpawnResult>>(async () => ({
    agentId: "agent-id-1",
    record: fakeRecord(),
    isBackground: true,
  })),
  mockGetAgentConfig: vi.fn<() => AgentConfig | undefined>(() => ({
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
  })),
  storeState: { defaultThinking: undefined as ThinkingChoice | undefined },
}));

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

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveTypeOrDiscover: vi.fn(async (type: string): Promise<TypeResolution> => ({ kind: "resolved", key: type })),
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
          defaultThinking: storeState.defaultThinking,
        };
      },
      modelFor: () => "",
    },
  }),
);

import { handleRestartLastAgents } from "../../src/agents/restart-last-agents.js";

function agentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "general-purpose",
    description: "Test agent",
    systemPrompt: "test prompt",
    maxTurns: 25,
    ...overrides,
  };
}

/** A session history holding one Agent tool call with the given arguments. */
function historyWithCall(args: JsonObject, parentLevel?: ThinkingLevel): ExtensionCommandContext {
  const entry = {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "Agent", arguments: args } satisfies ToolCall & { type: "toolCall" },
      ],
    },
  } as SessionMessageEntry;
  const ctx = asCommandContext(fakeCtx({ thinkingLevel: parentLevel }));
  vi.mocked(ctx.sessionManager.getEntries).mockReturnValue([entry]);
  return ctx;
}

function lastSpawnIntent(): SpawnIntent {
  return mockCoordinatorSpawn.mock.calls[0][2];
}

beforeEach(() => {
  vi.clearAllMocks();
  storeState.defaultThinking = undefined;
  mockGetAgentConfig.mockReturnValue(agentConfig({}));
});

describe("restart — thinking resolution", () => {
  it("replays a frontmatter `parent` at the replay session's own parent level", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "parent" }));

    await handleRestartLastAgents(historyWithCall({ prompt: "Do it" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBe("minimal");
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBe("minimal");
  });

  it("spawns with nothing rather than the `parent` value when no parent level is available", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "parent" }));

    await handleRestartLastAgents(historyWithCall({ prompt: "Do it" }));

    expect(lastSpawnIntent().thinkingLevel).toBeUndefined();
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBeUndefined();
  });

  it("keeps the level of a historical explicit thinking param", async () => {
    mockGetAgentConfig.mockReturnValue(agentConfig({ thinkingLevel: "low" }));

    await handleRestartLastAgents(historyWithCall({ prompt: "Do it", thinking: "high" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBe("high");
  });

  it("defers a config `parent` to the spawn runner instead of freezing the parent level", async () => {
    storeState.defaultThinking = "parent";

    await handleRestartLastAgents(historyWithCall({ prompt: "Do it" }, "minimal"));

    expect(lastSpawnIntent().thinkingLevel).toBeUndefined();
    expect(lastSpawnIntent().invocation?.thinkingLevel).toBeUndefined();
  });
});
