/**
 * menu-mock-setup.ts — Shared mock setup for menu tests.
 *
 * This file MUST be imported as the FIRST import in each menu test file.
 * It sets up vi.mock() calls for all menu dependencies.
 *
 * The mutable mock state is created through vi.hoisted() so the vi.mock()
 * factories below can reference it regardless of hoist order. Tests mutate
 * the shared mockModules object; a single resetConfig() restores every
 * field to its default in afterEach hooks, so a failing test can never leak
 * stale state into later tests.
 */

import { vi } from "vitest";

// Create the mutable mock state via vi.hoisted so the vi.mock factories
// (which vitest hoists above the rest of the module) can reference it.
const hoisted = vi.hoisted(() => {
  const mockConfig = {
    agent: { default: null, forceBackground: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  };

  const mockSessionOverrides = { default: null } as Record<string, any>;
  const mockSessionShowCost = undefined as boolean | undefined;

  const mockManager = {
    setConcurrency: vi.fn(),
    listAgents: vi.fn(() => []),
    getRecord: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(),
    spawn: vi.fn(() => "agent-id-123"),
  };

  const mockSessionCtx = {
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => {
        const known: Record<string, any> = {
          "openai/gpt-4o": { provider: "openai", id: "gpt-4o", reasoning: false },
          "anthropic/claude-sonnet-4-20250514": {
            provider: "anthropic",
            id: "claude-sonnet-4-20250514",
            reasoning: true,
          },
        };
        return known[`${provider}/${modelId}`];
      }),
      getAvailable: vi.fn(() => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { provider: "openai", id: "gpt-4o" },
      ]),
    },
    model: { provider: "test", id: "parent-model" },
    cwd: "/test",
  };

  const mockPiExec = vi.fn();

  return {
    mockConfig,
    mockSessionOverrides,
    mockSessionShowCost,
    mockManager,
    mockSessionCtx,
    mockPiExec,
    mockPiInstance: { sendUserMessage: vi.fn(), exec: mockPiExec } as any,
  };
});

export const mockModules = {
  mockConfig: hoisted.mockConfig,
  mockSessionOverrides: hoisted.mockSessionOverrides,
  mockSessionShowCost: hoisted.mockSessionShowCost,
  mockManager: hoisted.mockManager,
  mockSessionCtx: hoisted.mockSessionCtx,
  mockPiExec: hoisted.mockPiExec,
  mockPiInstance: hoisted.mockPiInstance,
};

/**
 * Restore every field of the shared mockModules state to its default.
 * Wire this into an afterEach hook in each menu test file so stale state
 * from a failed test never leaks into later tests.
 */
export function resetConfig(): void {
  mockModules.mockConfig = {
    agent: { default: null, forceBackground: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  };
  mockModules.mockSessionOverrides = { default: null } as Record<string, any>;
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockManager.setConcurrency.mockReset();
  mockModules.mockManager.listAgents.mockReset();
  mockModules.mockManager.getRecord.mockReset();
  mockModules.mockManager.abort.mockReset();
  mockModules.mockManager.steer.mockReset();
  mockModules.mockManager.spawn.mockReset();
  mockModules.mockPiExec.mockReset();
  resetSelectDialogInstances();
}

// --- vi.mock() calls ---

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => name),
  discoverNewAgents: vi.fn(async () => 0),
}));

// Capture SearchableSelectDialog instances for tests that need them
export let selectDialogInstances: Array<{ items: any[]; callbacks: any }> = [];
export function resetSelectDialogInstances() {
  selectDialogInstances = [];
}

vi.mock("../src/ui/searchable-select.js", () => ({
  SearchableSelectDialog: class MockSearchableSelectDialog {
    items: any[];
    callbacks: any;
    constructor(items: any[], _currentValue: any, callbacks: any, _theme: any) {
      this.items = items;
      this.callbacks = callbacks;
      selectDialogInstances.push(this as any);
    }
    handleInput(_data: string) {}
    invalidate() {}
  },
}));

vi.mock("../src/ui/format.js", () => ({
  getDisplayName: vi.fn((t: string) => t),
  truncateDesc: vi.fn((t: string) => t),
}));

vi.mock("../src/prompt/context.js", () => ({
  buildSnapshotMarkdown: vi.fn(),
}));

