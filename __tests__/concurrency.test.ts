/**
 * concurrency.test.ts — Tests for per-model concurrency in agent-manager.ts
 *
 * Tests focus on:
 *   - Per-model concurrency limits (each model/key has its own slot count)
 *   - Queue drain checks per-model-key limits (not global)
 *   - Different models queue independently
 *   - Default limit for unknown models
 *   - Config update mid-session applies to new spawns
 *   - Foreground agents bypass the queue
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { fakeCtx, fakePi, makeResolvablePromise } from "./fixtures";

// --- Mock modules ---

const mockModules = vi.hoisted(() => {
  let uuidCounter = 0;

  return {
    mockRunAgent: vi.fn(),
    mockRandomUUID: vi.fn(() => {
      uuidCounter++;
      return `agent-${String(uuidCounter).padStart(8, "0")}`;
    }),
    resetUuidCounter: () => { uuidCounter = 0; },
  };
});

vi.mock("node:crypto", () => ({
  randomUUID: mockModules.mockRandomUUID,
}));

vi.mock("../extensions/agent-runner.js", () => ({
  runAgent: mockModules.mockRunAgent,
}));

/** Minimal mock session for concurrency tests. */
function mockAgentSession(): any {
  return { subscribe: vi.fn(), messages: [], dispose: vi.fn() };
}

/** Mock RunResult returned by runAgent. */
function mockRunResult(overrides?: Partial<ReturnType<typeof mockRunResult>>) {
  return {
    responseText: "done",
    session: mockAgentSession(),
    aborted: false,
    steered: false,
    ...overrides,
  };
}

// --- Import the module under test ---
import { AgentManager } from "../extensions/agent-manager.js";
import type { ConcurrencyConfig } from "../extensions/agent-manager.js";

describe("AgentManager concurrency", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockModules.resetUuidCounter();
    mockModules.mockRunAgent.mockReset();
    mkdirSync("/tmp/pi-agent-outputs", { recursive: true });

    onComplete = vi.fn();
  });

  afterEach(() => {
    manager?.dispose();
  });

  describe("spawn within limit", () => {
    it("starts all agents when under per-model limit", () => {
      const config: ConcurrencyConfig = { default: 4, models: {} };
      manager = new AgentManager(onComplete, config);

      // RunAgent resolves immediately
      mockModules.mockRunAgent.mockResolvedValue(mockRunResult());

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      // All 3 should be running, not queued
      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(manager.getRecord(id3)?.status).toBe("running");

      // runAgent should have been called 3 times
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(3);
    });
  });

  describe("spawn at limit", () => {
    it("queues agents when per-model limit is reached", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      // Create a deferred promise for the first agent
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      // First agent should be running, second should be queued
      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("queued");

      // runAgent should only have been called once
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(1);

      // Complete the first agent to unblock
      deferred.resolve(mockRunResult());
    });
  });

  describe("completion drains queue", () => {
    it("starts queued agent when running agent completes", async () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b_small": 1 } };
      manager = new AgentManager(onComplete, config);

      // Deferred for both agents — second must stay "running" after drain
      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b_small",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.status).toBe("queued");

      // Resolve the first agent
      deferred1.resolve(mockRunResult());

      // Wait for async completion + drainQueue tick
      await new Promise((r) => setTimeout(r, 10));

      // Second agent should now be running (deferred2 is still pending)
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);

      // Clean up
      deferred2.resolve(mockRunResult());
    });
  });

  describe("different models independent", () => {
    it("queues agents per-model independently", () => {
      const config: ConcurrencyConfig = {
        default: 4,
        models: {
          "llamacpp/27b": 1,
          "llamacpp/4b": 4,
        },
      };
      manager = new AgentManager(onComplete, config);

      // Both need deferred to keep them "running"
      const deferred1 = makeResolvablePromise();
      const deferred2 = makeResolvablePromise();
      const deferred3 = makeResolvablePromise();
      mockModules.mockRunAgent
        .mockReturnValueOnce(deferred1.promise)
        .mockReturnValueOnce(deferred2.promise)
        .mockReturnValueOnce(deferred3.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // Spawn for model A (limit 1) — fills the slot
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });

      // Spawn for model B (limit 4) — should start immediately
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      // Second spawn for model A (limit 1) — should be queued
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "llamacpp/27b",
        isBackground: true,
      });

      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(manager.getRecord(id3)?.status).toBe("queued");

      // runAgent should have been called twice (model A run, model B run)
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe("default limit", () => {
    it("applies default limit for unknown models", () => {
      const config: ConcurrencyConfig = { default: 2, models: {} };
      manager = new AgentManager(onComplete, config);

      const deferred1 = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred1.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // Unknown model "claude/sonnet" not in models map — should use default
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "claude/sonnet",
        isBackground: true,
      });
      const id3 = manager.spawn(pi, ctx, "general-purpose", "task 3", {
        description: "task 3",
        modelKey: "claude/sonnet",
        isBackground: true,
      });

      // Default is 2, so first 2 should run, 3rd should queue
      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(manager.getRecord(id3)?.status).toBe("queued");

      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe("config update mid-session", () => {
    it("applies new limit when setConcurrency is called", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // Fill the slot
      const id1 = manager.spawn(pi, ctx, "general-purpose", "task 1", {
        description: "task 1",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });
      const id2 = manager.spawn(pi, ctx, "general-purpose", "task 2", {
        description: "task 2",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      expect(manager.getRecord(id2)?.status).toBe("queued");

      // Increase limit to 2 — this should drain the queue
      manager.setConcurrency({ default: 1, models: { "llamacpp/4b": 2 } });

      // Queued agent should now be running
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe("foreground bypasses queue", () => {
    it("starts foreground agent immediately regardless of limit", () => {
      const config: ConcurrencyConfig = { default: 1, models: { "llamacpp/4b": 1 } };
      manager = new AgentManager(onComplete, config);

      // Deferred for the first agent
      const deferred = makeResolvablePromise();
      mockModules.mockRunAgent.mockReturnValue(deferred.promise);

      const ctx = fakeCtx();
      const pi = fakePi();

      // Fill the slot with a background agent
      const id1 = manager.spawn(pi, ctx, "general-purpose", "bg task", {
        description: "bg task",
        modelKey: "llamacpp/4b",
        isBackground: true,
      });

      // Spawn foreground agent — should bypass queue
      const id2 = manager.spawn(pi, ctx, "general-purpose", "fg task", {
        description: "fg task",
        modelKey: "llamacpp/4b",
        isBackground: false,
      });

      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("running");
      expect(mockModules.mockRunAgent).toHaveBeenCalledTimes(2);
    });
  });
});
