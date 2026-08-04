/**
 * agent-runner.test.ts — Tests for the agent execution engine.
 *
 * Tests focus on:
 *   - isolated parameter handling (overrides extensions/skills)
 *   - tool filtering (excluded tools, whitelist, blacklist)
 *   - No inheritContext or memory code paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.ts";

const fakePi = makeFakePi();

// --- Mock module-level dependencies ---

const _loaderOpts: any[] = [];
const _loaderGetExtensionsResult: any = { extensions: [], errors: [], runtime: {} };

// DefaultResourceLoader must be a regular function (not arrow) to support `new`
function MockDefaultResourceLoader(this: any, opts: any) {
  this._opts = opts;
  this.reload = vi.fn().mockResolvedValue(undefined);
  this.getExtensions = vi.fn().mockReturnValue(_loaderGetExtensionsResult);
  _loaderOpts.push(opts);
}

const mockModules = vi.hoisted(() => ({
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
  mockSettingsManagerCreate: vi.fn(() => ({})),
  mockIncludeContextFiles: true as boolean,
  mockSystemPromptMode: "replace" as string,
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => {
    _loaderOpts.length = 0;
  },
  setLoaderExtensions: (exts: any) => {
    _loaderGetExtensionsResult.extensions = exts;
  },
  clearLoaderExtensions: () => {
    _loaderGetExtensionsResult.extensions = [];
  },
  mockEnterSubagentSpawn: vi.fn(),
  mockExitSubagentSpawn: vi.fn(),
}));

vi.mock("../../src/agents/agent-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agents/agent-types.js")>();
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

// --- Import the module under test ---

import { runAgent, subscribeToSessionEvents } from "../../src/agents/agent-runner.js";

const defaultConfig = {
  displayName: "Agent",
  description: "Test agent",
  registeredTools: ["read", "bash", "edit"],
  extensions: true,
  skills: true,
};

const defaultAgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
  tools: undefined as true | string[] | false | undefined,
};

/**
 * Reset all mocks to their default state.
 */
