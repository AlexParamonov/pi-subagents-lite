/**
 * build-agent-details.test.ts — Tests for the buildAgentDetails helper.
 *
 * buildAgentDetails consolidates the stats/details Record<string, unknown>
 * construction shared by the spawn paths.
 */

import { describe, it, expect } from "vite-plus/test";
import type {
  AgentAccumulatedStats,
  AgentDisplayInfo,
  AgentExecutionState,
  AgentLifecycle,
  AgentRecord,
} from "../../src/types.js";
import { buildAgentDetails } from "../../src/agents/tool-execution.js";
import { asAgentSession } from "../pi-boundaries.js";

// buildAgentDetails is a pure function. Importing tool-execution.ts is safe
// without mocks because @earendil-works/pi-coding-agent has no top-level side
// effects (getAgentDir is a runtime value import, but the package is side-effect free).

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("buildAgentDetails", () => {
  /** Overrides may be partial: makeRecord deep-merges each sub-object into the base. */
  interface RecordOverrides extends Partial<Pick<AgentRecord, "id" | "result" | "error" | "workflow">> {
    lifecycle?: Partial<AgentLifecycle>;
    display?: Partial<AgentDisplayInfo>;
    execution?: Partial<AgentExecutionState>;
    stats?: Partial<AgentAccumulatedStats>;
  }
  function makeRecord(overrides: RecordOverrides = {}): AgentRecord {
    const base: AgentRecord = {
      id: "test-id-123",
      lifecycle: {
        status: "completed",
        startedAt: 1000,
        completedAt: 5000,
        started: true,
      },
      display: {
        type: "builder",
        description: "Build something",
      },
      execution: { settled: true, settlementCount: 1 },
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

  it("carries type, description and the reply preview, and no stats or status fields", () => {
    const record = makeRecord({ result: "Fixed the flaky fetch test.\n\nRetries are capped now." });
    const details = buildAgentDetails(record);

    expect(details.type).toBe("builder");
    expect(details.description).toBe("Build something");
    // The exact key set is the absence check for every stats and status field.
    expect(Object.keys(details)).toEqual(["type", "description", "replyPreview"]);
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
      stats: {
        lifetimeUsage: { input: 1000, output: 2000, cacheWrite: 500, cost: 0.05 },
        toolUses: 5,
        compactionCount: 1,
        turnCount: 10,
        maxTurns: 25,
      },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.input).toBe(1000);
    expect(details.output).toBe(2000);
  });

  it("computes durationMs as completedAt - startedAt", () => {
    const record = makeRecord();
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(4000);
  });

  it("sets durationMs to 0 when completedAt is undefined", () => {
    const record = makeRecord({ lifecycle: { completedAt: undefined } });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.durationMs).toBe(0);
  });

  it("includes modelName from invocation", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", invocation: { modelName: "haiku" } },
    });
    const details = buildAgentDetails(record, { includeStats: true });

    expect(details.modelName).toBe("haiku");
  });

  it("prefers session model name over invocation modelName", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", invocation: { modelName: "invocation-model" } },
      execution: { session: asAgentSession({ model: { name: "session-model" } }) },
    });
    const details = buildAgentDetails(record, { includeStats: true });
    expect(details.modelName).toBe("session-model");
  });

  it("falls back to invocation modelName when session has no model", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", invocation: { modelName: "fallback-model" } },
      execution: { session: asAgentSession({}) },
    });
    const details = buildAgentDetails(record, { includeStats: true });
    expect(details.modelName).toBe("fallback-model");
  });

  it("includes thinkingLevel from invocation", () => {
    const record = makeRecord({
      display: {
        type: "builder",
        description: "Build something",
        invocation: { modelName: "haiku", thinkingLevel: "medium" },
      },
    });
    const details = buildAgentDetails(record, { includeStats: true });
    expect(details.thinkingLevel).toBe("medium");
  });

  it("omits thinkingLevel when invocation has none", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", invocation: { modelName: "haiku" } },
    });
    const details = buildAgentDetails(record, { includeStats: true });
    expect(details.thinkingLevel).toBeUndefined();
  });

  // --- includeStatus ---

  it("includes status and outputFile when includeStatus is true", () => {
    const record = makeRecord({
      display: { type: "builder", description: "Build something", outputFile: "/tmp/out.log" },
    });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.status).toBe("completed");
    expect(details.outputFile).toBe("/tmp/out.log");
    // Stats should NOT be included
    expect(details.turnCount).toBeUndefined();
    expect(details.tokens).toBeUndefined();
  });

  it("includes the watchdog stop reason when the agent was watchdog-stopped", () => {
    const record = makeRecord({
      lifecycle: {
        status: "stopped",
        stoppedBy: "watchdog",
        stopDetail: { kind: "tool", toolName: "bash", elapsedMs: 45 * 60_000 },
      },
    });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.status).toBe("stopped");
    expect(details.stopReason).toMatch(/STOPPED BY WATCHDOG/);
    expect(details.stopReason).toContain("bash");
  });

  it("omits stopReason for user stops", () => {
    const record = makeRecord({
      lifecycle: { status: "stopped", stoppedBy: "user" },
    });
    const details = buildAgentDetails(record, { includeStatus: true });

    expect(details.stopReason).toBeUndefined();
  });

  // --- Both options ---

  it("includes both stats and status when both options are true", () => {
    const record = makeRecord({
      lifecycle: { status: "error" },
      display: { type: "builder", description: "Build something", outputFile: "/tmp/err.log" },
    });
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
    const record = makeRecord({
      stats: {
        lifetimeUsage: { input: 100, output: 200, cacheWrite: 50, cost: 0.01 },
        toolUses: 5,
        turnCount: 42,
        maxTurns: 25,
        compactionCount: 1,
      },
    });
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
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 5,
        compactionCount: 1,
        turnCount: 10,
        maxTurns: 25,
      },
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

  // --- displayName: a Workflow run's snapshot names the run itself ---

  it("names a Workflow run's snapshot by the workflow, not by the agent naming", () => {
    const record = makeRecord({
      display: { type: "audit", description: "audit the diff" },
      workflow: { name: "audit", endpoint: "lab", url: "http://127.0.0.1:8099", remoteId: "wf-1", progress: [] },
    });

    expect(buildAgentDetails(record, { includeStatus: true }).displayName).toBe("audit workflow");
  });

  // --- replyPreview: the collapsed result surfaces read this field, never the composed text ---

  it("carries the reply's opening line", () => {
    const record = makeRecord({
      result: "Vendor fetch fails on the first attempt.\n\nIt retries twice, then writes the log.",
    });

    expect(buildAgentDetails(record).replyPreview).toBe("Vendor fetch fails on the first attempt.");
  });

  it("carries the first text line of a reply that opens with blank lines", () => {
    const record = makeRecord({ result: "\n   \n  Fixed the flake.\n\nDone." });

    expect(buildAgentDetails(record).replyPreview).toBe("Fixed the flake.");
  });

  it.each(["", "   \n\t\n  "])("carries no preview for the blank reply %j", (result) => {
    expect(buildAgentDetails(makeRecord({ result })).replyPreview).toBeUndefined();
  });

  it("carries no preview when the record has no reply", () => {
    expect(buildAgentDetails(makeRecord({ result: undefined })).replyPreview).toBeUndefined();
  });

  it("carries no preview when only the appended error note would be readable", () => {
    const record = makeRecord({
      result: "",
      error: "model failed to load",
      lifecycle: { status: "error", startedAt: 1000, started: true },
    });

    expect(buildAgentDetails(record).replyPreview).toBeUndefined();
  });

  it.each(["Error: the fixture never ran.", "(nothing to do)", '  [Subagent "builder" a1b2c3d4 completed]'])(
    "carries the reply line even when it reads like framing (%s)",
    (result) => {
      expect(buildAgentDetails(makeRecord({ result })).replyPreview).toBe(result.trim());
    },
  );

  it.each([
    ["stopped", { stoppedBy: "user" }],
    ["aborted", {}],
    ["turn_limited", {}],
  ] as const)("carries the reply line and not the status note under the %s status", (status, lifecycle) => {
    const record = makeRecord({
      result: "Done.",
      lifecycle: { status, startedAt: 1000, completedAt: 2000, started: true, ...lifecycle },
    });

    expect(buildAgentDetails(record, { includeStats: true, includeStatus: true }).replyPreview).toBe("Done.");
  });

  it("holds one line, never reply text beyond it", () => {
    const record = makeRecord({ result: "Line one.\nLine two.\nLine three." });

    expect(buildAgentDetails(record).replyPreview).toBe("Line one.");
  });
});