vi.mock("../src/config/config-io.js", async () => {
  // Re-export the real constants so the shell mock below derives its defaults
  // from src (DEFAULT_AGENT etc.) instead of hand-copied literals.
  const actual = await vi.importActual<typeof import("../src/config/config-io.js")>("../src/config/config-io.js");
  return {
    ...actual,
    saveConfigAtomic: vi.fn(),
    CUSTOM_PROMPT_PATH: "/home/test/.pi/agent/subagents-lite-prompt.md",
    DEFAULT_CONFIG: {
      agent: { default: null, forceBackground: false },
      concurrency: { default: 4 },
    },
  };
});

vi.mock("../src/agents/tool-execution.js", () => ({
  buildAgentDetails: vi.fn(() => ({})),
  successResult: vi.fn((text: string, details?: any) => ({ content: [{ type: "text", text }], details })),
  errorResult: vi.fn((text: string, details?: any) => ({ content: [{ type: "text", text }], isError: true, details })),
}));

vi.mock("../src/shell.js", async () => {
  // Derive the getter defaults from src's real config constants (via the mocked
  // config-io module above) so menu tests pin src's defaults, not a hand copy.
  const { DEFAULT_AGENT } = await import("../src/config/config-io.js");
  const mockStore = {
    get agent() {
      const a = mockModules.mockConfig.agent;
      const widgetMaxLines = a.widgetMaxLines ?? DEFAULT_AGENT.widgetMaxLines;
      return {
        defaultModel: a.default ?? null,
        forceBackground: a.forceBackground === true,
        showCost: mockModules.mockSessionShowCost ?? a.showCost === true,
        graceTurns: a.graceTurns ?? DEFAULT_AGENT.graceTurns,
        toolTimeoutMinutes: a.toolTimeoutMinutes ?? DEFAULT_AGENT.toolTimeoutMinutes,
        idleTimeoutMinutes: a.idleTimeoutMinutes ?? DEFAULT_AGENT.idleTimeoutMinutes,
        widgetMaxLines,
        widgetMaxLinesCompact: a.widgetMaxLinesCompact ?? Math.floor(widgetMaxLines / 2),
        widgetCompact: a.widgetCompact === true,
        showCompletionCards: a.showCompletionCards !== false,
        widgetShortcut: a.widgetShortcut === true,
        widgetDescLengthFull: a.widgetDescLengthFull ?? DEFAULT_AGENT.widgetDescLengthFull,
        widgetDescLengthCompact: a.widgetDescLengthCompact ?? DEFAULT_AGENT.widgetDescLengthCompact,
        systemPromptMode: a.systemPromptMode ?? DEFAULT_AGENT.systemPromptMode,
        includeContextFiles: a.includeContextFiles ?? DEFAULT_AGENT.includeContextFiles,
        defaultThinking: a.defaultThinking,
        defaultMaxTurns: a.defaultMaxTurns,
        loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
        loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
        showTools: a.showTools === true,
        showTurns: a.showTurns !== false,
        showInput: a.showInput !== false,
        showOutput: a.showOutput !== false,
        showContext: a.showContext !== false,
        showTime: a.showTime !== false,
        deltaInputTokens: a.deltaInputTokens === true,
        outputThinkingBufferSize: a.outputThinkingBufferSize ?? 0,
        finishedRetentionMinutes: a.finishedRetentionMinutes ?? DEFAULT_AGENT.finishedRetentionMinutes,
        finishedEvictTurns: a.finishedEvictTurns ?? DEFAULT_AGENT.finishedEvictTurns,
        modelDisplayStyle: a.modelDisplayStyle === "name" ? "name" : "id",
        statusBarFormat: a.statusBarFormat === "compact" ? "compact" : "full",
        widgetShowModel: a.widgetShowModel !== false,
        widgetShowThinking: a.widgetShowThinking !== false,
        widgetNavHint: a.widgetNavHint !== false,
      };
    },
    get concurrency() {
      return {
        default: mockModules.mockConfig.concurrency.default,
        providers: mockModules.mockConfig.concurrency.providers ?? {},
        models: mockModules.mockConfig.concurrency.models ?? {},
      };
    },
    get sessionDefaultModel() {
      return mockModules.mockSessionOverrides.default ?? null;
    },
    sessionModelOverride(type: string) {
      return mockModules.mockSessionOverrides[type] ?? null;
    },
    get hasSessionShowCost() {
      return mockModules.mockSessionShowCost !== undefined;
    },
    agentConfigSnapshot() {
      return mockModules.mockConfig.agent;
    },
    modelFor(type: string, parentModelId: string, agentConfig?: any) {
      const sessionOverride = mockModules.mockSessionOverrides[type];
      if (sessionOverride) return sessionOverride;
      const sessionDefault = mockModules.mockSessionOverrides.default;
      if (sessionDefault) return sessionDefault;
      const configOverride = mockModules.mockConfig.agent[type];
      if (configOverride) return configOverride;
      const configDefault = mockModules.mockConfig.agent.default;
      if (configDefault) return configDefault;
      if (agentConfig?.model) return agentConfig.model;
      return parentModelId;
    },
    mutate: {
      agent: {
        setDefaultModel(value: string | null) {
          mockModules.mockConfig.agent.default = value;
        },
        setModelOverride(type: string, value: string | null) {
          mockModules.mockConfig.agent[type] = value;
        },
        clearModelOverride(type: string) {
          delete mockModules.mockConfig.agent[type];
        },
        clearAllModelOverrides() {
          const preserved: Record<string, unknown> = {};
          for (const key of [
            "default",
            "forceBackground",
            "graceTurns",
            "showCost",
            "showTools",
            "showTurns",
            "showInput",
            "showOutput",
            "showContext",
            "showTime",
            "deltaInputTokens",
            "widgetMaxLines",
            "widgetMaxLinesCompact",
            "widgetDescLengthFull",
            "widgetDescLengthCompact",
            "widgetCompact",
            "showCompletionCards",
            "widgetShortcut",
            "systemPromptMode",
            "includeContextFiles",
            "defaultThinking",
            "defaultMaxTurns",
            "loadSkillsImplicitly",
            "loadExtensionsImplicitly",
            "modelDisplayStyle",
          ]) {
            const val = mockModules.mockConfig.agent[key];
            if (val != null || key === "default" || key === "forceBackground") {
              preserved[key] = val;
            }
          }
          mockModules.mockConfig.agent = preserved as any;
        },
        setForceBackground(enabled: boolean) {
          mockModules.mockConfig.agent.forceBackground = enabled;
        },
        setShowCost(enabled: boolean) {
          mockModules.mockConfig.agent.showCost = enabled;
        },
        setGraceTurns(n: number) {
          mockModules.mockConfig.agent.graceTurns = n;
        },
        setToolTimeoutMinutes(n: number) {
          mockModules.mockConfig.agent.toolTimeoutMinutes = n;
        },
        setIdleTimeoutMinutes(n: number) {
          mockModules.mockConfig.agent.idleTimeoutMinutes = n;
        },
        setSystemPromptMode(mode: string) {
          mockModules.mockConfig.agent.systemPromptMode = mode;
        },
        setIncludeContextFiles(enabled: boolean) {
          mockModules.mockConfig.agent.includeContextFiles = enabled;
        },
        setDefaultThinking(level: string | undefined) {
          mockModules.mockConfig.agent.defaultThinking = level;
        },
        setDefaultMaxTurns(n: number | undefined) {
          mockModules.mockConfig.agent.defaultMaxTurns = n;
        },
        setLoadSkillsImplicitly(value: boolean) {
          mockModules.mockConfig.agent.loadSkillsImplicitly = value;
        },
        setLoadExtensionsImplicitly(value: boolean) {
          mockModules.mockConfig.agent.loadExtensionsImplicitly = value;
        },
        setShowTools(enabled: boolean) {
          mockModules.mockConfig.agent.showTools = enabled;
        },
        setShowTurns(enabled: boolean) {
          mockModules.mockConfig.agent.showTurns = enabled;
        },
        setShowInput(enabled: boolean) {
          mockModules.mockConfig.agent.showInput = enabled;
        },
        setShowOutput(enabled: boolean) {
          mockModules.mockConfig.agent.showOutput = enabled;
        },
        setShowContext(enabled: boolean) {
          mockModules.mockConfig.agent.showContext = enabled;
        },
        setShowTime(enabled: boolean) {
          mockModules.mockConfig.agent.showTime = enabled;
        },
        setDeltaInputTokens(enabled: boolean) {
          mockModules.mockConfig.agent.deltaInputTokens = enabled;
        },
        setOutputThinkingBufferSize(size: number) {
          mockModules.mockConfig.agent.outputThinkingBufferSize = size;
        },
        setFinishedRetentionMinutes(n: number) {
          mockModules.mockConfig.agent.finishedRetentionMinutes = n;
        },
        setFinishedEvictTurns(n: number) {
          mockModules.mockConfig.agent.finishedEvictTurns = n;
        },
      },
      widget: {
        setCompact(enabled: boolean) {
          mockModules.mockConfig.agent.widgetCompact = enabled;
        },
        setShowCompletionCards(enabled: boolean) {
          mockModules.mockConfig.agent.showCompletionCards = enabled;
        },
        setMaxLines(lines: number) {
          mockModules.mockConfig.agent.widgetMaxLines = lines;
        },
        setMaxLinesCompact(lines: number) {
          mockModules.mockConfig.agent.widgetMaxLinesCompact = lines;
        },
        setDescLengthFull(n: number) {
          mockModules.mockConfig.agent.widgetDescLengthFull = n;
        },
        setDescLengthCompact(n: number) {
          mockModules.mockConfig.agent.widgetDescLengthCompact = n;
        },
        setShortcut(enabled: boolean) {
          mockModules.mockConfig.agent.widgetShortcut = enabled;
        },
        setShowModel(enabled: boolean) {
          mockModules.mockConfig.agent.widgetShowModel = enabled;
        },
        setShowThinking(enabled: boolean) {
          mockModules.mockConfig.agent.widgetShowThinking = enabled;
        },
        setNavHint(enabled: boolean) {
          mockModules.mockConfig.agent.widgetNavHint = enabled;
        },
        setModelDisplayStyle(style: string) {
          mockModules.mockConfig.agent.modelDisplayStyle = style;
        },
        setStatusBarFormat(format: string) {
          mockModules.mockConfig.agent.statusBarFormat = format;
        },
      },
      concurrency: {
        setDefault(n: number) {
          mockModules.mockConfig.concurrency.default = n;
        },
        setProvider(key: string, n: number) {
          if (!mockModules.mockConfig.concurrency.providers) mockModules.mockConfig.concurrency.providers = {};
          mockModules.mockConfig.concurrency.providers[key] = n;
        },
        setModel(key: string, n: number) {
          if (!mockModules.mockConfig.concurrency.models) mockModules.mockConfig.concurrency.models = {};
          mockModules.mockConfig.concurrency.models[key] = n;
        },
        removeProvider(key: string) {
          if (mockModules.mockConfig.concurrency.providers) delete mockModules.mockConfig.concurrency.providers[key];
        },
        removeModel(key: string) {
          if (mockModules.mockConfig.concurrency.models) delete mockModules.mockConfig.concurrency.models[key];
        },
        reset() {
          mockModules.mockConfig.concurrency = { default: 4 };
        },
      },
      session: {
        setOverride(type: string, model: string) {
          mockModules.mockSessionOverrides[type] = model;
        },
        clearOverride(type: string) {
          delete mockModules.mockSessionOverrides[type];
        },
        clearAll() {
          mockModules.mockSessionOverrides = { default: null };
        },
        setShowCost(enabled: boolean) {
          mockModules.mockSessionShowCost = enabled;
        },
        clearShowCost() {
          mockModules.mockSessionShowCost = undefined;
        },
      },
    },
  };

  return {
    getStore: () => mockStore,
    getManager: () => mockModules.mockManager,
    getWidget: vi.fn(() => undefined),
    getPiInstance: () => mockModules.mockPiInstance,
    getSessionCtx: () => mockModules.mockSessionCtx,
    getCoordinator: vi.fn(() => ({
      spawn: vi.fn(async (_pi: any, _ctx: any, intent: any) => {
        const id = mockModules.mockManager.spawn(_pi, _ctx, intent.type, intent.prompt, {
          description: intent.description,
          model: intent.model,
          maxTurns: intent.maxTurns,
          thinkingLevel: intent.thinkingLevel,
          isBackground: intent.runInBackground,
          modelKey: intent.modelKey,
          graceTurns: intent.graceTurns,
          worktreePath: intent.worktreePath,
          worktreeLabel: intent.worktreeLabel,
          invocation: intent.invocation,
        });
        const record = mockModules.mockManager.getRecord(id);
        if (!intent.runInBackground && record?.execution?.promise) {
          await record.execution.promise;
        }
        return { agentId: id, record };
      }),
      isBackground: vi.fn(() => false),
      scheduleNudge: vi.fn(),
      onAgentComplete: vi.fn(),
      dispose: vi.fn(),
    })),
  };
});