function resetMocks() {
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

/**
 * Create a mock session with default stubs.
 */
function createMockSession() {
  const listeners: Array<(event: any) => void> = [];
  // Track active tools as real session state (a fake, not a call record) so
  // tests assert the observable outcome of tool filtering rather than the
  // internal call structure of setActiveToolsByName.
  let activeTools: string[] | undefined;
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    setActiveToolsByName: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
    getActiveTools: vi.fn(() => activeTools),
    bindExtensions: vi.fn(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    prompt: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    messages: [],
    _getListeners: () => listeners,
  };
}

/* ------------------------------------------------------------------ */
/*  runAgent — tool filtering (excluded tools)                         */
/* ------------------------------------------------------------------ */

describe("runAgent — tool filtering", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("filters out Agent from active tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "Agent", "grep"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // The session's active-tool list is the observable outcome of filtering.
    // tools: undefined → defaults to true → all tools visible (except Agent)
    const activeTools = session.getActiveTools()!;
    expect(activeTools).toEqual(expect.not.arrayContaining(["Agent"]));
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).toContain("grep");
  });

  it("tools: [read, bash, edit] — whitelist filters out other tools", async () => {
    const session = createMockSession();
    // Simulate: agent wants [read, bash, edit], but session also has write and grep active
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "write", "grep", "Agent"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash", "edit"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      tools: ["read", "bash", "edit"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // write and grep not in tools whitelist → rejected in the active-tool state
    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).not.toContain("write");
    expect(activeTools).not.toContain("grep");
    expect(activeTools).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — excludeTools (blacklist mode)                           */
/* ------------------------------------------------------------------ */

describe("runAgent — excludeTools (blacklist mode)", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("excludeTools: [write] — all tools except write", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "write", "grep", "Agent"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).toContain("grep");
    expect(activeTools).not.toContain("write");
    expect(activeTools).not.toContain("Agent");
  });

  it("excludeTools: [write, grep] — excludes multiple tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "write", "grep", "Agent"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write", "grep"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).not.toContain("write");
    expect(activeTools).not.toContain("grep");
    expect(activeTools).not.toContain("Agent");
  });

  it("excludeTools with no matching tools — no filtering needed", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // No filtering needed — write not in active tools, session state stays untouched
    expect(session.getActiveTools()).toBeUndefined();
  });

  it("excludeTools is ignored when tools whitelist is set", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "write", "grep"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"], // ignored because tools is set
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // tools whitelist wins — only read and bash visible in the active-tool state
    expect(session.getActiveTools()).toEqual(["read", "bash"]);
  });

  it("excludeTools with ext/* syntax — excludes all tools from extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract", "web_crawl"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("web_crawl");
    expect(activeTools).not.toContain("Agent");
  });

  it("excludeTools with mixed syntax — ext/* and bare names", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "write", "web_search", "web_extract"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      excludeTools: ["write", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).not.toContain("write");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — codex stream error retry wiring                         */
/* ------------------------------------------------------------------ */

describe("runAgent — codex stream error retry wiring", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("wraps the session's _isRetryableError classifier", async () => {
    const session: any = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    const originalClassifier = vi.fn().mockReturnValue(false);
    session._isRetryableError = originalClassifier;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // The wiring replaced the classifier with a wrapper that delegates to it.
    expect(session._isRetryableError).not.toBe(originalClassifier);
    // Transient Codex stream errors are now classified as retryable...
    expect(
      session._isRetryableError({ stopReason: "error", errorMessage: "stream disconnected before completion" }),
    ).toBe(true);
    expect(originalClassifier).toHaveBeenCalledWith({
      stopReason: "error",
      errorMessage: "stream disconnected before completion",
    });
    // ...while other errors still fall through to the original classifier.
    expect(session._isRetryableError({ stopReason: "error", errorMessage: "rate limited" })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  subscribeToSessionEvents — event forwarding                        */
/* ------------------------------------------------------------------ */

describe("subscribeToSessionEvents — event forwarding", () => {
  it("extracts u.cost?.total from assistant message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire assistant message_end with cost data on event.message.usage
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: 2.5 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 2.5,
    });

    unsub();
  });

  it("defaults cost to 0 when message.usage has no cost field", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire message_end with message.usage but no cost
    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10 },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 0,
    });

    unsub();
  });

  it("defaults cost to 0 when cost.total is null", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cost: { total: null } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 0,
      cost: 0,
    });

    unsub();
  });

  it("extracts nonzero cacheRead from usage", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Hello",
        usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 200, cost: { total: 1.5 } },
      },
    });

    expect(onAssistantUsage).toHaveBeenCalledWith({
      input: 100,
      output: 50,
      cacheWrite: 10,
      cacheRead: 200,
      cost: 1.5,
    });

    unsub();
  });

  it("does not fire onAssistantUsage for user message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire user message_end (should be ignored)
    listeners[0]({
      type: "message_end",
      message: {
        role: "user",
        content: "Hello",
        usage: { input: 0, output: 0, cacheWrite: 0, cost: { total: 100 } },
      },
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage for other event types", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire non-message_end event
    listeners[0]({
      type: "turn_end",
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage when usage is missing", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    // Fire message_end without usage at all
    listeners[0]({
      type: "message_end",
      message: { role: "assistant", content: "Hello" },
      // no usage field
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("forwards toolCallId on tool activity events", () => {
    const onToolActivity = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onToolActivity });
    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} });
    expect(onToolActivity).toHaveBeenCalledWith({ type: "start", toolName: "bash", toolCallId: "call_1" });

    listeners[0]({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: {}, isError: false });
    expect(onToolActivity).toHaveBeenCalledWith({ type: "end", toolName: "bash", toolCallId: "call_1" });

    unsub();
  });

  it("returns a noop unsubscribe when no callbacks are provided", () => {
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, {});
    // The noop early-return must not touch the session at all
    expect(session.subscribe).not.toHaveBeenCalled();
    expect(typeof unsub).toBe("function");
  });
  it("forwards compaction_end events to onCompaction", () => {
    const onCompaction = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onCompaction });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
      result: { tokensBefore: 150000 },
    });
    expect(onCompaction).toHaveBeenCalledWith({ reason: "threshold", tokensBefore: 150000 });

    // Aborted compactions (and missing results) must not fire the callback.
    listeners[0]({ type: "compaction_end", aborted: true, reason: "threshold", result: undefined });
    expect(onCompaction).toHaveBeenCalledTimes(1);

    unsub();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — extension name-based filtering                          */
