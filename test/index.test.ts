/**
 * index.test.ts — Tests for the extension entry point.
 *
 * Full integration testing is manual via pi TUI.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import { createMockExtensionAPI, fakeCtx, loadExtension, shellMock, type MockExtensionAPI } from "./fixtures";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ResolveModelOptions } from "../src/models/model-precedence.js";
import { registerAgentTool } from "../src/registration.js";
import { withSubagentParent } from "../src/agents/subagent-context.js";
import { asExtensionAPI } from "./pi-boundaries.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {},
  getAgentDir: () => "/home/test/.pi/agent",
}));

// The Agent tool_call listener reads pi's per-model thinking level when the
// call carries no explicit thinking; keep the settings read out of this file.
vi.mock("../src/pi-settings.js", () => ({
  getPiModelThinkingLevel: vi.fn(() => undefined),
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
  Text: class {
    _text: string;
    constructor(text: string, _w: number, _h: number) {
      this._text = text;
    }
    toString() {
      return this._text;
    }
  },
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

vi.mock("../src/agents/agent-types.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agents/agent-types.js")>("../src/agents/agent-types.js");
  return {
    resolveType: vi.fn((name: string) => ({ kind: "resolved", key: name })),
    getConfig: vi.fn(() => ({ displayName: "unknown" })),
    getAgentConfig: vi.fn(() => ({})),
    registerAgents: vi.fn(),
    getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
    // The real pure formatter: the schema test pins src's listing format, not a hand copy.
    formatAgentTypeDescriptions: actual.formatAgentTypeDescriptions,
    // Only read by registration when exposeDescriptions is on; overridden per-test.
    getVisibleAgentInfos: vi.fn(() => [
      { name: "general-purpose", description: "General-purpose agent for complex, multi-step tasks" },
      { name: "Explore", description: "Fast codebase exploration agent (read-only)" },
    ]),
  };
});

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

const { mockRenderAgentToolResult } = vi.hoisted(() => ({
  mockRenderAgentToolResult: vi.fn(),
}));

// registration.ts reads these exports while registering, so the fake carries every one of them.
vi.mock("../src/ui/renderer.js", () => ({
  renderAgentToolCall: vi.fn(() => "mocked-call"),
  renderAgentToolResult: mockRenderAgentToolResult,
  renderStatusLine: vi.fn(),
  renderSubagentMessage: vi.fn(),
  renderSubagentResult: vi.fn(
    () =>
      new (class {
        children: unknown[] = [];
        addChild(c: unknown) {
          this.children.push(c);
        }
      })(),
  ),
}));

// Mutable state shared between the shell mock and tests.
const { mutableStore } = vi.hoisted(() => ({
  mutableStore: {
    agent: {
      graceTurns: 6,
      forceBackground: false,
      showCost: false,
      agentToolStrictMode: false,
      exposeDescriptions: false,
      showCompletionCards: true,
    },
    modelFor: () => "anthropic/claude-sonnet-4-6",
  },
}));

vi.mock("../src/shell.js", () => shellMock({ store: mutableStore }));
/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function findTool(api: MockExtensionAPI, name: string) {
  return api.tools.find((t) => t.name === name);
}

/**
 * Emitted-JSON view of a TypeBox 1.x schema. 1.x declares concrete fields
 * (type, anyOf, additionalProperties) only on specific schema interfaces,
 * while these tests assert the plain JSON data the extension hands to pi.
 */
interface SchemaJson {
  type?: unknown;
  description?: unknown;
  anyOf?: SchemaJson[];
  additionalProperties?: unknown;
}

/* ------------------------------------------------------------------ */
/*  Shared extension load                                             */
/* ------------------------------------------------------------------ */

let api: MockExtensionAPI;

beforeAll(async () => {
  api = createMockExtensionAPI();
  await loadExtension(api.api);
});

/* ------------------------------------------------------------------ */
/*  Agent tool schema — minimal (dot description)                     */
/* ------------------------------------------------------------------ */

