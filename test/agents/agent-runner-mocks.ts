/**
 * agent-runner-mocks.ts — Shared mock setup for agent-runner tests.
 *
 * MUST be imported as the FIRST import in each agent-runner test file:
 * it registers the vi.mock() calls before any src module loads.
 */
import { vi, type Mock } from "vitest";
import { DefaultResourceLoader, type AgentSession, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";

/* ------------------------------------------------------------------ */
/*  Types shared across split test files                               */
/* ------------------------------------------------------------------ */

/** The loader's constructor options, as declared by pi (mirrors src/agent-runner). */
export type LoaderOpts = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** The extension surface the tool-map builder reads — mirrors src's inline projection. */
export interface TestExtension {
  path: string;
  tools: Map<string, unknown>;
}

/** The loader result shape tests reconstruct for extensionsOverride: only extensions is read. */
export interface TestLoadExtensionsResult {
  extensions: TestExtension[];
  errors: { path: string; error: string }[];
  runtime: unknown;
}

/** Assert a stubbed load result against the real LoadExtensionsResult at the override boundary. */
export function asLoadExtensionsResult(result: {
  extensions: TestExtension[];
  errors?: unknown[];
  runtime?: unknown;
}): LoadExtensionsResult {
  return result as LoadExtensionsResult;
}

/** The fake DefaultResourceLoader instance surface: captured opts + mock methods. */
interface MockLoaderInstance {
  _opts: LoaderOpts;
  reload: ReturnType<typeof vi.fn>;
  getExtensions: ReturnType<typeof vi.fn>;
}

/** The SettingsManager surface the spawn path reads from SettingsManager.create. */
export interface MockSettingsManager {
  getDefaultTools?: () => string[] | undefined;
  isProjectTrusted?: () => boolean;
}

// DefaultResourceLoader must be a regular function (not arrow) to support `new`
function MockDefaultResourceLoader(this: MockLoaderInstance, opts: LoaderOpts) {
  this._opts = opts;
  this.reload = vi.fn().mockResolvedValue(undefined);
  this.getExtensions = vi.fn().mockReturnValue(_loaderGetExtensionsResult);
  _loaderOpts.push(opts);
}

const _loaderOpts: LoaderOpts[] = [];
const _loaderGetExtensionsResult: TestLoadExtensionsResult = { extensions: [], errors: [], runtime: {} };

/* ------------------------------------------------------------------ */
/*  Hoisted mock state                                                */
/* ------------------------------------------------------------------ */

const hoisted = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockGetToolNamesForType: vi.fn(),
  mockBuildAgentPrompt: vi.fn(),
  mockExtractText: vi.fn(),
  mockPreloadSkills: vi.fn().mockReturnValue([]),
  mockLoadSkillMeta: vi.fn().mockReturnValue([]),
  mockCreateAgentSession: vi.fn(),
  mockDefaultResourceLoader: MockDefaultResourceLoader,
  mockGetAgentDir: vi.fn().mockReturnValue("/home/test/.pi/agent"),
  mockLoadProjectContextFiles: vi.fn().mockReturnValue([]),
  mockSettingsManagerCreate: vi.fn<() => MockSettingsManager>(() => ({ getDefaultTools: vi.fn(() => undefined) })),
  mockIncludeContextFiles: true as boolean,
  mockSystemPromptMode: "replace" as string,
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => {
    _loaderOpts.length = 0;
  },
  setLoaderExtensions: (exts: TestExtension[]) => {
    _loaderGetExtensionsResult.extensions = exts;
  },
  clearLoaderExtensions: () => {
    _loaderGetExtensionsResult.extensions = [];
  },
  mockEnterSubagentSpawn: vi.fn(),
  mockExitSubagentSpawn: vi.fn(),
}));

/** Mutable mock state accessible from test files. */
export const mockModules = {
  mockGetConfig: hoisted.mockGetConfig,
  mockGetAgentConfig: hoisted.mockGetAgentConfig,
  mockGetToolNamesForType: hoisted.mockGetToolNamesForType,
  mockBuildAgentPrompt: hoisted.mockBuildAgentPrompt,
  mockExtractText: hoisted.mockExtractText,
  mockPreloadSkills: hoisted.mockPreloadSkills,
  mockLoadSkillMeta: hoisted.mockLoadSkillMeta,
  mockCreateAgentSession: hoisted.mockCreateAgentSession,
  mockDefaultResourceLoader: hoisted.mockDefaultResourceLoader,
  mockGetAgentDir: hoisted.mockGetAgentDir,
  mockLoadProjectContextFiles: hoisted.mockLoadProjectContextFiles,
  mockSettingsManagerCreate: hoisted.mockSettingsManagerCreate,
  get mockIncludeContextFiles() {
    return hoisted.mockIncludeContextFiles;
  },
  set mockIncludeContextFiles(v: boolean) {
    hoisted.mockIncludeContextFiles = v;
  },
  get mockSystemPromptMode() {
    return hoisted.mockSystemPromptMode;
  },
  set mockSystemPromptMode(v: string) {
    hoisted.mockSystemPromptMode = v;
  },
  getLoaderOpts: hoisted.getLoaderOpts,
  clearLoaderOpts: hoisted.clearLoaderOpts,
  setLoaderExtensions: hoisted.setLoaderExtensions,
  clearLoaderExtensions: hoisted.clearLoaderExtensions,
  mockEnterSubagentSpawn: hoisted.mockEnterSubagentSpawn,
  mockExitSubagentSpawn: hoisted.mockExitSubagentSpawn,
};

