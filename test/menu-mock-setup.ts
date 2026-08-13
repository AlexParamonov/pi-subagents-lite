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
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../src/config/types.js";

// Create the mutable mock state via vi.hoisted so the vi.mock factories
// (which vitest hoists above the rest of the module) can reference it.
const hoisted = vi.hoisted(() => {
  const mockConfig = {
    agent: { default: null, forceBackground: false, outputTranscript: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  };

  const mockProjectConfig = {
    agent: {} as Record<string, any>,
    concurrency: {} as Record<string, any>,
  };

  const mockSessionOverrides = { default: null } as Record<string, any>;
  const mockSessionConcurrency = {} as Record<string, any>;
  const mockProjectTargetOffered = false;
  const mockStoreOverride = null as any;
  const mockSessionShowCost = undefined as boolean | undefined;

  const mockManager = {
    setConcurrency: vi.fn(),
    listAgents: vi.fn(() => []),
    getRecord: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn(),
    spawn: vi.fn(() => "agent-id-123"),
    clear: vi.fn(),
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
    mockProjectConfig,
    mockSessionOverrides,
    mockSessionConcurrency,
    mockProjectTargetOffered,
    mockStoreOverride,
    mockSessionShowCost,
    mockManager,
    mockSessionCtx,
    mockPiExec,
    mockPiInstance: { sendUserMessage: vi.fn(), exec: mockPiExec } as any,
  };
});

export const mockModules = {
  mockConfig: hoisted.mockConfig,
  mockProjectConfig: hoisted.mockProjectConfig,
  mockSessionOverrides: hoisted.mockSessionOverrides,
  mockSessionConcurrency: hoisted.mockSessionConcurrency,
  mockProjectTargetOffered: hoisted.mockProjectTargetOffered,
  mockStoreOverride: hoisted.mockStoreOverride,
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
    agent: { default: null, forceBackground: false, outputTranscript: false } as Record<string, any>,
    concurrency: { default: 4 } as Record<string, any>,
  };
  mockModules.mockProjectConfig = {
    agent: {} as Record<string, any>,
    concurrency: {} as Record<string, any>,
  };
  mockModules.mockSessionOverrides = { default: null } as Record<string, any>;
  mockModules.mockSessionConcurrency = {} as Record<string, any>;
  mockModules.mockProjectTargetOffered = false;
  mockModules.mockStoreOverride = null;
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockManager.setConcurrency.mockReset();
  mockModules.mockManager.listAgents.mockReset();
  mockModules.mockManager.getRecord.mockReset();
  mockModules.mockManager.abort.mockReset();
  mockModules.mockManager.steer.mockReset();
  mockModules.mockManager.spawn.mockReset();
  mockModules.mockManager.clear.mockReset();
  mockModules.mockPiExec.mockReset();
  resetSelectDialogInstances();
}

// --- vi.mock() calls ---

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: vi.fn(() => ({ displayName: "unknown" })),
  getAgentConfig: vi.fn(),
  getAvailableTypes: vi.fn(() => ["general-purpose", "Explore"]),
  getAllTypes: vi.fn(() => ["general-purpose", "Explore"]),
  resolveType: vi.fn((name: string) => ({ kind: "resolved", key: name })),
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
}));

