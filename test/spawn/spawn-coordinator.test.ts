/**
 * spawn-coordinator.test.ts — Tests for SpawnCoordinator.
 *
 * Verifies: spawn (foreground/background), nudge batching, live-view lifecycle,
 * onAgentComplete, dispose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";

// --- Mock modules ---

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => undefined),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/worktree-validator.js", () => ({
  validateWorktreePath: vi.fn(async () => ({ ok: true, resolvedPath: "/wt", label: "wt" })),
}));

vi.mock("../../src/utils.js", () => ({
  parseModelKey: vi.fn(() => null),
  findModelInRegistry: vi.fn(() => undefined),
  parseThinkingLevel: vi.fn(() => undefined),
}));

vi.mock("../../src/config/config-io.js", () => ({
  loadConfig: vi.fn(() => ({ agent: { default: null, forceBackground: false }, concurrency: { default: 4 } })),
  saveConfigAtomic: vi.fn(),
  DEFAULT_CONFIG: { agent: { default: null, forceBackground: false }, concurrency: { default: 4 } },
}));

function makeMockManager() {
  const records = new Map<string, any>();
  return {
    spawn: vi.fn((pi: any, ctx: any, type: string, prompt: string, options: any) => {
      const id = `agent-${records.size}`;
      const record: any = {
        id,
        display: { type, description: options.description },
        lifecycle: { status: options.isBackground ? "running" : "running", startedAt: Date.now() },
        execution: { promise: Promise.resolve("done") },
        stats: {
          lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
          toolUses: 0,
          turnCount: 1,
          maxTurns: options.maxTurns,
          compactionCount: 0,
        },
        result: "done",
      };
      records.set(id, record);
      return id;
    }),
    getRecord: vi.fn((id: string) => records.get(id)),
    listAgents: vi.fn(() => [...records.values()]),
    abort: vi.fn(() => true),
    steer: vi.fn(async () => true),
    getTotalAgentCost: vi.fn(() => 0),
    dispose: vi.fn(),
    onComplete: undefined as any,
    onStart: undefined as any,
  };
}

function makeMockPi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI;
}

function makeMockCtx() {
  return { cwd: "/test", model: undefined, modelRegistry: {} } as unknown as ExtensionContext;
}

// --- Tests ---

describe("SpawnCoordinator", () => {
  // Dynamically import after mocks are set up
  let SpawnCoordinator: typeof import("../../src/spawn/spawn-coordinator.js").SpawnCoordinator;
  let manager: ReturnType<typeof makeMockManager>;
  let pi: ExtensionAPI;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    const mod = await import("../../src/spawn/spawn-coordinator.js");
    SpawnCoordinator = mod.SpawnCoordinator;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns a background agent and returns result", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test spawn",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(result.agentId).toBeTruthy();
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(manager.spawn.mock.calls[0][2]).toBe("builder");
    expect(manager.spawn.mock.calls[0][3]).toBe("do something");
    expect(manager.spawn.mock.calls[0][4].isBackground).toBe(true);
  });

  it("spawns a foreground agent and awaits its promise", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.record).toBeTruthy();
    expect(manager.spawn.mock.calls[0][4].isBackground).toBe(false);
  });

  it("creates a live view on spawn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      graceTurns: 6,
      runInBackground: true,
    });

    const view = coordinator.liveView(result.agentId);
    expect(view).toBeDefined();
    expect(view!.activeTools).toBeInstanceOf(Map);
    expect(view!.responseText).toBe("");
  });

  it("cleans up live view on foreground completion", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      graceTurns: 6,
      runInBackground: false,
    });

    // After foreground spawn completes, live view should be cleaned up
    const view = coordinator.liveView(result.agentId);
    expect(view).toBeUndefined();
  });

  it("registers background agent in backgroundAgentIds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test bg",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(true);
  });

  it("does not register foreground agent in backgroundAgentIds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(pi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test fg",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(coordinator.isBackground(result.agentId)).toBe(false);
  });

  describe("nudge scheduling", () => {
    it("emits individual nudge after delay window", async () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);

      // Spawn a background agent first to get a valid record
      const result = await coordinator.spawn(pi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      coordinator.scheduleNudge(result.agentId);

      // Not yet emitted — timer pending
      expect(pi.sendMessage).not.toHaveBeenCalled();

      // Advance past the 200ms batch window
      vi.advanceTimersByTime(200);

      // Now the nudge should have been emitted
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("batches multiple nudges within the delay window", async () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);

      // Spawn two background agents
      const r1 = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", graceTurns: 6, runInBackground: true,
      });
      const r2 = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", graceTurns: 6, runInBackground: true,
      });

      coordinator.scheduleNudge(r1.agentId);
      coordinator.scheduleNudge(r2.agentId);

      // Advance past the batch window
      vi.advanceTimersByTime(200);

      // Both should be emitted as individual messages
      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not emit nudge for agent without record", () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);
      // agent-999 doesn't exist in the mock manager
      coordinator.scheduleNudge("agent-999");

      vi.advanceTimersByTime(200);

      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it("starts new batch window for nudges arriving after the previous window", async () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);

      const r1 = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task 1", description: "Test 1", graceTurns: 6, runInBackground: true,
      });
      const r2 = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task 2", description: "Test 2", graceTurns: 6, runInBackground: true,
      });

      coordinator.scheduleNudge(r1.agentId);

      vi.advanceTimersByTime(200);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);

      // New nudge after the window
      coordinator.scheduleNudge(r2.agentId);

      // Not yet emitted
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(pi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("onAgentComplete", () => {
    it("deletes live view on completion", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      // Manually add a live view
      (coordinator as any).liveViews.set("agent-1", { activeTools: new Map(), responseText: "" });

      coordinator.onAgentComplete({ id: "agent-1" } as AgentRecord);

      expect(coordinator.liveView("agent-1")).toBeUndefined();
    });

    it("schedules nudge for background agents", async () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);

      // Spawn a background agent
      const result = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });

      // Simulate completion
      coordinator.onAgentComplete({ id: result.agentId } as AgentRecord);

      // Nudge should be scheduled
      vi.advanceTimersByTime(200);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);

      // Should be removed from background set
      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("does not schedule nudge for foreground agents", () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);
      // Not in backgroundAgentIds

      coordinator.onAgentComplete({ id: "agent-1" } as AgentRecord);

      vi.advanceTimersByTime(200);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("dispose", () => {
    it("clears nudge timer", async () => {
      const coordinator = new SpawnCoordinator(manager as any, pi);

      // Spawn a background agent
      const result = await coordinator.spawn(pi, ctx, {
        type: "builder", prompt: "task", description: "Test", graceTurns: 6, runInBackground: true,
      });
      coordinator.scheduleNudge(result.agentId);

      coordinator.dispose();

      // Timer should be cleared — advancing time should not emit
      vi.advanceTimersByTime(500);
      expect(pi.sendMessage).not.toHaveBeenCalled();
    });

    it("clears live views", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      (coordinator as any).liveViews.set("agent-1", { activeTools: new Map(), responseText: "" });

      coordinator.dispose();

      expect(coordinator.liveView("agent-1")).toBeUndefined();
    });
  });
});
