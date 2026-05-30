/**
 * agent-runner.test.ts — Tests for the agent execution engine.
 *
 * Tests focus on:
 *   - isolated parameter handling (overrides extensions/skills)
 *   - EXCLUDED_TOOL_NAMES constant and tool filtering
 *   - No inheritContext or memory code paths
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "./fixtures";

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
  mockGetAgentDir: vi.fn(),
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => { _loaderOpts.length = 0; },
  setLoaderExtensions: (exts: any) => { _loaderGetExtensionsResult.extensions = exts; },
  clearLoaderExtensions: () => { _loaderGetExtensionsResult.extensions = []; },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: mockModules.mockGetConfig,
  getAgentConfig: mockModules.mockGetAgentConfig,
  getToolNamesForType: mockModules.mockGetToolNamesForType,
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../src/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: mockModules.mockPreloadSkills,
  loadSkillMeta: mockModules.mockLoadSkillMeta,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockModules.mockCreateAgentSession,
  DefaultResourceLoader: mockModules.mockDefaultResourceLoader,
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { create: vi.fn() },
  getAgentDir: mockModules.mockGetAgentDir,
}));

// --- Import the module under test ---

import { runAgent, subscribeToSessionEvents, EXCLUDED_TOOL_NAMES } from "../src/agent-runner.js";

const defaultConfig = {
  displayName: "Agent",
  description: "Test agent",
  builtinToolNames: ["read", "bash", "edit"],
  extensions: true,
  skills: true,
};

const defaultAgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
};

/**
 * Reset all mocks to their default state.
 */
function resetMocks() {
  vi.clearAllMocks();
  mockModules.clearLoaderOpts();
  mockModules.clearLoaderExtensions();

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
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    setActiveToolsByName: vi.fn(),
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
/*  EXCLUDED_TOOL_NAMES                                                */
/* ------------------------------------------------------------------ */

describe("EXCLUDED_TOOL_NAMES", () => {
  it("contains Agent", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("Agent");
  });

  it("contains exactly 1 entry", () => {
    expect(EXCLUDED_TOOL_NAMES).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — isolated parameter                                      */
/* ------------------------------------------------------------------ */

describe("runAgent — isolated parameter", () => {
  const session = createMockSession();

  beforeEach(() => {
    resetMocks();
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    session.subscribe.mockReturnValue(vi.fn());
    session.prompt.mockResolvedValue(undefined);
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("isolated=true: sets extensions=false and skills=false", async () => {
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      skills: true,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      isolated: true,
    });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.noSkills).toBe(true);
  });

  it("isolated=false: uses config values for extensions/skills", async () => {
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      skills: true,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      isolated: false,
    });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    expect(loaderCall.noSkills).toBe(false);
  });

  it("isolated=true with false config: stays false", async () => {
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: false,
      skills: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      isolated: true,
    });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.noSkills).toBe(true);
  });

  it("isolated=false with false config: stays false", async () => {
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: false,
      skills: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      isolated: false,
    });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);
    expect(loaderCall.noSkills).toBe(true);
  });

  it("isolated undefined (not set): uses config values", async () => {
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
      skills: ["skill1"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      // isolated not set
    });

    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(false);
    // skills is string[] -> noSkills should be true (already preloaded into prompt)
    expect(loaderCall.noSkills).toBe(true);
  });
});

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
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit",
      "Agent",
      "grep",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // Verify that excluded tools are filtered out
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        "Agent",
      ]),
    );

    // Verify the remaining tools are correct
    // grep is a known built-in not in the whitelist [read, bash, edit] → should be filtered out
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("grep");
  });

  it("rejects known built-in tools not in whitelist when extensions=true", async () => {
    const session = createMockSession();
    // Simulate: agent wants [read, bash, edit], but session also has write and grep active
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "write", "grep", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });
    // getConfig returns builtinToolNames = [read, bash, edit]
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      builtinToolNames: ["read", "bash", "edit"],
      extensions: true,
    });
    mockModules.mockGetToolNamesForType.mockReturnValue(["read", "bash", "edit"]);

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
    });

    // write and grep are built-in but not in whitelist → should be rejected
    expect(session.setActiveToolsByName).toHaveBeenCalled();
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).not.toContain("write");
    expect(activeToolsCall).not.toContain("grep");
    expect(activeToolsCall).not.toContain("Agent");
  });

  it("isolated=true skips tool filtering block (extensions=false)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "Agent",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({
      session,
      extensionsResult: {},
    });

    await runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      isolated: true,
    });

    // Verify the loader options reflect isolation
    const loaderCall = mockModules.getLoaderOpts();
    expect(loaderCall.noExtensions).toBe(true);

    // With isolated=true/extensions=false, both filtering branches are skipped
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  subscribeToSessionEvents — cost extraction                         */
/* ------------------------------------------------------------------ */