vi.mock("../src/config/config-io.js", async () => {
  // Re-export the real constants so the shell mock below derives its defaults
  // from src (DEFAULT_AGENT etc.) instead of hand-copied literals.
  const actual = await vi.importActual<typeof import("../src/config/config-io.js")>("../src/config/config-io.js");
  return {
    ...actual,
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
  const { DEFAULT_AGENT, DEFAULT_CONCURRENCY } = await import("../src/config/config-io.js");
  const mockStore = {
    get projectTargetOffered() {
      return mockModules.mockProjectTargetOffered;
    },
    get agent() {
      // Effective agent: project layer over global layer (model keys only).
      const a = { ...mockModules.mockConfig.agent, ...mockModules.mockProjectConfig.agent };
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
        outputTranscript: a.outputTranscript !== false,
        outputThinkingBufferSize: a.outputThinkingBufferSize ?? 0,
        finishedRetentionMinutes: a.finishedRetentionMinutes ?? DEFAULT_AGENT.finishedRetentionMinutes,
        modelDisplayStyle: a.modelDisplayStyle === "id" ? "id" : "name",
        statusBarFormat: a.statusBarFormat === "compact" ? "compact" : "full",
        widgetShowModel: a.widgetShowModel !== false,
        widgetShowThinking: a.widgetShowThinking !== false,
        widgetNavHint: a.widgetNavHint !== false,
      };
    },
    get concurrency() {
      const globalConc = mockModules.mockConfig.concurrency ?? {};
      const projectConc = mockModules.mockProjectConfig.concurrency ?? {};
      const sessionConc = mockModules.mockSessionConcurrency;
      return {
        default: sessionConc.default ?? projectConc.default ?? globalConc.default ?? DEFAULT_CONCURRENCY.default,
        providers: {
          ...(globalConc.providers ?? {}),
          ...(projectConc.providers ?? {}),
          ...(sessionConc.providers ?? {}),
        },
        models: {
          ...(globalConc.models ?? {}),
          ...(projectConc.models ?? {}),
          ...(sessionConc.models ?? {}),
        },
      };
    },
    get projectConcurrency() {
      return mockModules.mockProjectConfig.concurrency ?? {};
    },
    get sessionConcurrency() {
      return mockModules.mockSessionConcurrency;
    },
    get sessionDefaultModel() {
      return mockModules.mockSessionOverrides.default ?? null;
    },
    sessionModelOverride(type: string) {
      return mockModules.mockSessionOverrides[type] ?? null;
    },
    hasGlobalModelKey(key: string) {
      return mockModules.mockConfig.agent[key] !== undefined;
    },
    hasProjectModelKey(key: string) {
      return mockModules.mockProjectConfig.agent[key] !== undefined;
    },
    get hasSessionShowCost() {
      return mockModules.mockSessionShowCost !== undefined;
    },
    agentConfigSnapshot() {
      return { ...mockModules.mockConfig.agent, ...mockModules.mockProjectConfig.agent };
    },
    modelFor(type: string, parentModelId: string, agentConfig?: any) {
      const effectiveAgent = { ...mockModules.mockConfig.agent, ...mockModules.mockProjectConfig.agent };
      const sessionOverride = mockModules.mockSessionOverrides[type];
      if (sessionOverride) return sessionOverride;
      const sessionDefault = mockModules.mockSessionOverrides.default;
      if (sessionDefault) return sessionDefault;
      const configOverride = effectiveAgent[type];
      if (configOverride) return configOverride;
      const configDefault = effectiveAgent.default;
      if (configDefault) return configDefault;
      if (agentConfig?.model) return agentConfig.model;
      return parentModelId;
    },
    mutate: {
      agent: {
        setDefaultModel(value: string | null, target: string = "global") {
          if (target === "session") mockModules.mockSessionOverrides.default = value;
          else if (target === "project") mockModules.mockProjectConfig.agent.default = value;
          else mockModules.mockConfig.agent.default = value;
        },
        setModelOverride(type: string, value: string | null, target: string = "global") {
          if (target === "session") mockModules.mockSessionOverrides[type] = value;
          else if (target === "project") mockModules.mockProjectConfig.agent[type] = value;
          else mockModules.mockConfig.agent[type] = value;
        },
        clearModelOverride(type: string, target: string = "global") {
          if (target === "session") {
            delete mockModules.mockSessionOverrides[type];
          } else if (target === "all") {
            delete mockModules.mockSessionOverrides[type];
            delete mockModules.mockConfig.agent[type];
            delete mockModules.mockProjectConfig.agent[type];
          } else if (target === "project") {
            delete mockModules.mockProjectConfig.agent[type];
          } else {
            delete mockModules.mockConfig.agent[type];
          }
        },
        clearAllModelOverrides(target: string = "global") {
          // Mirror the store: clear the model family + per-type keys, keep non-model settings.
          const kept = CONFIG_AGENT_NON_MODEL_KEYS.filter(
            (key) => !["default", "defaultThinking", "defaultMaxTurns"].includes(key),
          );
          const clearAgent = (agent: Record<string, any>) => {
            for (const key of Object.keys(agent)) {
              if (!kept.includes(key)) delete agent[key];
            }
          };
          if (target === "session") {
            mockModules.mockSessionOverrides = { default: null };
          } else if (target === "all") {
            mockModules.mockSessionOverrides = { default: null };
            clearAgent(mockModules.mockConfig.agent);
            clearAgent(mockModules.mockProjectConfig.agent);
          } else if (target === "project") {
            clearAgent(mockModules.mockProjectConfig.agent);
          } else {
            clearAgent(mockModules.mockConfig.agent);
          }
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
        setDefaultThinking(level: string | undefined, target: string = "global") {
          const agent = target === "project" ? mockModules.mockProjectConfig.agent : mockModules.mockConfig.agent;
          if (level === undefined) delete agent.defaultThinking;
          else agent.defaultThinking = level;
        },
        setDefaultMaxTurns(n: number | undefined, target: string = "global") {
          const agent = target === "project" ? mockModules.mockProjectConfig.agent : mockModules.mockConfig.agent;
          if (n === undefined) delete agent.defaultMaxTurns;
          else agent.defaultMaxTurns = n;
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
        setOutputThinkingBufferSize(size: number) {
          mockModules.mockConfig.agent.outputThinkingBufferSize = size;
        },
        setFinishedRetentionMinutes(n: number) {
          mockModules.mockConfig.agent.finishedRetentionMinutes = n;
        },
        setOutputTranscript(enabled: boolean) {
          mockModules.mockConfig.agent.outputTranscript = enabled;
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
        setDefault(n: number, target: string = "global") {
          if (target === "session") mockModules.mockSessionConcurrency.default = n;
          else if (target === "project") mockModules.mockProjectConfig.concurrency.default = n;
          else mockModules.mockConfig.concurrency.default = n;
        },
        setProvider(key: string, n: number, target: string = "global") {
          const section =
            target === "session"
              ? mockModules.mockSessionConcurrency
              : target === "project"
                ? mockModules.mockProjectConfig.concurrency
                : mockModules.mockConfig.concurrency;
          if (!section.providers) section.providers = {};
          section.providers[key] = n;
        },
        setModel(key: string, n: number, target: string = "global") {
          const section =
            target === "session"
              ? mockModules.mockSessionConcurrency
              : target === "project"
                ? mockModules.mockProjectConfig.concurrency
                : mockModules.mockConfig.concurrency;
          if (!section.models) section.models = {};
          section.models[key] = n;
        },
        removeProvider(key: string, target: string = "global") {
          if (target === "session") {
            if (mockModules.mockSessionConcurrency.providers) delete mockModules.mockSessionConcurrency.providers[key];
          } else if (target === "all") {
            if (mockModules.mockSessionConcurrency.providers) delete mockModules.mockSessionConcurrency.providers[key];
            if (mockModules.mockConfig.concurrency.providers) delete mockModules.mockConfig.concurrency.providers[key];
            if (mockModules.mockProjectConfig.concurrency.providers) {
              delete mockModules.mockProjectConfig.concurrency.providers[key];
            }
          } else if (target === "project") {
            if (mockModules.mockProjectConfig.concurrency.providers) {
              delete mockModules.mockProjectConfig.concurrency.providers[key];
            }
          } else if (mockModules.mockConfig.concurrency.providers) {
            delete mockModules.mockConfig.concurrency.providers[key];
          }
        },
        removeModel(key: string, target: string = "global") {
          if (target === "session") {
            if (mockModules.mockSessionConcurrency.models) delete mockModules.mockSessionConcurrency.models[key];
          } else if (target === "all") {
            if (mockModules.mockSessionConcurrency.models) delete mockModules.mockSessionConcurrency.models[key];
            if (mockModules.mockConfig.concurrency.models) delete mockModules.mockConfig.concurrency.models[key];
            if (mockModules.mockProjectConfig.concurrency.models) {
              delete mockModules.mockProjectConfig.concurrency.models[key];
            }
          } else if (target === "project") {
            if (mockModules.mockProjectConfig.concurrency.models) {
              delete mockModules.mockProjectConfig.concurrency.models[key];
            }
          } else if (mockModules.mockConfig.concurrency.models) {
            delete mockModules.mockConfig.concurrency.models[key];
          }
        },
        clearAll(target: string = "global") {
          if (target === "session") {
            mockModules.mockSessionConcurrency = {};
          } else if (target === "all") {
            mockModules.mockSessionConcurrency = {};
            mockModules.mockConfig.concurrency = {};
            mockModules.mockProjectConfig.concurrency = {};
          } else if (target === "project") {
            mockModules.mockProjectConfig.concurrency = {};
          } else {
            mockModules.mockConfig.concurrency = {};
          }
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
    getStore: () => mockModules.mockStoreOverride ?? mockStore,
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
          // Mirror the real coordinator's spread: the signal key exists only
          // when the intent carried one — menu-wizard spawns never do.
          ...(intent.signal !== undefined ? { signal: intent.signal } : {}),
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
