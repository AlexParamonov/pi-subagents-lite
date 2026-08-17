/**
 * index.test.ts — Tests for the extension entry point.
 *
 * Full integration testing is manual via pi TUI.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { createMockExtensionAPI, loadExtension, shellMock, type MockExtensionAPI } from "./fixtures";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ResolveModelOptions } from "../src/models/model-precedence.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
  getAgentDir: () => "/home/test/.pi/agent",
}));

vi.mock("@earendil-works/pi-tui", () => ({
  Box: class {},
  Container: class {
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
    invalidate() {
      /* noop */
    }
    render(_width: number): string[] {
      return [];
    }
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
    constructor(text: string, _w: number, _h: number, _theme: unknown) {
      this.text = text;
    }
    render(_width: number) {
      return [this.text];
    }
  },
  truncateToWidth: (text: string) => text,
  fuzzyFilter: (items: unknown[], _query: string, _fn: unknown) => items,
  getKeybindings: () => ({
    matches: () => false,
  }),
}));

vi.mock("../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class {},
}));

vi.mock("../src/models/model-precedence.js", () => ({
  resolveModel: vi.fn((opts: ResolveModelOptions) => opts?.parentModelId ?? ""),
}));

vi.mock("../src/agents/agent-types.js", () => ({
  resolveType: vi.fn((name: string) => ({ kind: "resolved", key: name })),
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(() => ({})),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue([]),
  mergeAgents: vi.fn().mockReturnValue(new Map()),
  AgentConfigFromMd: {},
}));

vi.mock("../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {},
  buildStatsParts: vi.fn(),
  formatMs: vi.fn(),
  getDisplayName: vi.fn(),
  SPINNER: [],
  ERROR_STATUSES: new Set(),
}));

// Mutable state shared between the shell mock and tests.
const { mutableStore, spawnGuard } = vi.hoisted(() => ({
  mutableStore: {
    agent: {
      graceTurns: 6,
      forceBackground: false,
      showCost: false,
      agentToolStrictMode: false,
      showCompletionCards: true,
    },
    modelFor: () => "anthropic/claude-sonnet-4-6",
  },
  spawnGuard: { depth: 0 },
}));

vi.mock("../src/shell.js", () =>
  shellMock({
    store: mutableStore,
    spawnGuard,
  }),
);
/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function findTool(api: MockExtensionAPI, name: string) {
  return api.tools.find((t) => t.name === name);
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

  it("exposes exactly the documented param set, each without a description", () => {
    const props = agentTool()!.parameters.properties;
    expect(Object.keys(props).sort()).toEqual(["agent", "description", "prompt", "run_in_background", "worktree_path"]);
    // Params carry no description: the model learns them from the tool name alone.
    expect(props.prompt.description).toBeUndefined();
    expect(props.worktree_path.description).toBeUndefined();
    expect(props.worktree_path.type).toBe("string");
  });
});

/* ------------------------------------------------------------------ */
/*  Message Renderer Registration                                     */
/* ------------------------------------------------------------------ */