describe("Agent tool schema — minimal", () => {
  const agentTool = () => findTool(api, "Agent");

  it("has a dot description (strict gateways require one)", () => {
    expect(agentTool()).toBeDefined();
    expect(agentTool()!.description).toBe(".");
  });

  it("has no promptSnippet", () => {
    expect(agentTool()!.promptSnippet).toBeUndefined();
  });

  it("has no promptGuidelines", () => {
    expect(agentTool()!.promptGuidelines).toBeUndefined();
  });

  it("exposes the public spawn options", () => {
    const props = agentTool()!.parameters.properties as Record<string, SchemaJson>;
    expect(Object.keys(props).sort()).toEqual(["agent", "description", "prompt", "run_in_background", "worktree_path"]);
    expect(props.worktree_path.type).toBe("string");
  });
});

/* ------------------------------------------------------------------ */
/*  Agent tool agent param — exposeDescriptions                       */
/* ------------------------------------------------------------------ */

describe("Agent tool agent param — exposeDescriptions", () => {
  /** Re-register into an isolated capture, as on the next session start. */
  const retoolWithDescriptions = () => {
    mutableStore.agent.exposeDescriptions = true;
    try {
      const fresh = createMockExtensionAPI();
      registerAgentTool(asExtensionAPI(fresh.api));
      return fresh.tools.filter((t) => t.name === "Agent").at(-1)!;
    } finally {
      mutableStore.agent.exposeDescriptions = false;
    }
  };

  it("changes the agent selector schema when full descriptions are enabled", () => {
    const getAgentDescription = (tool: MockExtensionAPI["tools"][number]) =>
      (tool.parameters.properties as Record<string, SchemaJson>).agent!.description;
    const defaultDescription = getAgentDescription(findTool(api, "Agent")!);
    const exposedDescription = getAgentDescription(retoolWithDescriptions());

    expect(typeof exposedDescription).toBe("string");
    expect(exposedDescription).not.toBe(defaultDescription);
  });
});

/* ------------------------------------------------------------------ */
/*  Message Renderer Registration                                     */
/* ------------------------------------------------------------------ */