/* ------------------------------------------------------------------ */
/*  vi.mock() registration — runs before any src import                */
/* ------------------------------------------------------------------ */

vi.mock("../../src/agents/agent-types.js", async () => {
  // Import the real module so resolveVisibleTools works correctly in integration tests
  const actual = await import("../../src/agents/agent-types.js");
  return {
    ...actual,
    getConfig: mockModules.mockGetConfig,
    getAgentConfig: mockModules.mockGetAgentConfig,
    getToolNamesForType: mockModules.mockGetToolNamesForType,
  };
});

vi.mock("../../src/prompt/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../../src/prompt/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../../src/prompt/skill-loader.js", () => ({
  preloadSkills: mockModules.mockPreloadSkills,
  loadSkillMeta: mockModules.mockLoadSkillMeta,
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({
    agent: {
      includeContextFiles: mockModules.mockIncludeContextFiles,
      systemPromptMode: mockModules.mockSystemPromptMode,
      graceTurns: 6,
      forceBackground: false,
      showCost: false,
      defaultModel: null,
    },
  }),
  enterSubagentSpawn: mockModules.mockEnterSubagentSpawn,
  exitSubagentSpawn: mockModules.mockExitSubagentSpawn,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockModules.mockCreateAgentSession,
  DefaultResourceLoader: mockModules.mockDefaultResourceLoader,
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { create: mockModules.mockSettingsManagerCreate },
  getAgentDir: mockModules.mockGetAgentDir,
  loadProjectContextFiles: mockModules.mockLoadProjectContextFiles,
}));

/* ------------------------------------------------------------------ */
/*  Shared default configs                                            */
/* ------------------------------------------------------------------ */

export const defaultConfig = {
  displayName: "Agent",
  description: "Test agent",
  registeredTools: ["read", "bash", "edit"],
  extensions: true,
  skills: true,
};

export const defaultAgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
  tools: undefined as true | string[] | false | undefined,
};

/* ------------------------------------------------------------------ */
/*  resetMocks — shared reset for each test                           */
/* ------------------------------------------------------------------ */

export function resetMocks() {
  vi.clearAllMocks();
  mockModules.clearLoaderOpts();
  mockModules.clearLoaderExtensions();
  mockModules.mockIncludeContextFiles = true;
  mockModules.mockSystemPromptMode = "replace";
  mockModules.mockLoadProjectContextFiles.mockReturnValue([]);

  mockModules.mockGetConfig.mockReturnValue({ ...defaultConfig });
  mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });
  mockModules.mockGetToolNamesForType.mockReturnValue(["read", "bash", "edit"]);
  mockModules.mockBuildAgentPrompt.mockReturnValue("system prompt");
  mockModules.mockExtractText.mockReturnValue("");
  mockModules.mockGetAgentDir.mockReturnValue("/home/test/.pi/agent");
  mockModules.mockPreloadSkills.mockReturnValue([]);
}

/* ------------------------------------------------------------------ */
/*  Mock session factory                                              */
/* ------------------------------------------------------------------ */

/** The fake AgentSession surface these tests drive. */
export interface MockSession {
  setSessionName: Mock<() => void>;
  getActiveToolNames: Mock<() => string[] | undefined>;
  setActiveToolsByName: Mock<(tools: string[]) => void>;
  getActiveTools: Mock<() => string[] | undefined>;
  bindExtensions: Mock<() => void>;
  subscribe: Mock<(listener: (event: unknown) => void) => () => void>;
  prompt: Mock<(text: string) => Promise<void>>;
  steer: Mock<(text: string) => Promise<void>>;
  abort: Mock<() => Promise<void>>;
  messages: AgentSession["messages"];
  agent: {
    onPayload?: (payload: unknown, model: Model<Api>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  };
  _getListeners: () => Array<(event: unknown) => void>;
  _isRetryableError?: (message: { stopReason?: string; errorMessage?: string }) => boolean;
}

export function createMockSession(): MockSession {
  const listeners: Array<(event: unknown) => void> = [];
  let activeTools: string[] | undefined;
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    setActiveToolsByName: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
    getActiveTools: vi.fn(() => activeTools),
    bindExtensions: vi.fn(),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    messages: [],
    agent: { onPayload: undefined },
    _getListeners: () => listeners,
  };
}

/* ------------------------------------------------------------------ */
/*  Message factories                                                 */
/* ------------------------------------------------------------------ */

export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

/* ------------------------------------------------------------------ */
/*  Model factory                                                     */
/* ------------------------------------------------------------------ */

export function makeMockModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "https://test.api/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}
