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

// DefaultResourceLoader must be a regular function (not arrow) to support `new`
function MockDefaultResourceLoader(this: any, opts: any) {
  this._opts = opts;
  this.reload = vi.fn().mockResolvedValue(undefined);
  _loaderOpts.push(opts);
}

const mockModules = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetAgentConfig: vi.fn(),
  mockGetToolNamesForType: vi.fn(),
  mockBuildAgentPrompt: vi.fn(),
  mockExtractText: vi.fn(),
  mockPreloadSkills: vi.fn().mockReturnValue([]),
  mockCreateAgentSession: vi.fn(),
  mockDefaultResourceLoader: MockDefaultResourceLoader,
  mockGetAgentDir: vi.fn(),
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => { _loaderOpts.length = 0; },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: mockModules.mockGetConfig,
  getAgentConfig: mockModules.mockGetAgentConfig,
  getToolNamesForType: mockModules.mockGetToolNamesForType,
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../src/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: mockModules.mockPreloadSkills,
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
    const activeToolsCall = session.setActiveToolsByName.mock.calls[0][0];
    expect(activeToolsCall).toContain("read");
    expect(activeToolsCall).toContain("bash");
    expect(activeToolsCall).toContain("edit");
    expect(activeToolsCall).toContain("grep");
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
