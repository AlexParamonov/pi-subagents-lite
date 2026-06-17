/**
 * menu-running-agents.test.ts — Tests for showAgentActions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "./menu-mock-setup.js";
import { createMockCtx } from "./menu-test-helpers.js";
import { showAgentActions } from "../src/ui/menu/menu-running-agents.js";

describe("showResultViewer — stats passing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModules.resultViewerCalls.length = 0;
  });

  it("passes stats from AgentRecord when viewing result", async () => {
    const record = {
      id: "test-id-123",
      display: { type: "general-purpose", description: "Test agent" },
      lifecycle: { status: "completed", startedAt: Date.now() - 50000, completedAt: Date.now() - 10000 },
      execution: { session: { messages: [] } },
      result: "some result text",
      stats: { lifetimeUsage: { input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 }, toolUses: 10, turnCount: 15, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx(["View result", undefined]);
    await showAgentActions(ctx, record);
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall).toBeDefined();
    const stats = lastCall[5];
    expect(stats.lifetimeUsage).toEqual({ input: 12000, output: 8000, cacheWrite: 3000, cost: 0.024 });
    expect(stats.turnCount).toBe(15);
    expect(stats.durationMs).toBeGreaterThanOrEqual(40000);
  });

  it("passes stats when viewing error", async () => {
    const record = {
      id: "test-id-456",
      display: { type: "general-purpose", description: "Error agent" },
      lifecycle: { status: "error", startedAt: Date.now() - 30000, completedAt: Date.now() - 5000 },
      execution: {},
      error: "something went wrong",
      stats: { lifetimeUsage: { input: 500, output: 200, cacheWrite: 50, cost: 0.005 }, toolUses: 5, turnCount: 3, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx(["View error", undefined]);
    await showAgentActions(ctx, record);
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].lifetimeUsage.input).toBe(500);
    expect(lastCall[5].turnCount).toBe(3);
  });

  it("passes stats when viewing snapshot", async () => {
    const record = {
      id: "test-id-789",
      display: { type: "general-purpose", description: "Snapshot agent" },
      lifecycle: { status: "running", startedAt: Date.now() - 60000 },
      execution: { session: { messages: [{ role: "user", content: "hello" }] } },
      result: "", error: "",
      stats: { lifetimeUsage: { input: 8000, output: 4000, cacheWrite: 1000, cost: 0.012 }, toolUses: 8, turnCount: 7, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx(["View snapshot", undefined]);
    await showAgentActions(ctx, record);
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].lifetimeUsage.input).toBe(8000);
    expect(lastCall[5].turnCount).toBe(7);
  });

  it("handles missing turnCount gracefully", async () => {
    const record = {
      id: "test-id-no-turns",
      display: { type: "general-purpose", description: "Running agent" },
      lifecycle: { status: "running", startedAt: Date.now() - 20000 },
      execution: { session: { messages: [{ role: "user", content: "hi" }] } },
      result: "", error: "",
      stats: { lifetimeUsage: { input: 100, output: 50, cacheWrite: 10, cost: 0.001 }, toolUses: 3, compactionCount: 0 },
    } as any;
    const ctx = createMockCtx(["View snapshot", undefined]);
    await showAgentActions(ctx, record);
    const lastCall = mockModules.resultViewerCalls[mockModules.resultViewerCalls.length - 1];
    expect(lastCall[5].turnCount).toBeUndefined();
    expect(lastCall[5].durationMs).toBeGreaterThan(0);
  });
});
