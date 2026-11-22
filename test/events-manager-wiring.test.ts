/**
 * events-manager-wiring.test.ts — the host wiring point in events.ts: which UI effect each manager
 * notification owns. The manager hands its callbacks to the host, and the host alone decides that a
 * start or a record write repaints the row, refreshes the widget, and never settles anything.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { AgentRecord } from "../src/types.js";

const invalidateAgentRow = vi.fn();
const ensureTimer = vi.fn();
const update = vi.fn();
const onAgentComplete = vi.fn();

/** The callbacks events.ts attaches, captured as the manager receives them. */
const wired: {
  start?: (record: AgentRecord) => void;
  complete?: (record: AgentRecord) => void;
  touched?: (record: AgentRecord) => void;
} = {};

vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class FakeAgentManager {
    constructor(_unused: unknown, _concurrency: unknown, onStart: (record: AgentRecord) => void) {
      wired.start = onStart;
    }
    setOnComplete(cb: (record: AgentRecord) => void): void {
      wired.complete = cb;
    }
    setOnRecordTouched(cb: (record: AgentRecord) => void): void {
      wired.touched = cb;
    }
  },
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class FakeSpawnCoordinator {
    onAgentComplete(record: AgentRecord): void {
      onAgentComplete(record);
    }
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class FakeAgentWidget {},
}));

vi.mock("../src/ui/renderer.js", () => ({
  invalidateAgentRow: (agentId: string) => invalidateAgentRow(agentId),
  cleanupInvalidations: vi.fn(),
}));

vi.mock("../src/shell.js", () => ({
  getManager: vi.fn(() => null),
  getWidget: vi.fn(() => ({ ensureTimer, update })),
  getStore: vi.fn(() => ({ agent: { disableDefaultAgents: false }, concurrency: 2, setDeps: vi.fn() })),
  getCoordinator: vi.fn(() => null),
  getPiInstance: vi.fn(() => null),
  getSessionCtx: vi.fn(() => ({})),
  setSessionCtx: vi.fn(),
  setManager: vi.fn(),
  setWidget: vi.fn(),
  setCoordinator: vi.fn(),
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  toolCallListener: vi.fn(),
}));

vi.mock("../src/registration.js", () => ({
  registerAgentTool: vi.fn(),
}));

const { ensureManagerAndWidget } = await import("../src/events.js");

const record = { id: "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c" } as AgentRecord;

describe("the session's manager wiring", () => {
  beforeEach(() => {
    invalidateAgentRow.mockClear();
    ensureTimer.mockClear();
    update.mockClear();
    onAgentComplete.mockClear();
    delete wired.start;
    delete wired.complete;
    delete wired.touched;
    ensureManagerAndWidget();
  });

  it("arms the widget's existing refresh when a record starts", () => {
    wired.start!(record);

    expect(invalidateAgentRow).toHaveBeenCalledWith(record.id);
    expect(ensureTimer, "a workflow-only session has no other caller to arm the interval").toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("repaints a record write through the same invalidation, with no settlement", () => {
    wired.touched!(record);

    expect(invalidateAgentRow).toHaveBeenCalledWith(record.id);
    expect(update).toHaveBeenCalledOnce();
    expect(onAgentComplete, "a record write is not a settlement and queues no Nudge").not.toHaveBeenCalled();
  });

  it("settles through the completion callback alone", () => {
    wired.complete!(record);

    expect(onAgentComplete).toHaveBeenCalledWith(record);
    expect(invalidateAgentRow).toHaveBeenCalledWith(record.id);
  });
});