describe("subscribeToSessionEvents — cost extraction", () => {
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
      cost: 2.5,
    });

    unsub();
  });

  it("defaults cost to 0 when message.usage has no cost field", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

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
      cost: 0,
    });

    unsub();
  });

  it("defaults cost to 0 when cost.total is null", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

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
      cost: 0,
    });

    unsub();
  });

  it("does not fire onAssistantUsage for user message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(session, { onAssistantUsage });

    const listeners = session._getListeners();

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

    // Fire message_end without usage at all
    listeners[0]({
      type: "message_end",
      message: { role: "assistant", content: "Hello" },
      // no usage field
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("returns a noop unsubscribe when no callbacks are provided", () => {
    const session = createMockSession();
    const unsub = subscribeToSessionEvents(session, {});
    expect(typeof unsub).toBe("function");
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
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob",
    ]);
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
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
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
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
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

  it("allows all tools from a named extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl", "glob",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    // Simulate loader.getExtensions() returning tavily with 3 tools and extra-tools with 1
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
        path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts",
        tools: new Map([["glob", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).toContain("web_crawl");
    // glob is from extra-tools which is not in extensions list → filtered out
    expect(activeTools).not.toContain("glob");
  });

  it("allows only specified tool when extension/tool syntax used", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily/web_search"],
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

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("web_crawl");
  });

  it("rejects unknown extension names (no substring fallback)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["nonexistent"],
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

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("bash");
    expect(activeTools).toContain("edit");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
  });

  it("allows tools from multiple named extensions", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob", "unknown_tool",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily", "extra-tools"],
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
      {
        path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts",
        tools: new Map([["glob", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("glob");
    // unknown_tool belongs to no extension → filtered out
    expect(activeTools).not.toContain("unknown_tool");
  });

  it("does not use old substring matching (no startsWith/includes)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["web"], // old substring would match web_search
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

    // "web" is not a real extension name → all extension tools should be rejected
    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
  });

  it("skips hook-only extensions (empty tools map) in the extension map", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["confirm-edits"],
    });
    // After extensionsOverride: only confirm-edits loaded (no tools)
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts",
        tools: new Map(), // hook-only: no tools
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // confirm-edits has no tools → extension name not in map → no tools from it
    // web_search belongs to tavily which was filtered out by extensionsOverride
    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).not.toContain("web_search");
  });

  it("extracts extension name from direct file in extensions dir", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "my_tool", "other_tool",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["direct-ext"],
    });
    // Direct file: extensions/direct-ext.ts (dirname is 'extensions')
    // other-ext has other_tool but is not in extensions list
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/direct-ext.ts",
        tools: new Map([["my_tool", {}]]),
      },
      {
        path: "/home/test/.pi/agent/extensions/other-ext/index.ts",
        tools: new Map([["other_tool", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("my_tool");
    expect(activeTools).not.toContain("other_tool");
  });

  it("extension filtering combined with disallowedTools denylist", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "web_extract", "web_crawl",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: ["tavily"],
      disallowedTools: ["web_crawl"],
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

    const activeTools = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    // web_crawl is allowed by extension but denied by disallowedTools
    expect(activeTools).not.toContain("web_crawl");
  });

  it("extensions=true allows all extension tools (no map filtering)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit", "web_search", "glob",
    ]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: true,
    });
    mockModules.setLoaderExtensions([
      {
        path: "/home/test/.pi/agent/extensions/tavily/index.ts",
        tools: new Map([["web_search", {}]]),
      },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // extensions=true → all extension tools allowed, no filtering applied
    // filterActiveTools returns null → setActiveToolsByName not called
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
