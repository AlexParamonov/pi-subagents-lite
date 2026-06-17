/**
 * build-agent-details.test.ts — Tests for the buildAgentDetails helper.
 *
 * buildAgentDetails consolidates the stats/details Record<string, unknown>
 * construction that was previously duplicated across emitIndividualNudge,
 * executeSpawnForeground, and executeSpawnBackground.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRecord } from "../src/types.js";

// buildAgentDetails is a pure function. tool-execution.ts's runtime import
// chain (types, agent-types, usage, worktree-validator, utils, shell ->
// config-store) never reaches npm packages at runtime — no mocks needed.

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildAgentDetails", () => {
  let buildAgentDetails: typeof import("../src/tool-execution.js").buildAgentDetails;

  beforeEach(async () => {
    const mod = await import("../src/tool-execution.js");
    buildAgentDetails = mod.buildAgentDetails;
  });

  /** Helper to build a minimal AgentRecord for testing. */
  function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
    const base: AgentRecord = {
      id: "test-id-123",
      lifecycle: {
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
      },
      display: {
        type: "builder",
        description: "Build something",
      },
      execution: {},
      stats: {
        lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 },
        toolUses: 5,
        turnCount: 10,
        maxTurns: 25,
        compactionCount: 1,
      },
    };
    // Deep merge overrides into the base record
    return {
      ...base,
      ...overrides,
      lifecycle: { ...base.lifecycle, ...overrides.lifecycle },
      display: { ...base.display, ...overrides.display },
      execution: { ...base.execution, ...overrides.execution },
      stats: { ...base.stats, ...overrides.stats },
    } as AgentRecord;
  }

  // --- Baseline: no options (minimal) ---

  it("returns only type and description when no options given", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    // Should NOT include stats or status fields
    expect(details.turnCount).toBeUndefined();
    expect(details.status).toBeUndefined();
    expect(details.input).toBeUndefined();
    expect(details.output).toBeUndefined();
  });

  it("returns only two keys when no options given", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);
    expect(Object.keys(details)).toEqual(["type", "description"]);
  });

  // --- includeStats ---

  it("includes stats fields when includeStats is true", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    expect(details.turnCount).toBeDefined();
    expect(details.maxTurns).toBeDefined();
    expect(details.toolUses).toBe(5);
    expect(details.input).toBeDefined();
    expect(details.output).toBeDefined();
    expect(details.cost).toBe(0.01);
    expect(details.contextPercent).toBeDefined();
    expect(details.durationMs).toBeDefined();
    expect(details.compactions).toBe(1);
    expect(details.modelName).toBeUndefined(); // no invocation set
  });

  it("computes input and output from lifetimeUsage", () => {
    const record = makeRecord({
      stats: { lifetimeUsage: { input: 1000, output: 2000, cacheWrite: 500, cost: 0.05 }, toolUses: 5, compactionCount: 1, turnCount: 10, maxTurns: 25 },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(1000);
    expect(details.output).toBe(2000);
  });

  it("computes durationMs as completedAt - startedAt", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(4000);
  });

  it("sets durationMs to 0 when completedAt is undefined", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: undefined } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(0);
  });

  it("includes modelName from invocation", () => {
    const record = makeRecord({ display: { type: "builder", description: "Build something", invocation: { modelName: "haiku" } } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBe("haiku");
  });

  // --- includeStatus ---

  it("includes status and outputFile when includeStatus is true", () => {
    const record = makeRecord({ lifecycle: { status: "completed", startedAt: 1000, completedAt: 5000 }, display: { type: "builder", description: "Build something", outputFile: "/tmp/out.log" } });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.status).toBe("completed");
    expect(details.outputFile).toBe("/tmp/out.log");
    // Stats should NOT be included
    expect(details.turnCount).toBeUndefined();
    expect(details.tokens).toBeUndefined();
  });

  // --- Both options ---

  it("includes both stats and status when both options are true", () => {
    const record = makeRecord({ lifecycle: { status: "error", startedAt: 1000, completedAt: 5000 }, display: { type: "builder", description: "Build something", outputFile: "/tmp/err.log" } });
    const details = buildAgentDetails(record, { includeStats: true, includeStatus: true });

    expect(details.status).toBe("error");
    expect(details.outputFile).toBe("/tmp/err.log");
    expect(details.input).toBeDefined();
    expect(details.output).toBeDefined();
    expect(details.durationMs).toBeDefined();
    expect(details.toolUses).toBe(5);
  });

  // --- turnCount from record ---

  it("uses record.turnCount for details", () => {
    const record = makeRecord({ stats: { lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 }, toolUses: 5, turnCount: 42, maxTurns: 25, compactionCount: 1 } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.turnCount).toBe(42);
  });

  // --- Edge cases ---

  it("handles record with no invocation", () => {
    const record = makeRecord({ display: { type: "builder", description: "Build something" } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBeUndefined();
  });

  it("handles zero lifetimeUsage", () => {
    const record = makeRecord({
      stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 5, compactionCount: 1, turnCount: 10, maxTurns: 25 },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(0);
    expect(details.output).toBe(0);
    expect(details.cost).toBe(0);
  });

  // --- worktreePath in details ---

  it("includes worktreePath when record has it set", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", worktreePath: "/wt/feature" },
    });
    const details = buildAgentDetails(record);

    expect(details.worktreePath).toBe("/wt/feature");
  });

  it("does not include worktreePath when record has none", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record);

    expect(details.worktreePath).toBeUndefined();
  });
});