describe("message renderer registration", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  beforeEach(() => {
    mutableStore.agent.showCompletionCards = true;
  });

  it("registers the subagent-result renderer", () => {
    expect(api.messageRenderers.map((r) => r.customType)).toContain("subagent-result");
  });

  it("uses the persisted setting regardless of renderer expanded state", () => {
    const renderer = api.messageRenderers.find((r) => r.customType === "subagent-result")!.renderer;
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };

    mutableStore.agent.showCompletionCards = false;
    expect(renderer({ content: "done" }, { expanded: false }, theme).children).toHaveLength(0);
    expect(renderer({ content: "done" }, { expanded: true }, theme).children).toHaveLength(0);
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

  const toolCallHandler = () => api.listeners.find((l) => l.event === "tool_call")?.handler;

  it("does not mutate event.input.model for non-Agent tools", async () => {
    expect(toolCallHandler()).toBeDefined();
    const event: CustomToolCallEvent = {
      type: "tool_call",
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

    const event: CustomToolCallEvent = {
      type: "tool_call",
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

  it("registers only the /agents command", () => {
    expect(api.commands.map((c) => c.name)).toEqual(["agents"]);
    expect(api.commands[0].description).toBeDefined();
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
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Subagent spawn guard (prevents shell clobbering)                  */
/* ------------------------------------------------------------------ */

describe("subagent spawn guard", () => {
  // Uses the mocked shell from vi.mock above; spawn guard state is shared via vi.hoisted.
  const shell = {
    isInsideSubagentSpawn: () => spawnGuard.depth > 0,
    enterSubagentSpawn: () => {
      spawnGuard.depth++;
    },
    exitSubagentSpawn: () => {
      spawnGuard.depth--;
    },
  };

  beforeEach(() => {
    // Defensive: start every test from a clean depth.
    while (spawnGuard.depth > 0) spawnGuard.depth--;
  });

  it("registers tools and listeners for the parent session", async () => {
    const api = createMockExtensionAPI();
    await loadExtension(api.api);

    expect(api.tools.length).toBeGreaterThan(0);
    expect(api.listeners.some((l) => l.event === "session_start")).toBe(true);
    expect(api.listeners.some((l) => l.event === "session_shutdown")).toBe(true);
  });

  it("stays inert when loaded inside a subagent spawn", async () => {
    spawnGuard.depth++;
    try {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);

      // No tools, no event handlers: the subagent must not clobber the parent shell
      // (setPiInstance/setSessionCtx happen via the factory + session_start handler).
      expect(api.tools).toHaveLength(0);
      expect(api.listeners).toHaveLength(0);
    } finally {
      spawnGuard.depth--;
    }
    expect(spawnGuard.depth).toBe(0);
  });

  it("is inert for nested spawns and recovers when depth returns to 0", async () => {
    spawnGuard.depth++;
    spawnGuard.depth++; // nested
    try {
      const api = createMockExtensionAPI();
      await loadExtension(api.api);
      expect(api.tools).toHaveLength(0);
    } finally {
      spawnGuard.depth--;
      spawnGuard.depth--;
    }

    // Parent load works again once no subagent is in flight
    const api = createMockExtensionAPI();
    await loadExtension(api.api);
    expect(api.tools.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Constrained Sampling                                              */
/* ------------------------------------------------------------------ */

describe("constrained sampling — default OFF", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  it("Agent has no constrainedSampling when toggle is OFF", () => {
    const tool = findTool(api, "Agent");
    expect(tool).toBeDefined();
    expect(tool!.constrainedSampling).toBeUndefined();
  });

  it("Agent optional fields stay out of required when toggle is OFF", () => {
    const tool = findTool(api, "Agent");
    // TypeBox encodes optionality as absence from the parent `required` array.
    expect(tool!.parameters.required).toEqual(["prompt"]);
  });

  // StopAgent and AgentStatus: always have constrainedSampling
  for (const toolName of ["StopAgent", "AgentStatus"]) {
    it(`${toolName} has constrainedSampling (always)`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect(tool!.constrainedSampling).toEqual({
        type: "json_schema",
        strict: "prefer",
      });
    });

    it(`${toolName} schema has additionalProperties: false`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect(tool!.parameters.additionalProperties).toBe(false);
    });
  }
});

describe("constrained sampling — toggle ON", () => {
  let api: MockExtensionAPI;

  beforeAll(async () => {
    // Flip the flag on the mutable store the shell mock returns.
    mutableStore.agent.agentToolStrictMode = true;
    vi.resetModules();

    api = createMockExtensionAPI();
    await loadExtension(api.api);
  });

  afterAll(() => {
    // Restore default for any subsequent tests.
    mutableStore.agent.agentToolStrictMode = false;
  });

  it("Agent has constrainedSampling when toggle is ON", () => {
    const tool = findTool(api, "Agent");
    expect(tool).toBeDefined();
    expect(tool!.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
  });

  it("Agent schema has all fields in required when toggle is ON", () => {
    const tool = findTool(api, "Agent");
    const required = tool!.parameters.required ?? [];
    expect(required).toContain("prompt");
    expect(required).toContain("description");
    expect(required).toContain("agent");
    expect(required).toContain("run_in_background");
    expect(required).toContain("worktree_path");
  });

  it("Agent optional fields use nullable anyOf pattern when toggle is ON", () => {
    const tool = findTool(api, "Agent");
    const props = tool!.parameters.properties;
    for (const name of ["description", "agent", "run_in_background", "worktree_path"]) {
      // Real TypeBox emits { anyOf: [...] } for Type.Union (no `type` field).
      expect(props[name].anyOf).toBeDefined();
      // Strict-mode JSON schema rejects null values unless the union
      // explicitly includes the null variant (Type.Null in registration.ts).
      expect(props[name].anyOf.some((s: { type?: unknown }) => s.type === "null")).toBe(true);
    }
  });

  it("Agent schema has additionalProperties: false when toggle is ON", () => {
    const tool = findTool(api, "Agent");
    expect(tool!.parameters.additionalProperties).toBe(false);
  });
});
