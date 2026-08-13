/**
 * spawn-coordinator.test.ts — Tests for SpawnCoordinator.

 * Verifies: spawn (foreground/background), nudge batching, live-view lifecycle,
 * onAgentComplete, dispose, stale pi protection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../../src/types.js";

// --- Mock modules ---

vi.mock("../../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getAgentConfig: vi.fn(() => undefined),
  discoverNewAgents: vi.fn(async () => 0),
}));

vi.mock("../../src/spawn/worktree-validator.js", () => ({
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

// Hoist mock pi so shell mock can return it
const { mockPi, mockGetPiInstance } = vi.hoisted(() => ({
  mockPi: {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as ExtensionAPI,
  mockGetPiInstance: vi.fn(() => null as unknown as ExtensionAPI),
}));

vi.mock("../../src/shell.js", () => ({
  getPiInstance: () => mockGetPiInstance(),
  getSessionCtx: () => ({ isIdle: () => true }),
  getWidget: () => null,
}));

function makeMockManager(opts: { pendingGate?: boolean } = {}) {
  const records = new Map<string, any>();
  // Capture forwarded spawn arguments (named fields, not positional indices) so
  // tests assert the coordinator's output to the manager without call indexing.
  const spawnCalls: Array<{ id: string; pi: any; ctx: any; type: string; prompt: string; options: any }> = [];
  // Completion-gate resolvers for records whose gate the test holds open.
  const gateResolvers = new Map<string, (value: any) => void>();
  return {
    spawn: vi.fn((pi: any, ctx: any, type: string, prompt: string, options: any) => {
      const id = `agent-${records.size}`;
      spawnCalls.push({ id, pi, ctx, type, prompt, options });
      const promise = opts.pendingGate
        ? new Promise<any>((resolve) => gateResolvers.set(id, resolve))
        : Promise.resolve("done");
      const record: any = {
        id,
        display: { type, description: options.description },
        lifecycle: { status: options.isBackground ? "running" : "running", startedAt: Date.now() },
        execution: { promise },
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
    getSpawnCalls: vi.fn(() => spawnCalls),
    getGateResolver: vi.fn((id: string) => gateResolvers.get(id)),
    listAgents: vi.fn(() => [...records.values()]),
    abort: vi.fn(() => true),
    dispose: vi.fn(() => {
      records.clear();
    }),
    getTotalAgentCost: vi.fn(() => 0),
    onComplete: undefined as any,
    onStart: undefined as any,
  };
}

function makeMockCtx() {
  return { cwd: "/test", model: undefined, modelRegistry: {} } as unknown as ExtensionContext;
}

// --- Tests ---

describe("SpawnCoordinator", () => {
  // Dynamically import after mocks are set up
  let SpawnCoordinator: typeof import("../../src/spawn/spawn-coordinator.js").SpawnCoordinator;
  let manager: ReturnType<typeof makeMockManager>;
  let ctx: ExtensionContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    manager = makeMockManager();
    ctx = makeMockCtx();
    mockPi.sendMessage.mockReset(); // full reset — no impl or calls leak between tests
    mockGetPiInstance.mockReturnValue(mockPi);
    const mod = await import("../../src/spawn/spawn-coordinator.js");
    SpawnCoordinator = mod.SpawnCoordinator;
  });

  it("spawns a background agent and returns result", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test spawn",
      graceTurns: 6,
      runInBackground: true,
    });

    expect(result.agentId).toBeTruthy();
    // Args forwarded to the spawn manager are the coordinator's observable output.
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const spawn = manager.getSpawnCalls()[0];
    expect(spawn.type).toBe("builder");
    expect(spawn.prompt).toBe("do something");
    expect(spawn.options.isBackground).toBe(true);
  });

  it("spawns a foreground agent and awaits its promise", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test foreground",
      graceTurns: 6,
      runInBackground: false,
    });

    expect(result.agentId).toBeTruthy();
    expect(result.record).toBeTruthy();
    expect(manager.getSpawnCalls()[0].options.isBackground).toBe(false);
  });

  it("creates a live view on spawn", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
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

  it("keeps the live view after foreground completion (the agent can be continued)", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
      type: "builder",
      prompt: "do something",
      description: "Test",
      graceTurns: 6,
      runInBackground: false,
    });

    // The live view rides on the record: it survives settlement so a
    // continuation can keep feeding the same view.
    expect(coordinator.liveView(result.agentId)).toBeDefined();
  });

  it("registers background agent in backgroundAgentIds", async () => {
    const coordinator = new SpawnCoordinator(manager as any);
    const result = await coordinator.spawn(mockPi, ctx, {
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
    const result = await coordinator.spawn(mockPi, ctx, {
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
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      coordinator.scheduleNudge(result.agentId);

      // Not yet emitted — timer pending
      expect(mockPi.sendMessage).not.toHaveBeenCalled();

      // Advance past the 200ms batch window
      vi.advanceTimersByTime(200);

      // Now the nudge should have been emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("batches multiple nudges within the delay window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task 1",
        description: "Test 1",
        graceTurns: 6,
        runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task 2",
        description: "Test 2",
        graceTurns: 6,
        runInBackground: true,
      });

      coordinator.scheduleNudge(r1.agentId);
      coordinator.scheduleNudge(r2.agentId);

      // Advance past the batch window
      vi.advanceTimersByTime(200);

      // Both should be emitted as individual messages
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("does not emit nudge for agent without record", () => {
      const coordinator = new SpawnCoordinator(manager as any);
      // agent-999 doesn't exist in the mock manager
      coordinator.scheduleNudge("agent-999");

      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("starts new batch window for nudges arriving after the previous window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const r1 = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task 1",
        description: "Test 1",
        graceTurns: 6,
        runInBackground: true,
      });
      const r2 = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task 2",
        description: "Test 2",
        graceTurns: 6,
        runInBackground: true,
      });

      coordinator.scheduleNudge(r1.agentId);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // New nudge after the window
      coordinator.scheduleNudge(r2.agentId);

      // Not yet emitted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("nudge content", () => {
    it("includes the recorded error message when the background agent failed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      result.record.lifecycle.status = "error";
      result.record.error = "model failed to load";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      // The nudge message we send the user IS the observable outcome.
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      // Header (status) and result content still present; error text appended
      expect(content).toBe('[Subagent "builder" agent-0 error]\n\ndone\n\nError: model failed to load');
    });

    it("keeps the nudge unchanged for non-error completions", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      result.record.lifecycle.status = "completed";

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      // The nudge message we send the user IS the observable outcome.
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      expect(content).toBe('[Subagent "builder" agent-0 completed]\n\ndone');
    });
  });

  describe("onAgentComplete", () => {
    it("keeps the live view after completion (a continuation re-feeds it)", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      expect(coordinator.liveView(result.agentId)).toBeDefined();

      coordinator.onAgentComplete({ id: result.agentId } as AgentRecord);

      expect(coordinator.liveView(result.agentId)).toBeDefined();
    });

    it("schedules nudge for background agents", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Simulate completion
      coordinator.onAgentComplete({ id: result.agentId } as AgentRecord);

      // Nudge should be scheduled
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // Should be removed from background set
      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("re-feeds the live view with activity after completion", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      const spawn = manager.getSpawnCalls()[0];

      coordinator.onAgentComplete({ id: result.agentId } as AgentRecord);

      // Continuation activity flows through the same spawn-time callbacks
      // into the retained live view.
      spawn.options.onToolActivity({ type: "start", toolName: "bash", toolCallId: "c1" });
      spawn.options.onTextDelta("hel", "hello world");

      const view = coordinator.liveView(result.agentId)!;
      expect(view.activeTools.size).toBe(1);
      expect(view.responseText).toBe("hello world");
    });

    it("does not schedule nudge for foreground agents", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      // The record exists, so only the backgroundAgentIds guard can
      // prevent the nudge from being scheduled and emitted.
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("nudges on every continuation settlement of a background agent", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // First settlement consumes the one-shot set entry and nudges once.
      result.record.execution.settlementCount = 1;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);

      // Each continuation settlement nudges again.
      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(2);

      result.record.execution.settlementCount = 3;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(3);
    });

    it("schedules a nudge for a continued foreground agent", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not nudge a foreground agent's initial completion", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      result.record.execution.settlementCount = 1;
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("delivers no nudge for a never-started foreground stop", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      // Never-started stops notify directly without incrementing the counter.
      result.record.execution.settlementCount = 0;
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps the never-started background stop nudge unchanged", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // The one-shot set still gates the first settlement even when the
      // counter never incremented (queued stop / already-aborted spawn).
      result.record.execution.settlementCount = 0;
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("never emits more than one nudge for settlements within one batch window", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // First and continuation settlements inside the same 200ms window
      // coalesce into a single batched nudge — never more than one.
      result.record.execution.settlementCount = 1;
      coordinator.onAgentComplete(result.record);
      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);

      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps a continued foreground agent reporting as foreground", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);

      expect(coordinator.isBackground(result.agentId)).toBe(false);
    });

    it("catches sendMessage errors silently (stale pi)", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Make sendMessage throw (simulates stale pi)
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // sendMessage was attempted
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("skips nudge emission when disposed", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      coordinator.scheduleNudge(result.agentId);

      // Dispose before timer fires — should prevent emission
      coordinator.dispose();

      vi.advanceTimersByTime(500);

      // No sendMessage because disposed
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("ui.notify fallback for continuation nudges", () => {
    it("falls back to ui.notify for a continued foreground agent when sendMessage fails", async () => {
      const notify = vi.fn();
      const ctxWithUi = { ...makeMockCtx(), ui: { notify } } as unknown as ExtensionContext;
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      // sendMessage fails — the spawning ctx must still be reachable.
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("does not fall back to ui.notify for a foreground agent's initial completion", async () => {
      const notify = vi.fn();
      const ctxWithUi = { ...makeMockCtx(), ui: { notify } } as unknown as ExtensionContext;
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: false,
      });

      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });

      // Initial completion delivers inline — no nudge, no fallback.
      result.record.execution.settlementCount = 1;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);

      expect(notify).not.toHaveBeenCalled();
    });

    it("keeps the spawning ctx across a background agent's first nudge for the continuation fallback", async () => {
      const notify = vi.fn();
      const ctxWithUi = { ...makeMockCtx(), ui: { notify } } as unknown as ExtensionContext;
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // First settlement: sendMessage works, notify untouched.
      result.record.execution.settlementCount = 1;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();

      // Continuation settlement: sendMessage fails, fallback still has the ctx.
      mockPi.sendMessage.mockImplementation(() => {
        throw new Error("stale context");
      });
      result.record.execution.settlementCount = 2;
      coordinator.onAgentComplete(result.record);
      vi.advanceTimersByTime(200);
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose", () => {
    it("clears nudge timer", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      coordinator.scheduleNudge(result.agentId);

      coordinator.dispose();

      // Timer should be cleared — advancing time should not emit
      vi.advanceTimersByTime(500);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("clears live views", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      expect(coordinator.liveView(result.agentId)).toBeDefined();

      // Teardown disposes both peers; the live view dies with its record.
      manager.dispose();
      coordinator.dispose();

      expect(coordinator.liveView(result.agentId)).toBeUndefined();
    });
  });

  describe("stale pi protection", () => {
    it("reads pi from shell at nudge time, not from spawn", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Nudge still works because it reads from shell at call time
      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);
      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("uses fresh shell pi when shell is updated between spawn and nudge", async () => {
      const coordinator = new SpawnCoordinator(manager as any);

      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Simulate shell being updated (e.g. after reload)
      const freshPi = { ...mockPi, sendMessage: vi.fn() } as unknown as ExtensionAPI;
      mockGetPiInstance.mockReturnValue(freshPi);

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // Fresh pi was used, not the original mockPi
      expect(freshPi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("skips nudge silently when shell has no pi", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const notify = vi.fn();
      const ctxWithUi = { ...makeMockCtx(), ui: { notify } } as unknown as ExtensionContext;

      const result = await coordinator.spawn(mockPi, ctxWithUi, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });

      // Simulate shell having no pi at nudge time
      mockGetPiInstance.mockReturnValue(null);

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      // The record exists, so without the !pi guard the nudge would reach
      // the sendMessage try/catch and fall back to ui.notify. Assert both
      // paths stay silent to pin the guard.
      expect(mockPi.sendMessage).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("nudge message status", () => {
    it("uses lifecycle status in the nudge message", async () => {
      const statuses: Array<{ status: string; expected: string }> = [
        { status: "completed", expected: "completed" },
        { status: "error", expected: "error" },
        { status: "aborted", expected: "aborted" },
        { status: "stopped", expected: "stopped" },
        { status: "turn_limited", expected: "turn_limited" },
      ];

      for (const { status, expected } of statuses) {
        mockPi.sendMessage.mockClear();
        const coordinator = new SpawnCoordinator(manager as any);

        const result = await coordinator.spawn(mockPi, ctx, {
          type: "builder",
          prompt: "task",
          description: "Test",
          graceTurns: 6,
          runInBackground: true,
        });

        manager.getRecord(result.agentId).lifecycle.status = status;
        manager.getRecord(result.agentId).result = "Result text";

        coordinator.scheduleNudge(result.agentId);
        vi.advanceTimersByTime(200);

        expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
        // The nudge message header mirrors the lifecycle status — the message IS the outcome.
        const content = mockPi.sendMessage.mock.calls[0][0].content;
        const shortId = result.agentId.slice(0, 8);
        expect(content).toContain(`[Subagent "builder" ${shortId} ${expected}]`);
      }
    });
  });

  describe("completion gate — foreground wait", () => {
    it("blocks a foreground spawn until the completion gate opens", async () => {
      const manager = makeMockManager({ pendingGate: true });
      const coordinator = new SpawnCoordinator(manager as any);
      let settled = false;
      const spawnPromise = coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test fg",
        graceTurns: 6,
        runInBackground: false,
      });
      void spawnPromise.then(() => {
        settled = true;
      });

      // Gate still closed — the foreground call must stay suspended.
      await Promise.resolve();
      expect(settled).toBe(false);

      const id = manager.getSpawnCalls()[0].id;
      manager.getGateResolver(id)("done");
      const result = await spawnPromise;

      expect(result.agentId).toBe(id);
      expect(settled).toBe(true);
    });

    it("returns immediately for background spawns regardless of the gate", async () => {
      const manager = makeMockManager({ pendingGate: true });
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test bg",
        graceTurns: 6,
        runInBackground: true,
      });

      expect(result.agentId).toBeTruthy();
    });

    it("carries the parent signal through to the manager spawn options", async () => {
      const controller = new AbortController();
      const coordinator = new SpawnCoordinator(manager as any);
      await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "do something",
        description: "Test fg",
        graceTurns: 6,
        runInBackground: false,
        signal: controller.signal,
      });

      expect(manager.getSpawnCalls()[0].options.signal).toBe(controller.signal);
    });
  });

  describe("nudge content — queued background stop", () => {
    it("delivers exactly one Stopped nudge carrying the never-started note", async () => {
      const coordinator = new SpawnCoordinator(manager as any);
      const result = await coordinator.spawn(mockPi, ctx, {
        type: "builder",
        prompt: "task",
        description: "Test",
        graceTurns: 6,
        runInBackground: true,
      });
      const record = manager.getRecord(result.agentId);
      record.lifecycle.status = "stopped";
      record.lifecycle.started = false;
      record.result = undefined;

      coordinator.scheduleNudge(result.agentId);
      vi.advanceTimersByTime(200);

      expect(mockPi.sendMessage).toHaveBeenCalledTimes(1);
      const content = mockPi.sendMessage.mock.calls[0][0].content as string;
      expect(content).toContain("stopped");
      expect(content).toContain("before the agent started");
      expect(content).not.toContain("output is partial");
    });
  });
});
