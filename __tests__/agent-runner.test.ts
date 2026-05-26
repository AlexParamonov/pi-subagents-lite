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
// Use vi.hoisted() because vi.mock factories are hoisted to top of file

const mockModules = vi.hoisted(() => {
  const loaderOpts: any[] = [];

  // DefaultResourceLoader must be a regular function (not arrow) to support `new`
  function MockDefaultResourceLoader(this: any, opts: any) {
    this._opts = opts;
    this.reload = vi.fn().mockResolvedValue(undefined);
    loaderOpts.push(opts);
  }

  return {
    mockGetConfig: vi.fn(),
    mockGetAgentConfig: vi.fn(),
    mockGetToolNamesForType: vi.fn(),
    mockBuildAgentPrompt: vi.fn(),
    mockExtractText: vi.fn(),
    mockPreloadSkills: vi.fn().mockReturnValue([]),
    mockCreateAgentSession: vi.fn(),
    mockDefaultResourceLoader: MockDefaultResourceLoader,
    mockGetAgentDir: vi.fn(),
    getLoaderOpts: () => loaderOpts[loaderOpts.length - 1] ?? null,
    clearLoaderOpts: () => { loaderOpts.length = 0; },
  };
});

vi.mock("../extensions/agent-types.js", () => ({
  getConfig: mockModules.mockGetConfig,
  getAgentConfig: mockModules.mockGetAgentConfig,
  getToolNamesForType: mockModules.mockGetToolNamesForType,
}));

vi.mock("../extensions/prompts.js", () => ({
  buildAgentPrompt: mockModules.mockBuildAgentPrompt,
}));

vi.mock("../extensions/context.js", () => ({
  extractText: mockModules.mockExtractText,
}));

vi.mock("../extensions/skill-loader.js", () => ({
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

import { runAgent, EXCLUDED_TOOL_NAMES } from "../extensions/agent-runner.js";

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
  return {
    setSessionName: vi.fn(),
    getActiveToolNames: vi.fn(),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    messages: [],
  };
}

/* ------------------------------------------------------------------ */
/*  EXCLUDED_TOOL_NAMES                                                */
/* ------------------------------------------------------------------ */

describe("EXCLUDED_TOOL_NAMES", () => {
  it("contains Agent", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("Agent");
  });

  it("contains get_subagent_result", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("get_subagent_result");
  });

  it("contains steer_subagent", () => {
    expect(EXCLUDED_TOOL_NAMES).toContain("steer_subagent");
  });

  it("contains exactly 3 entries", () => {
    expect(EXCLUDED_TOOL_NAMES).toHaveLength(3);
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

  it("filters out Agent, get_subagent_result, steer_subagent from active tools", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue([
      "read", "bash", "edit",
      "Agent", "get_subagent_result", "steer_subagent",
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
        "get_subagent_result",
        "steer_subagent",
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
      "read", "bash", "edit", "Agent", "get_subagent_result",
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
