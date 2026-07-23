/**
 * package-name-matching.test.ts — Extension matching by package name from package.json.
 *
 * Uses real temp directories (no fs mocking) — matches the competitor's testing approach.
 * Tests the override function directly with real package.json files.
 *
 * Port from pi-subagents #143.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.ts";

const fakePi = makeFakePi();

// --- Mock module-level dependencies (same pattern as agent-runner.test.ts) ---

const _loaderOpts: any[] = [];
const _loaderGetExtensionsResult: any = { extensions: [], errors: [], runtime: {} };

function MockDefaultResourceLoader(this: any, opts: any) {
  this._opts = opts;
  this.reload = vi.fn().mockResolvedValue(undefined);
  // Apply the override function if present, so warnings are emitted during runAgent
  this.getExtensions = vi.fn().mockImplementation(() => {
    const result = _loaderGetExtensionsResult;
    return opts.extensionsOverride ? opts.extensionsOverride(result) : result;
  });
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
  mockLoadProjectContextFiles: vi.fn().mockReturnValue([]),
  mockIncludeContextFiles: true as boolean,
  mockSystemPromptMode: "replace" as string,
  getLoaderOpts: () => _loaderOpts[_loaderOpts.length - 1] ?? null,
  clearLoaderOpts: () => { _loaderOpts.length = 0; },
  setLoaderExtensions: (exts: any) => { _loaderGetExtensionsResult.extensions = exts; },
  clearLoaderExtensions: () => { _loaderGetExtensionsResult.extensions = []; },
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
  SettingsManager: { create: vi.fn() },
  getAgentDir: mockModules.mockGetAgentDir,
  loadProjectContextFiles: mockModules.mockLoadProjectContextFiles,
}));

import { runAgent } from "../../src/agents/agent-runner.js";

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
  tools: undefined as (true | string[] | false | undefined),
};

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

/**
 * Create a temp directory with a package.json that declares an extension entry.
 * Returns { dir, extPath } where extPath is the full path to the extension file.
 */
function createPkgDir(pkgName: string, entry: string, piExtensions: string[]): { dir: string; extPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pkg-name-test-"));
  const manifest: Record<string, unknown> = { name: pkgName, pi: { extensions: piExtensions } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const dirPart = entry.includes("/") ? entry.replace(/\/[^/]+$/, "") : "";
  if (dirPart) mkdirSync(join(dir, dirPart), { recursive: true });
  writeFileSync(join(dir, entry), "export default () => {};");
  return { dir, extPath: join(dir, entry) };
}

/* ------------------------------------------------------------------ */
/*  Package name matching — whitelist (extensions array)               */
/* ------------------------------------------------------------------ */

describe("extension matching by package name — whitelist", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("matches extension by package name when directory name differs", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["pi-subagents"],
    });

    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
        { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toBe(extPath);
  });

  it("path-derived name still works when no package.json", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["tavily"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
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

  it("case-insensitive matching for package name", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["Pi-Subagents"],
    });

    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });

  it("npm scoped package: matches by unscoped short name", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["pi-subagents"],
    });

    const { dir, extPath } = createPkgDir("@scope/pi-subagents", "dist/index.js", ["./dist/index.js"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });

  it("does not match when pi.extensions does not declare the entry", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["pi-subagents"],
    });

    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./lib/index.ts"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(0);
  });

  it("matches extension at package root (no subdirectory)", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["my-pkg"],
    });

    const { dir, extPath } = createPkgDir("my-pkg", "index.ts", ["./index.ts"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Package name matching — blacklist (exclude_extensions)             */
/* ------------------------------------------------------------------ */

describe("extension matching by package name — blacklist", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("excludes extension by package name when directory name differs", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({ ...defaultConfig, extensions: true });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["pi-subagents"],
    });

    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
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
/*  Extensions without package.json are unaffected                     */
/* ------------------------------------------------------------------ */

describe("extensions without package.json are unaffected", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("falls back to path-derived name when no package.json", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["my-extension"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    const override = mockModules.getLoaderOpts().extensionsOverride;
    const result = override({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/my-extension/index.ts", tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Warnings for unmatched extension names                             */
/* ------------------------------------------------------------------ */

describe("warnings for unmatched extension names", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when whitelist name doesn't match any loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({
      ...defaultConfig,
      extensions: ["nonexistent"],
    });

    // Set up some loaded extensions that don't match the requested name
    mockModules.setLoaderExtensions([
      { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c: any[]) => c[0]);
    expect(warnCalls.some((msg: string) => msg.includes("nonexistent"))).toBe(true);
  });

  it("warns when blacklist name doesn't match any loaded extension", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockGetConfig.mockReturnValue({ ...defaultConfig, extensions: true });
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      extensions: true,
      excludeExtensions: ["nonexistent"],
    });

    // Set up some loaded extensions that don't match the excluded name
    mockModules.setLoaderExtensions([
      { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
    ]);

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c: any[]) => c[0]);
    expect(warnCalls.some((msg: string) => msg.includes("nonexistent"))).toBe(true);
  });
});