describe("message renderer registration", () => {
  beforeEach(() => {
    mutableStore.agent.showCompletionCards = true;
  });

  it("registers renderers for agent messages and results", () => {
    expect(api.messageRenderers.map((r) => r.customType)).toEqual(["subagent-message", "subagent-result"]);
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
  it("registers Agent, StopAgent, MessageAgent, and AgentStatus tools", () => {
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["Agent", "StopAgent", "MessageAgent", "AgentStatus"]);
  });

  it("registers every tool with the dot description", () => {
    for (const toolName of ["Agent", "StopAgent", "MessageAgent", "AgentStatus"]) {
      expect(findTool(api, toolName)!.description).toBe(".");
    }
  });

  it("registers a result renderer on the tools that report one status line", () => {
    const withRenderResult = api.tools.filter((t) => t.renderResult).map((t) => t.name);
    expect(withRenderResult).toEqual(["Agent", "StopAgent", "MessageAgent"]);
  });

  it("registers MessageAgent with no prompt snippet or guidelines and exactly its two required params", () => {
    const tool = findTool(api, "MessageAgent")!;
    const props = tool.parameters.properties as Record<string, SchemaJson>;
    expect(Object.keys(props).sort()).toEqual(["agent_id", "message"]);
    expect(tool.parameters.required).toEqual(["agent_id", "message"]);
    expect(tool.promptSnippet).toBeUndefined();
    expect(tool.promptGuidelines).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Listener Guards                                                   */
/* ------------------------------------------------------------------ */

describe("tool_call listener — guards", () => {
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
  it("registers only the /agents command", () => {
    expect(api.commands.map((c) => c.name)).toEqual(["agents"]);
    expect(api.commands[0].description).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Event Listener Registration                                       */
/* ------------------------------------------------------------------ */

describe("event listener registration", () => {
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
/* ------------------------------------------------------------------ */
/*  Child extension registration                                       */
/* ------------------------------------------------------------------ */

describe("child extension registration", () => {
  it("scopes communication-only registration to the child load", async () => {
    const childApi = createMockExtensionAPI();
    const parent = { pi: asExtensionAPI(childApi.api), ctx: fakeCtx(), agentStatusLimit: 8 };
    await withSubagentParent(parent, () => loadExtension(childApi.api));

    const childTools = childApi.tools.map((tool) => tool.name);
    expect(childTools).toContain("MessageAgent");
    expect(childTools).toContain("AgentStatus");
    expect(childTools).not.toContain("Agent");
    expect(childTools).not.toContain("StopAgent");
    expect(findTool(childApi, "MessageAgent")!.parameters.required).toEqual(["message"]);
    expect(childApi.listeners.some((listener) => listener.event === "session_start")).toBe(false);

    const parentApi = createMockExtensionAPI();
    await loadExtension(parentApi.api);
    expect(parentApi.tools.map((tool) => tool.name)).toContain("Agent");
    expect(parentApi.listeners.some((listener) => listener.event === "session_start")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Constrained Sampling                                              */
/* ------------------------------------------------------------------ */

describe("constrained sampling — default OFF", () => {
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

  for (const toolName of ["StopAgent", "MessageAgent"]) {
    it(`${toolName} has constrainedSampling (always)`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect(tool!.constrainedSampling).toEqual({
        type: "json_schema",
        strict: "prefer",
      });
    });
  }

  for (const toolName of ["StopAgent", "MessageAgent", "AgentStatus"]) {
    it(`${toolName} schema has additionalProperties: false`, () => {
      const tool = findTool(api, toolName);
      expect(tool).toBeDefined();
      expect((tool!.parameters as SchemaJson).additionalProperties).toBe(false);
    });
  }

  it("AgentStatus does not have constrainedSampling", () => {
    const tool = findTool(api, "AgentStatus");
    expect(tool).toBeDefined();
    expect(tool!.constrainedSampling).toBeUndefined();
  });
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
    const props = tool!.parameters.properties as Record<string, SchemaJson>;
    for (const name of ["description", "agent", "run_in_background", "worktree_path"]) {
      // Real TypeBox emits { anyOf: [...] } for Type.Union (no `type` field).
      const anyOf = props[name]!.anyOf;
      expect(anyOf).toBeDefined();
      // Strict-mode JSON schema rejects null values unless the union
      // explicitly includes the null variant (Type.Null in registration.ts).
      expect(anyOf!.some((s) => s.type === "null")).toBe(true);
    }
  });

  it("Agent schema has additionalProperties: false when toggle is ON", () => {
    const tool = findTool(api, "Agent");
    expect((tool!.parameters as SchemaJson).additionalProperties).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Agent renderResult — uses context.isError, not result.isError      */
/* ------------------------------------------------------------------ */

describe("Agent renderResult — context.isError override", () => {
  beforeEach(() => {
    mockRenderAgentToolResult.mockReset();
  });

  it("passes context.isError true to renderAgentToolResult when result has no isError", () => {
    const tool = findTool(api, "Agent");
    expect(tool?.renderResult).toBeDefined();

    // Production data flow: result from pi has no isError field; isError lives in context
    const result = {
      content: [{ type: "text", text: "some output" }],
      details: { type: "builder" },
    };
    const context = { isError: true };

    tool!.renderResult!(result, { expanded: false }, {}, context);

    expect(mockRenderAgentToolResult).toHaveBeenCalledTimes(1);
    const passedResult = mockRenderAgentToolResult.mock.calls[0][0];
    expect(passedResult.isError).toBe(true);
  });

  it("passes context.isError false to renderAgentToolResult when result has no isError", () => {
    const tool = findTool(api, "Agent");

    const result = {
      content: [{ type: "text", text: "some output" }],
      details: { type: "builder" },
    };
    const context = { isError: false };

    tool!.renderResult!(result, { expanded: false }, {}, context);

    expect(mockRenderAgentToolResult).toHaveBeenCalledTimes(1);
    const passedResult = mockRenderAgentToolResult.mock.calls[0][0];
    expect(passedResult.isError).toBe(false);
  });

  it("defaults isError to false when context is missing", () => {
    const tool = findTool(api, "Agent");

    const result = {
      content: [{ type: "text", text: "success" }],
      details: { type: "builder" },
    };

    tool!.renderResult!(result, { expanded: false }, {});

    expect(mockRenderAgentToolResult).toHaveBeenCalledTimes(1);
    const passedResult = mockRenderAgentToolResult.mock.calls[0][0];
    expect(passedResult.isError).toBe(false);
  });
});