/* ------------------------------------------------------------------ */

describe("runAgent — extension name-based filtering", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("passes extensionsOverride that filters to listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "glob"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    // Don't pre-set loader extensions — the override should filter them
    mockModules.clearLoaderExtensions();

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts", tools: new Map([["glob", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("extensionsOverride extracts extension name from ext/tool syntax", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily/web_search"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // The override should resolve "tavily/web_search" → "tavily" for extension loading
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("extensionsOverride filters hook-only extensions not in the list", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    // confirm-edits not in list → filtered out by override
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("no extensionsOverride when extensions=true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });

  it("no extensionsOverride when extensions=false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.extensionsOverride).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — excludeExtensions (blacklist mode)                      */
/* ------------------------------------------------------------------ */

describe("runAgent — excludeExtensions (blacklist mode)", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("excludeExtensions filters out listed extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["quality-monitor"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(typeof loaderCall.extensionsOverride).toBe("function");

    // Verify the override filters correctly
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("excludeExtensions filters multiple extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["quality-monitor", "confirm-edits"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("excludeExtensions ignored when extensions whitelist is set", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      excludeExtensions: ["quality-monitor"], // ignored
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const loaderCall = mockModules.getLoaderOpts();
    // extensions whitelist wins — override should filter to only tavily
    const override = loaderCall.extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });
});

/* ------------------------------------------------------------------ */
/*  tools field — extension tool names and ext/all syntax              */
/* ------------------------------------------------------------------ */

describe("tools field — extension tool names and ext/all syntax", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("tools: [read, web_search] allows extension tool by name", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "web_search"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "web_search"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    // web_extract not in tools list -> filtered out
    expect(activeTools).not.toContain("web_extract");
    // bash not in tools list -> filtered out
    expect(activeTools).not.toContain("bash");
    expect(activeTools).not.toContain("Agent");
  });

  it("ext/all syntax: tavily/* expands to all tavily tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract", "web_crawl"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).toContain("web_crawl");
    expect(activeTools).not.toContain("bash");
  });

  it("seeds createAgentSession tools allowlist with expanded extension tools", async () => {
    // Regression: pi treats createAgentSession({ tools }) as a registry gate.
    // A builtins-only allowlist silently drops every extension tool, so the
    // agent never sees web_search/web_extract/web_crawl even though the
    // extension is loaded. The allowlist must contain the concrete names.
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract", "web_crawl"]);
    // Capture the session-factory config so the allowlist (the registry gate)
    // is asserted on the captured value, not on mock call indexing.
    let sessionOpts: any;
    mockModules.mockCreateAgentSession.mockImplementation((opts: any) => {
      sessionOpts = opts;
      return Promise.resolve({ session, extensionsResult: {} });
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // sessionOpts was captured when createAgentSession was invoked above.
    // Whitelist semantics: only "read" + the expanded tavily tools register.
    // bash/edit are NOT in the whitelist, so they must not leak into the gate.
    expect(sessionOpts.tools).toEqual(expect.arrayContaining(["read", "web_search", "web_extract", "web_crawl"]));
    expect(sessionOpts.tools).not.toContain("bash");
    expect(sessionOpts.tools).not.toContain("edit");
    expect(sessionOpts.tools).not.toContain("tavily/*");
    expect(sessionOpts.tools).not.toContain("Agent");
  });

  it("warning: tool name not found in any loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "foobar"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "foobar"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tool "foobar" not found in any loaded extension'));

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("foobar");
    expect(activeTools).not.toContain("web_search");
  });

  it("warning: extension loaded but none of its tools in tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read", "bash"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read", "bash"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
  });

  it("warning: ext/all references non-loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["exa"],
      tools: ["read", "tavily/*"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["exa"],
      tools: ["read", "tavily/*"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/exa/index.ts",
        tools: new Map([["exa_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is not loaded, "tavily/*" will have no effect'),
    );

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("web_search");
  });

  it("tools: true allows all tools (no filtering)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "glob"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      tools: true,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      tools: true,
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // tools: true -> no filtering (except excluded tools), session state untouched
    expect(session.getActiveTools()).toBeUndefined();
  });

  it("tools: false hides all tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      tools: false,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      tools: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session.getActiveTools()).toEqual([]);
  });

  it("ext/all combined with named extension tool", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read",
      "bash",
      "edit",
      "web_search",
      "web_extract",
      "web_crawl",
      "exa_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily", "exa"],
      tools: ["read", "tavily/*", "exa_search"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily", "exa"],
      tools: ["read", "tavily/*", "exa_search"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
          ["web_crawl", {}],
        ]),
      },
      {
        path: "/home/test/.pi/agent/extensions/exa/index.ts",
        tools: new Map([["exa_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).toContain("web_crawl");
    expect(activeTools).toContain("exa_search");
    expect(activeTools).not.toContain("bash");
  });

  it("tools field overrides extensions for visibility", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    // extensions: [tavily] loads tavily, but tools: [read] hides its tools
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: ["read"],
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: ["read"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("bash");

    // Also warns that tavily is loaded but none of its tools are in tools
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('extension "tavily" is loaded but none of its tools are in tools'),
    );
  });

  it("no warning when tools is undefined (falls back to extensions-based filtering)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "web_search", "web_extract", "Agent"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      tools: undefined,
    });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
      tools: undefined,
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([
          ["web_search", {}],
          ["web_extract", {}],
        ]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // No warnings when tools is not set
    expect(warnSpy).not.toHaveBeenCalled();

    // Falls back to extensions-based filtering: all tavily tools allowed, Agent filtered out
    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — grace turns                                            */
/* ------------------------------------------------------------------ */

describe("runAgent — grace turns", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  /**
   * Helper: create a mock session with a pending prompt (doesn't resolve
   * until resolvePrompt() is called). This allows firing turn_end events
   * while the agent is still running.
   */
  function createPendingPromptSession() {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    return { session, resolvePrompt: () => resolvePrompt() };
  }

  it("uses default grace turns (6) when not specified in options", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, no graceTurns → default 6 → steer at turn 1, abort at turn 1+6=7
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
    });

    // Wait for the session to be created and prompt to be called
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 6 turns (within default grace period) — should not abort
    for (let i = 0; i < 6; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    // The steer should have been called at turn 1
    expect(session.steer).toHaveBeenCalled();
    // Should not abort within grace period
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 7th turn — should abort (maxTurns=1 + graceTurns=6 = 7)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("uses custom grace turns from options", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=3 → steer at turn 2, abort at turn 2+3=5
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 3,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 4 turns (within custom grace period) — should not abort
    for (let i = 0; i < 4; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    // The steer should have been called at turn 2
    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 5th turn — should abort (maxTurns=2 + graceTurns=3 = 5)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("graceTurns=0 allows one turn after steer then aborts", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=0 → steer at turn 2, abort at turn 3
    // (steer and abort can't fire on same turn due to if/else-if structure)
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 0,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 2 turns — steer fires at turn 2, no abort yet
    for (let i = 0; i < 2; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Fire 1 more turn — abort fires at turn 3 (maxTurns + graceTurns = 2)
    session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("agent completes gracefully within grace period", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, graceTurns=5 → steer at turn 1, abort at turn 6
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
      graceTurns: 5,
    });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 3 turns (within grace period) — should steer but not abort
    for (let i = 0; i < 3; i++) {
      session._getListeners().forEach((fn: any) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(false);
    expect(result.turnLimited).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — maxTokens: front matter → provider payload             */
/* ------------------------------------------------------------------ */

describe("runAgent — maxTokens: front matter to provider payload", () => {
  let session: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });

    session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    session.agent = { onPayload: undefined };
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  function makeMockModel(overrides = {}) {
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

  it("max_tokens in agent config ends up in the provider request payload", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "llama-3.1-8b",
      name: "Llama 3.1 8B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const rawPayload = {
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "do something" }],
      stream: true,
    };
    const finalPayload = await session.agent.onPayload(rawPayload, model);

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.model).toBe("llama-3.1-8b");
    expect(finalPayload.stream).toBe(true);
  });

  it("uses max_completion_tokens when the provider requires it", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 8192,
    });

    const model = makeMockModel({ compat: { maxTokensField: "max_completion_tokens" } });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload(
      { model: "some-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_completion_tokens).toBe(8192);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("no max_tokens injected when agent config omits it", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model: makeMockModel() });

    expect(session.agent.onPayload).toBeUndefined();
  });
  it("spawn-time maxTokens wins over agent config", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "llama-3.1-8b",
      name: "Llama 3.1 8B",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model, maxTokens: 2048 });

    const rawPayload = {
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "do something" }],
      stream: true,
    };
    const finalPayload = await session.agent.onPayload(rawPayload, model);

    // The spawn-time value (2048) wins over the agent config's 4096.
    expect(finalPayload.max_tokens).toBe(2048);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — context file gating (includeContextFiles)              */
/* ------------------------------------------------------------------ */

describe("runAgent — context file gating", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("loads context files when includeContextFiles is true", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockReturnValue([{ path: "AGENTS.md", content: "project instructions" }]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        contextFiles: [{ path: "AGENTS.md", content: "project instructions" }],
      }),
      expect.anything(),
    );
  });

  it("does NOT load context files when includeContextFiles is false", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = false;

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ contextFiles: expect.anything() }),
      expect.anything(),
    );
  });

  it("context file loading failure is non-fatal", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockLoadProjectContextFiles.mockImplementation(() => {
      throw new Error("permission denied");
    });

    // Should not throw
    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    // buildAgentPrompt still called (without contextFiles)
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalled();
  });
});
describe("runAgent — project trust threading", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  function mockSession() {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    return session;
  }

  it("creates the settings manager trusted by default (projectTrusted not set)", async () => {
    mockSession();
    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockSettingsManagerCreate).toHaveBeenCalledWith(
      "/home/test/project", // effectiveCwd
      "/home/test/.pi/agent",
      { projectTrusted: true },
    );
  });

  it("creates the settings manager untrusted for an untrusted cross-repo target", async () => {
    mockSession();
    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      cwd: "/repo-b",
      projectTrusted: false,
    });

    expect(mockModules.mockSettingsManagerCreate).toHaveBeenCalledWith("/repo-b", "/home/test/.pi/agent", {
      projectTrusted: false,
    });
  });

  it("threads the same settings manager into the resource loader and the session", async () => {
    const settingsManager = { isProjectTrusted: () => false };
    mockModules.mockSettingsManagerCreate.mockReturnValue(settingsManager as any);

    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    let sessionOpts: any;
    mockModules.mockCreateAgentSession.mockImplementation((opts: any) => {
      sessionOpts = opts;
      return Promise.resolve({ session, extensionsResult: {} });
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: false });

    // The loader opts carry the same manager instance
    expect(mockModules.getLoaderOpts().settingsManager).toBe(settingsManager);
    // And the session receives it via the settingsManager option
    expect(sessionOpts.settingsManager).toBe(settingsManager);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — system prompt modes (replace, inherit, custom)         */
/* ------------------------------------------------------------------ */

describe("runAgent — system prompt modes", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("uses replace mode by default — passes 'replace' to buildAgentPrompt", async () => {
    mockModules.mockSystemPromptMode = "replace";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "replace",
    );
  });

  it("calls ctx.getSystemPrompt() when mode is inherit", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt content");

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.getSystemPrompt).toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ parentSystemPrompt: "parent prompt content" }),
      "inherit",
    );
  });

  it("falls back gracefully when getSystemPrompt throws in inherit mode", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockImplementation(() => {
      throw new Error("no prompt");
    });
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Notified about the failure
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to get parent system prompt"),
      "warning",
    );
    // buildAgentPrompt still called — without parentSystemPrompt
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ parentSystemPrompt: expect.anything() }),
      "inherit",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — custom mode (file reading, fallback)                   */
