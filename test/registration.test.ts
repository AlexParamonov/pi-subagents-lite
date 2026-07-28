import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const catalog = new Map<string, { displayName: string }>([["reviewer", { displayName: "Reviewer" }]]);
  return {
    catalog,
    manager: undefined as unknown,
    widget: undefined as unknown,
    pi: undefined as unknown,
    registerAgents: vi.fn(),
    scanAndMerge: vi.fn(async () => new Map(catalog)),
    store: {
      concurrency: 1,
      agent: {
        disableDefaultAgents: false,
        outputThinkingBufferSize: 0,
        showCost: false,
      },
      reload: vi.fn(),
      setDeps: vi.fn(),
      notifyToolsExpanded: vi.fn(),
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));
vi.mock("@earendil-works/pi-tui", () => ({
  isKeyRelease: vi.fn(() => false),
  matchesKey: vi.fn(() => false),
}));
vi.mock("../src/agents/tool-execution.js", () => ({
  executeAgentTool: vi.fn(),
  executeStopAgentTool: vi.fn(),
  toolCallListener: vi.fn(),
}));
vi.mock("../src/agents/agent-status.js", () => ({ executeAgentStatusTool: vi.fn() }));
vi.mock("../src/agents/agent-types.js", () => ({
  getAvailableAgents: vi.fn(() => [...state.catalog.keys()]),
  registerAgents: state.registerAgents,
  scanAndMerge: state.scanAndMerge,
  setAgentScanDirs: vi.fn(),
}));
vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class {
    setOnComplete = vi.fn();
  },
}));
vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class {
    onAgentComplete = vi.fn();
  },
}));
vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
}));
vi.mock("../src/prompt/orchestration.js", () => ({
  getOrchestrationPromptUpdate: vi.fn(),
}));
vi.mock("../src/ui/renderer.js", () => ({
  renderAgentToolCall: vi.fn(),
  renderAgentToolResult: vi.fn(),
  renderSubagentResult: vi.fn(),
}));
vi.mock("../src/ui/menu/menus.js", () => ({ showAgentsMainMenu: vi.fn() }));
vi.mock("../src/shell.js", () => ({
  getCoordinator: () => undefined,
  getManager: () => state.manager,
  getPiInstance: () => state.pi,
  getStore: () => state.store,
  getWidget: () => state.widget,
  isInsideSubagentSpawn: () => false,
  setCoordinator: vi.fn(),
  setManager: (manager: unknown) => { state.manager = manager; },
  setPiInstance: (pi: unknown) => { state.pi = pi; },
  setSessionCtx: vi.fn(),
  setWidget: (widget: unknown) => { state.widget = widget; },
}));

import extension from "../src/index.ts";

function createApi() {
  const tools: Array<Record<string, any>> = [];
  const listeners: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
  return {
    tools,
    listeners,
    api: {
      registerTool: vi.fn((tool: Record<string, any>) => tools.push(tool)),
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => listeners.push({ event, handler })),
    },
  };
}

function agentTool(api: ReturnType<typeof createApi>): Record<string, any> {
  const tool = api.tools.find(({ name }) => name === "Agent");
  if (!tool) throw new Error("Agent tool was not registered");
  return tool;
}

function sessionContext() {
  return {
    cwd: "/workspace/project",
    hasUI: false,
    isProjectTrusted: () => false,
  };
}

beforeEach(() => {
  state.catalog.clear();
  state.catalog.set("reviewer", { displayName: "Reviewer" });
  state.manager = undefined;
  state.widget = undefined;
  state.pi = undefined;
  state.registerAgents.mockClear();
  state.scanAndMerge.mockClear();
  state.store.reload.mockClear();
  state.store.setDeps.mockClear();
  state.store.notifyToolsExpanded.mockClear();
});

describe("Agent tool registration", () => {
  it("registers the exact fixed stealth envelope", () => {
    const api = createApi();
    extension(api.api as any);
    const tool = agentTool(api);

    expect(tool).not.toHaveProperty("description");
    expect(tool).not.toHaveProperty("promptSnippet");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
      additionalProperties: false,
      type: "object",
      required: ["prompt", "agent"],
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        agent: { type: "string" },
        model: { type: "string" },
        thinking: {
          anyOf: [
            { const: "off", type: "string" },
            { const: "minimal", type: "string" },
            { const: "low", type: "string" },
            { const: "medium", type: "string" },
            { const: "high", type: "string" },
            { const: "xhigh", type: "string" },
            { const: "max", type: "string" },
          ],
        },
        run_in_background: { type: "boolean" },
        worktree_path: { type: "string" },
      },
    });
    expect(Object.keys(tool.parameters.properties)).toEqual([
      "prompt", "description", "agent", "model", "thinking", "run_in_background", "worktree_path",
    ]);
    expect(tool.parameters.required).toEqual(["prompt", "agent"]);
    expect(tool.parameters.properties.agent).not.toHaveProperty("enum");
    expect(tool.parameters.properties.agent).not.toHaveProperty("description");
  });

  it("does not re-register when session_start refreshes a changed agent catalog", async () => {
    const api = createApi();
    extension(api.api as any);
    const schemaBeforeLifecycle = JSON.stringify(agentTool(api).parameters);
    const sessionStart = api.listeners.find(({ event }) => event === "session_start");

    expect(sessionStart).toBeDefined();
    await sessionStart!.handler({}, sessionContext());
    state.catalog.clear();
    state.catalog.set("planner", { displayName: "Planner" });
    await sessionStart!.handler({}, sessionContext());

    expect(state.registerAgents).toHaveBeenCalledTimes(2);
    expect([...state.registerAgents.mock.calls[0][0].keys()]).toEqual(["reviewer"]);
    expect([...state.registerAgents.mock.calls[1][0].keys()]).toEqual(["planner"]);
    expect(api.api.registerTool).toHaveBeenCalledTimes(3);
    expect(api.tools).toHaveLength(3);
    expect(JSON.stringify(agentTool(api).parameters)).toBe(schemaBeforeLifecycle);
  });
});
