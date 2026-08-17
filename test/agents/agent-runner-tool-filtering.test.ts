/**
 * agent-runner-tool-filtering.test.ts — Tool filtering and extension tests for agent-runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import {
  mockModules,
  defaultConfig,
  defaultAgentConfig,
  resetMocks,
  createMockSession,
  asLoadExtensionsResult,
} from "./agent-runner-mocks.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

const fakePi = makeFakePi();

import { runAgent, subscribeToSessionEvents } from "../../src/agents/agent-runner.js";

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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
      excludeTools: ["write"],
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    const originalClassifier = vi.fn().mockReturnValue(false);
    session._isRetryableError = originalClassifier;
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });

    expect(session._isRetryableError).not.toBe(originalClassifier);
    // Transient Codex stream errors are classified as retryable by our pattern...
    expect(
      session._isRetryableError!({ stopReason: "error", errorMessage: "stream disconnected before completion" }),
    ).toBe(true);
    // ...without calling the original (our pattern matches first).
    expect(originalClassifier).not.toHaveBeenCalled();
    // Other errors fall through to the original classifier.
    originalClassifier.mockClear();
    expect(session._isRetryableError!({ stopReason: "error", errorMessage: "rate limited" })).toBe(false);
    expect(originalClassifier).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  subscribeToSessionEvents — event forwarding                        */
/* ------------------------------------------------------------------ */

describe("subscribeToSessionEvents — event forwarding", () => {
  it("extracts u.cost?.total from assistant message_end events", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

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

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

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

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

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

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

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

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

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

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: "turn_end",
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("does not fire onAssistantUsage when usage is missing", () => {
    const onAssistantUsage = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onAssistantUsage });

    const listeners = session._getListeners();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: "message_end",
      message: { role: "assistant", content: "Hello" },
    });

    expect(onAssistantUsage).not.toHaveBeenCalled();

    unsub();
  });

  it("forwards toolCallId on tool activity events", () => {
    const onToolActivity = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onToolActivity });
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
    const unsub = subscribeToSessionEvents(asAgentSession(session), {});
    // The noop early-return must not touch the session at all
    expect(session.subscribe).not.toHaveBeenCalled();
    expect(typeof unsub).toBe("function");
  });
  it("forwards compaction_end events to onCompaction", () => {
    const onCompaction = vi.fn();
    const session = createMockSession();

    const unsub = subscribeToSessionEvents(asAgentSession(session), { onCompaction });

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

    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
          { path: "/home/test/.pi/agent/extensions/extra-tools/glob.ts", tools: new Map([["glob", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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
    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
          { path: "/home/test/.pi/agent/extensions/other/index.ts", tools: new Map([["other_tool", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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
    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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

    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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
    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
          { path: "/home/test/.pi/agent/extensions/confirm-edits/index.ts", tools: new Map() },
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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
    const override = loaderCall.extensionsOverride!;
    const result = override(
      asLoadExtensionsResult({
        extensions: [
          { path: "/home/test/.pi/agent/extensions/quality-monitor/index.ts", tools: new Map() },
          { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        ],
        errors: [],
        runtime: {},
      }),
    );
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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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
    let sessionOpts: CreateAgentSessionOptions | undefined;
    mockModules.mockCreateAgentSession.mockImplementation((opts: CreateAgentSessionOptions) => {
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

    expect(sessionOpts!.tools).toEqual(expect.arrayContaining(["read", "web_search", "web_extract", "web_crawl"]));
    expect(sessionOpts!.tools).not.toContain("bash");
    expect(sessionOpts!.tools).not.toContain("edit");
    expect(sessionOpts!.tools).not.toContain("tavily/*");
    expect(sessionOpts!.tools).not.toContain("Agent");
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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

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

    await runAgent(fakeCtx({ ui: undefined }), "test-agent", "do something", { pi: fakePi });

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("read");
    expect(activeTools).not.toContain("web_search");
    expect(activeTools).not.toContain("web_extract");
    expect(activeTools).not.toContain("bash");

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

    expect(warnSpy).not.toHaveBeenCalled();

    const activeTools = session.getActiveTools()!;
    expect(activeTools).toContain("web_search");
    expect(activeTools).toContain("web_extract");
    expect(activeTools).not.toContain("Agent");
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — grace turns                                            */
/* ------------------------------------------------------------------ */