/* ------------------------------------------------------------------ */

describe("runAgent — custom mode", () => {
  let fsReadFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    mockModules.mockSystemPromptMode = "custom";
    fsReadFileSyncSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    fsReadFileSyncSpy.mockRestore();
  });

  it("reads custom prompt file and passes content to buildAgentPrompt", async () => {
    fsReadFileSyncSpy.mockReturnValue("My custom system prompt");
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(fsReadFileSyncSpy).toHaveBeenCalledWith(expect.stringContaining("subagents-lite-prompt.md"), "utf-8");
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ customSystemPrompt: "My custom system prompt" }),
      "custom",
    );
  });

  it("falls back when custom file is missing (ENOENT)", async () => {
    const err = new Error("ENOENT") as any;
    err.code = "ENOENT";
    fsReadFileSyncSpy.mockImplementation(() => {
      throw err;
    });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Custom prompt file not found"), "warning");
    // buildAgentPrompt called without customSystemPrompt
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ customSystemPrompt: expect.anything() }),
      "custom",
    );
  });

  it("falls back when custom file is empty", async () => {
    fsReadFileSyncSpy.mockReturnValue("   "); // whitespace only
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Custom prompt file is empty"), "warning");
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ customSystemPrompt: expect.anything() }),
      "custom",
    );
  });

  it("falls back when custom file is unreadable (other error)", async () => {
    fsReadFileSyncSpy.mockImplementation(() => {
      throw new Error("permission denied");
    });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to read custom prompt file"), "warning");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — notify buffering (session tree corruption fix)          */
/* ------------------------------------------------------------------ */

describe("runAgent — notify buffering", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Create a session where prompt doesn't resolve until resolvePrompt() is called.
   * This lets us check notify call ordering relative to the turn loop.
   */
  function createPendingPromptSession() {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    return { session, resolvePrompt: () => resolvePrompt() };
  }

  it("does NOT call ctx.ui.notify before runTurnLoop completes", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools both set)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = {
      notify: vi.fn(),
    };

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // At this point setup is done but prompt is still pending — notify should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    // Now notify should have been called (warnings flushed after turn loop)
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("flushes buffered warnings after turn loop", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning (tools + excludeTools)
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    ctx.ui = { notify: vi.fn() };

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Should have exactly one warning (mutual exclusion)
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("both tools and exclude_tools set"), "warning");
  });

  it("uses console.warn fallback when ctx.ui.notify is unavailable", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — should fall back to console.warn

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("both tools and exclude_tools set"));
  });

  it("console.warn fallback also waits until after turn loop", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Trigger mutual exclusion warning
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      tools: ["read", "bash"],
      excludeTools: ["write"],
    });

    const ctx = fakeCtx();
    // No ctx.ui — console.warn fallback

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Setup done, prompt pending — console.warn should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(warnSpy).not.toHaveBeenCalled();

    // Complete the turn loop
    resolvePrompt();
    await promise;

    // Now console.warn should have been called
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("both tools and exclude_tools set"));
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — model error detection (final assistant stopReason)      */
/* ------------------------------------------------------------------ */

describe("runAgent — model error detection", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  /** Create a session pre-populated with a message history. */
  function sessionWithMessages(messages: any[]) {
    const session = createMockSession();
    session.messages = messages;
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    return session;
  }

  it("returns the provider error when the final assistant message has stopReason 'error'", async () => {
    sessionWithMessages([
      { role: "user", content: "task" },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "model failed to load into memory" },
    ]);

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBe("model failed to load into memory");
  });

  it("leaves modelError undefined when the final assistant message completed normally", async () => {
    sessionWithMessages([{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }]);

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBeUndefined();
  });

  it("does not fail the run when an earlier error turn was followed by a successful final turn", async () => {
    sessionWithMessages([
      { role: "assistant", content: [], stopReason: "error", errorMessage: "transient blip" },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBeUndefined();
  });

  it("leaves modelError undefined when the final assistant message was aborted", async () => {
    sessionWithMessages([{ role: "assistant", content: [], stopReason: "aborted" }]);

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBeUndefined();
  });

  it("leaves modelError undefined when the error message is empty", async () => {
    sessionWithMessages([{ role: "assistant", content: [], stopReason: "error" }]);

    const result = await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
    expect(result.modelError).toBeUndefined();
  });
});
