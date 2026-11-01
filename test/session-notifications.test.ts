import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentManager } from "../src/agents/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { createMockExtensionAPI, fakeCtx, makeAgentRecord, type MockExtensionAPI } from "./fixtures.js";
import { asExtensionAPI } from "./pi-boundaries.js";
import factory from "../src/index.js";
import { scanAndMerge } from "../src/agents/agent-types.js";
import { enterSubagentSpawn, exitSubagentSpawn, getCoordinator, setManager, setWidget } from "../src/shell.js";

// Keep factory, lifecycle handlers, shell and coordinator real. Stub resource
// discovery, UI and agent execution so completion is controlled by the test.
const { manager } = vi.hoisted(() => ({
  manager: {
    spawn: vi.fn<AgentManager["spawn"]>(),
    getRecord: vi.fn<AgentManager["getRecord"]>(),
    setOnComplete: vi.fn<AgentManager["setOnComplete"]>(),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/test/agent" }));
vi.mock("@earendil-works/pi-tui", () => ({ matchesKey: vi.fn(), isKeyRelease: vi.fn() }));
vi.mock("../src/config/config-store.js", () => ({
  ConfigStore: class {
    agent = { disableDefaultAgents: false };
    setProjectDir() {}
    reload() {}
    setDeps() {}
    notifyToolsExpanded() {}
  },
}));
vi.mock("../src/agents/agent-types.js", () => ({
  setAgentScanDirs: vi.fn(),
  scanAndMerge: vi.fn(async () => new Map()),
  registerAgents: vi.fn(),
}));
vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class {
    constructor() {
      return manager;
    }
  },
}));
vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {
    ensureTimer() {}
    update() {}
  },
}));
vi.mock("../src/ui/conversation-viewer.js", () => ({ ConversationViewer: class {} }));
vi.mock("../src/ui/renderer.js", () => ({ invalidateAgentRow: vi.fn(), cleanupInvalidations: vi.fn() }));
vi.mock("../src/registration.js", () => ({ registerTools: vi.fn(), registerAgentTool: vi.fn() }));
vi.mock("../src/agents/tool-execution.js", () => ({
  toolCallListener: vi.fn(),
  buildAgentDetails: (record: AgentRecord) => ({ id: record.id }),
  formatResultContent: (record: AgentRecord) => record.result,
}));

function sessionStart(api: MockExtensionAPI, ctx: ReturnType<typeof fakeCtx>) {
  const listener = api.listeners.find(({ event }) => event === "session_start");
  if (!listener) throw new Error("session_start handler missing");
  return listener.handler({ type: "session_start" }, ctx);
}

function unboundAPI() {
  const api = createMockExtensionAPI();
  api.api.sendMessage.mockImplementation(() => {
    throw new Error("Extension runtime not initialized");
  });
  return api;
}

interface DeliveryCase {
  idle: boolean;
  deliverAs: "followUp" | "steer";
}

function expectResult(api: MockExtensionAPI, deliverAs: "followUp" | "steer") {
  expect(api.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ customType: "subagent-result", content: expect.stringContaining("finished work") }),
    { deliverAs, triggerTurn: true },
  );
}

describe("session-bound completion notifications", () => {
  let record: AgentRecord;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setManager(null);
    setWidget(null);
    record = makeAgentRecord({ result: "finished work" });
    manager.spawn.mockReturnValue(record.id);
    manager.getRecord.mockImplementation((id: string) => (id === record.id ? record : undefined));
  });

  afterEach(() => {
    getCoordinator()?.dispose();
    vi.useRealTimers();
  });

  async function spawn(api: MockExtensionAPI, ctx: ReturnType<typeof fakeCtx>) {
    await getCoordinator()!.spawn(asExtensionAPI(api.api), ctx, {
      type: "builder",
      prompt: "do work",
      description: "Test agent",
      graceTurns: 6,
      runInBackground: true,
    });
  }

  async function complete() {
    record.lifecycle.status = "completed";
    manager.setOnComplete.mock.calls[0]![0](record);
    await vi.advanceTimersByTimeAsync(200);
  }

  it.each([
    { idle: true, deliverAs: "followUp" as const },
    { idle: false, deliverAs: "steer" as const },
  ])(
    "keeps the bound parent after an unbound factory reload ($deliverAs)",
    async ({ idle, deliverAs }: DeliveryCase) => {
      const parent = createMockExtensionAPI();
      const ctx = fakeCtx({ hasUI: false, isIdle: () => idle });
      factory(asExtensionAPI(parent.api));
      await sessionStart(parent, ctx);
      await spawn(parent, ctx);

      const unbound = unboundAPI();
      factory(asExtensionAPI(unbound.api));
      await complete();

      expectResult(parent, deliverAs);
      expect(unbound.api.sendMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it("hands notifications to the next session API before asynchronous discovery finishes", async () => {
    const parent = createMockExtensionAPI();
    const ctx = fakeCtx({ hasUI: false, isIdle: () => true });
    factory(asExtensionAPI(parent.api));
    await sessionStart(parent, ctx);
    await spawn(parent, ctx);

    const next = unboundAPI();
    factory(asExtensionAPI(next.api));
    // The runtime is bound by the SDK before it emits session_start.
    next.api.sendMessage.mockImplementation(() => {});
    let releaseScan!: (value: Awaited<ReturnType<typeof scanAndMerge>>) => void;
    vi.mocked(scanAndMerge).mockReturnValueOnce(new Promise((resolve) => (releaseScan = resolve)));
    const starting = sessionStart(next, fakeCtx({ hasUI: false, isIdle: () => false }));
    try {
      await complete();
      expectResult(next, "steer");
      expect(parent.api.sendMessage).not.toHaveBeenCalled();
    } finally {
      releaseScan(new Map());
      await starting;
    }
  });

  it("keeps child factories inert during a guarded spawn", async () => {
    const parent = createMockExtensionAPI();
    const ctx = fakeCtx({ hasUI: false });
    factory(asExtensionAPI(parent.api));
    await sessionStart(parent, ctx);
    await spawn(parent, ctx);

    const child = unboundAPI();
    enterSubagentSpawn();
    try {
      factory(asExtensionAPI(child.api));
    } finally {
      exitSubagentSpawn();
    }
    await complete();

    expect(child.listeners).toEqual([]);
    expectResult(parent, "followUp");
    expect(child.api.sendMessage).not.toHaveBeenCalled();
  });
});
