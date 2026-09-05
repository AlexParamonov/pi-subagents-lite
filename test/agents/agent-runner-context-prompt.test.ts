/**
 * agent-runner-context-prompt.test.ts — Context files, system prompt modes,
 * project trust, defaultTools, and custom mode tests for agent-runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import fs from "node:fs";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, defaultConfig, defaultAgentConfig, resetMocks, createMockSession } from "./agent-runner-mocks.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const fakePi = makeFakePi();

import { runAgent, resolveEffectiveSystemPromptMode } from "../../src/agents/agent-runner.js";

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

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockLoadProjectContextFiles).toHaveBeenCalled();
    // buildAgentPrompt still called (without contextFiles)
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalled();
  });
  it("includeContextFiles: false on the agent overrides the global ON setting", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = true;
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeContextFiles: false,
    });

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

  it("includeContextFiles: true on the agent overrides the global OFF setting", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockIncludeContextFiles = false;
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeContextFiles: true,
    });
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
});

/* ------------------------------------------------------------------ */
/*  runAgent — per-agent system prompt overrides (include_system_prompt) */
/* ------------------------------------------------------------------ */

describe("runAgent — include_system_prompt overrides", () => {
  let fsReadFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    fsReadFileSyncSpy = vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    fsReadFileSyncSpy.mockRestore();
  });

  function mockSession() {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    return session;
  }

  it("includeSystemPrompt: true inherits the parent when global mode is replace", async () => {
    mockModules.mockSystemPromptMode = "replace";
    mockSession();
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeSystemPrompt: true,
    });
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

  it("includeSystemPrompt: true inherits the parent when global mode is inherit", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    mockSession();
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeSystemPrompt: true,
    });
    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt content");

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ parentSystemPrompt: "parent prompt content" }),
      "inherit",
    );
  });

  it("includeSystemPrompt: true uses the custom prompt when global mode is custom", async () => {
    mockModules.mockSystemPromptMode = "custom";
    mockSession();
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeSystemPrompt: true,
    });
    fsReadFileSyncSpy.mockReturnValue("My custom system prompt");
    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt content");

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(fsReadFileSyncSpy).toHaveBeenCalledWith(expect.stringContaining("subagents-lite-prompt.md"), "utf-8");
    expect(ctx.getSystemPrompt).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ customSystemPrompt: "My custom system prompt" }),
      "custom",
    );
  });

  it("includeSystemPrompt: false forces replace mode when global mode is custom", async () => {
    mockModules.mockSystemPromptMode = "custom";
    mockSession();
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeSystemPrompt: false,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(fsReadFileSyncSpy).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "replace",
    );
  });

  it("includeSystemPrompt: false forces replace mode when global mode is inherit", async () => {
    mockModules.mockSystemPromptMode = "inherit";
    mockSession();
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      includeSystemPrompt: false,
    });
    const ctx = fakeCtx();
    ctx.getSystemPrompt = vi.fn().mockReturnValue("parent prompt content");

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.getSystemPrompt).not.toHaveBeenCalled();
    expect(mockModules.mockBuildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ parentSystemPrompt: expect.anything() }),
      "replace",
    );
  });
});

/* ------------------------------------------------------------------ */
/*  resolveEffectiveSystemPromptMode — effective mode rule             */
/* ------------------------------------------------------------------ */

describe("resolveEffectiveSystemPromptMode", () => {
  it.each([
    ["replace", true, "inherit"],
    ["inherit", true, "inherit"],
    ["custom", true, "custom"],
    ["custom", false, "replace"],
    ["inherit", false, "replace"],
    ["replace", false, "replace"],
    ["replace", undefined, "replace"],
    ["custom", undefined, "custom"],
    ["inherit", undefined, "inherit"],
  ] as const)("global %s + override %s → %s", (globalMode, override, expected) => {
    expect(resolveEffectiveSystemPromptMode(globalMode, override)).toBe(expected);
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
    const settingsManager = {
      isProjectTrusted: () => false,
      getDefaultTools: () => undefined,
      getModelThinkingLevel: () => undefined,
    };
    mockModules.mockSettingsManagerCreate.mockReturnValue(settingsManager);

    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    let sessionOpts: CreateAgentSessionOptions | undefined;
    mockModules.mockCreateAgentSession.mockImplementation((opts: CreateAgentSessionOptions) => {
      sessionOpts = opts;
      return Promise.resolve({ session, extensionsResult: {} });
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, projectTrusted: false });

    // The loader opts carry the same manager instance
    expect(mockModules.getLoaderOpts().settingsManager).toBe(settingsManager);
    // And the session receives it via the settingsManager option
    expect(sessionOpts!.settingsManager).toBe(settingsManager);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — defaultTools setting wiring                            */
/* ------------------------------------------------------------------ */

describe("runAgent — defaultTools setting wiring", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("threads the settings manager's defaultTools into getConfig and getToolNamesForType", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit", "grep"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockSettingsManagerCreate.mockReturnValue({
      getDefaultTools: () => ["read", "bash", "grep"],
      getModelThinkingLevel: () => undefined,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // One read per spawn: both fallback consumers must receive the same value
    // so the resolved config and the session gate cannot diverge.
    expect(mockModules.mockGetConfig).toHaveBeenCalledWith("test-agent", undefined, undefined, [
      "read",
      "bash",
      "grep",
    ]);
    expect(mockModules.mockGetToolNamesForType).toHaveBeenCalledWith("test-agent", ["read", "bash", "grep"]);
  });

  it("passes undefined defaultTools when the setting is unconfigured", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockSettingsManagerCreate.mockReturnValue({
      getDefaultTools: () => undefined,
      getModelThinkingLevel: () => undefined,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(mockModules.mockGetConfig).toHaveBeenCalledWith("test-agent", undefined, undefined, undefined);
    expect(mockModules.mockGetToolNamesForType).toHaveBeenCalledWith("test-agent", undefined);
  });

  it("passes [] through when defaultTools is explicitly empty", async () => {
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    mockModules.mockSettingsManagerCreate.mockReturnValue({
      getDefaultTools: () => [],
      getModelThinkingLevel: () => undefined,
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    // An explicit [] is a configured zero-tool set, not "unconfigured".
    expect(mockModules.mockGetConfig).toHaveBeenCalledWith("test-agent", undefined, undefined, []);
    expect(mockModules.mockGetToolNamesForType).toHaveBeenCalledWith("test-agent", []);
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

    const ctx = fakeCtx({
      getSystemPrompt: vi.fn().mockImplementation(() => {
        throw new Error("no prompt");
      }),
      ui: { notify: vi.fn() },
    });

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
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    fsReadFileSyncSpy.mockImplementation(() => {
      throw err;
    });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const ctx = fakeCtx({ ui: { notify: vi.fn() } });

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

    const ctx = fakeCtx({ ui: { notify: vi.fn() } });

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

    const ctx = fakeCtx({ ui: { notify: vi.fn() } });

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to read custom prompt file"), "warning");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — notify buffering (session tree corruption fix)          */
/* ------------------------------------------------------------------ */
