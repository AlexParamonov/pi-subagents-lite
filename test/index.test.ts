/**
 * index.test.ts — Tests for the extension entry point.
 *
 * Tests focus on:
 *   - Tool schema shapes (stealth schemas with description: ".", no promptSnippet/promptGuidelines)
 *   - Listener guards (only mutates event.input.model for Agent tool)
 *   - Schema field exclusion (no model, inherit_context, schedule, isolation params)
 *
 * These tests mock ExtensionAPI and verify registration behavior.
 * Full integration testing is manual via pi TUI.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import {
  createMockExtensionAPI,
  hasParam,
  loadExtension,
  type MockExtensionAPI,
  typeBoxMock,
  piCodingAgentMock,
  agentDiscoveryMock,
  agentRunnerMock,
  defaultAgentsMock,
} from "./fixtures";

// Mock external dependencies before any imports
vi.mock("@sinclair/typebox", () => typeBoxMock());
vi.mock("@earendil-works/pi-coding-agent", () => piCodingAgentMock());

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Container: class {
    children: any[] = [];
    addChild(c: any) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
    invalidate() { /* noop */ }
    render(_width: number): string[] { return []; }
  },
  Input: class {
    onSubmit: (() => void) | null = null;
    focused = false;
    getValue() {
      return "";
    }
    handleInput(_k: string) {}
  },
  Spacer: class {},
  Text: class {},
  Markdown: class {
    text: string;
    constructor(text: string, _w: number, _h: number, _theme: any) {
      this.text = text;
    }
    render(_width: number) {
      return [this.text];
    }
  },
  truncateToWidth: (text: string) => text,
  fuzzyFilter: (items: any[], _query: string, _fn: any) => items,
  getKeybindings: () => ({
    matches: () => false,
  }),
}));

vi.mock("../src/model-selector.js", () => ({
  ModelSelectorDialog: class {},
}));

vi.mock("../src/model-precedence.js", () => ({
  resolveModel: vi.fn((opts: any) => opts?.parentModelId ?? ""),
}));

vi.mock("../src/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => name),
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
}));

vi.mock("../src/agent-discovery.js", () => agentDiscoveryMock());

vi.mock("../src/agent-runner.js", () => agentRunnerMock());

vi.mock("../src/default-agents.js", () => defaultAgentsMock());

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
  buildStatsParts: vi.fn(),
  formatMs: vi.fn(),
  getDisplayName: vi.fn(),
  SPINNER: [],
  ERROR_STATUSES: new Set(),
}));

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Find a tool by name from the mock API.
 */
function findTool(api: MockExtensionAPI, name: string) {
  return api.tools.find((t) => t.name === name);
}

/**
 * Verify stealth schema properties: description ".", no promptSnippet, no promptGuidelines.
 */
function expectStealthSchema(tool: any) {
  expect(tool.description).toBe(".");
  expect(tool.promptSnippet).toBeUndefined();
  expect(tool.promptGuidelines).toBeUndefined();
}

/* ------------------------------------------------------------------ */
/*  Agent tool schema — stealth                                       */
/* ------------------------------------------------------------------ */

describe("Agent tool schema — stealth", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  const agentTool = () => findTool(api, "Agent");

  it("has no description (stealth)", () => {
    expect(agentTool()).toBeDefined();
    expect(agentTool()!.description).toBeUndefined();
  });

  it("has no promptSnippet", () => {
    expect(agentTool()!.promptSnippet).toBeUndefined();
  });

  it("has no promptGuidelines", () => {
    expect(agentTool()!.promptGuidelines).toBeUndefined();
  });

  it("excludes model param", () => {
    expect(hasParam(agentTool()!.parameters, "model")).toBe(false);
  });

  it("excludes inherit_context param", () => {
    expect(hasParam(agentTool()!.parameters, "inherit_context")).toBe(false);
  });

  it("excludes schedule param", () => {
    expect(hasParam(agentTool()!.parameters, "schedule")).toBe(false);
  });

  it("excludes isolation param", () => {
    expect(hasParam(agentTool()!.parameters, "isolation")).toBe(false);
  });

  it("includes prompt param (no .description())", () => {
    expect(hasParam(agentTool()!.parameters, "prompt")).toBe(true);
    const promptSchema = agentTool()!.parameters?.properties?.prompt;
    expect(promptSchema?.description).toBeUndefined();
  });

  it("includes description param", () => {
    expect(hasParam(agentTool()!.parameters, "description")).toBe(true);
  });

  it("includes agent param", () => {
    expect(hasParam(agentTool()!.parameters, "agent")).toBe(true);
  });

  it("excludes max_turns from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "max_turns")).toBe(false);
  });

  it("includes run_in_background param (optional)", () => {
    expect(hasParam(agentTool()!.parameters, "run_in_background")).toBe(true);
  });

  it("includes worktree_path param (optional, no .description())", () => {
    expect(hasParam(agentTool()!.parameters, "worktree_path")).toBe(true);
    const wtSchema = agentTool()!.parameters?.properties?.worktree_path;
    expect(wtSchema?.description).toBeUndefined();
  });


  it("excludes isolated from schema (config-only, not LLM-controlled)", () => {
    expect(hasParam(agentTool()!.parameters, "isolated")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Tool Registration Count                                           */
/* ------------------------------------------------------------------ */

describe("tool registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("registers exactly 3 tools", () => {
    expect(api.tools).toHaveLength(3);
  });

  it("registers Agent, StopAgent, and AgentStatus tools", () => {
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["Agent", "StopAgent", "AgentStatus"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Listener Guards                                                   */
/* ------------------------------------------------------------------ */

describe("tool_call listener — guards", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  const toolCallHandler = () =>
    api.listeners.find((l) => l.event === "tool_call")?.handler;

  it("does not mutate event.input.model for non-Agent tools", async () => {
    expect(toolCallHandler()).toBeDefined();
    const event = {
      toolName: "bash",
      toolCallId: "call_123",
      input: { command: "echo hello" },
    };
    const result = await toolCallHandler()!(event, {});

    expect(event.input.model).toBeUndefined();
    expect(result).toBeUndefined();
  });

  it("sets event.input.model for Agent tool calls", async () => {
    const ctx = {
      model: { provider: "test", id: "parent-model" },
      modelRegistry: {
        find: vi.fn((p: string, i: string) => ({ provider: p, id: i })),
        getAvailable: vi.fn(() => []),
      },
    };

    const event = {
      toolName: "Agent",
      toolCallId: "call_789",
      input: {
        prompt: "do something",
        description: "test",
        agent: "Explore",
      },
    };

    const result = await toolCallHandler()!(event, ctx);

    expect(event.input.model).toBeDefined();
    expect(typeof event.input.model).toBe("string");
    expect(result).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Command Registration                                              */
/* ------------------------------------------------------------------ */

describe("command registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("registers /agents command", () => {
    const agentsCmd = api.commands.find((c) => c.name === "agents");
    expect(agentsCmd).toBeDefined();
    expect(agentsCmd!.description).toBeDefined();
  });

  it("registers only /agents command", () => {
    const cmdNames = api.commands.map((c) => c.name).sort();
    expect(cmdNames).toEqual(["agents"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Event Listener Registration                                       */
/* ------------------------------------------------------------------ */

describe("event listener registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("registers tool_call listener", () => {
    expect(api.listeners.some((l) => l.event === "tool_call")).toBe(true);
  });

  it("registers session_start listener", () => {
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
  });

  it("registers session_shutdown listener", () => {
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(
      true,
    );
  });
});


