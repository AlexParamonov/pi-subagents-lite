/**
 * agent-runner-continuation.test.ts — Grace turns, max tokens, model error
 * detection, notify buffering, and continueAgentSession tests for agent-runner.
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
  makeMockModel,
  type MockSession,
  assistantMessage,
  userMessage,
} from "./agent-runner-mocks.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const fakePi = makeFakePi();

import { runAgent, continueAgentSession } from "../../src/agents/agent-runner.js";

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

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Fire 6 turns (within default grace period) — should not abort
    for (let i = 0; i < 6; i++) {
      session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 7th turn — should abort (maxTurns=1 + graceTurns=6 = 7)
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
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
      session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Now fire the 5th turn — should abort (maxTurns=2 + graceTurns=3 = 5)
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
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
      session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    }

    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();

    // Fire 1 more turn — abort fires at turn 3 (maxTurns + graceTurns = 2)
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });

  it("attaches rejection handlers to steer and abort", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // Both calls fire from inside a subscribe callback, so a rejected promise
    // escapes the run entirely instead of failing it — under
    // --unhandled-rejections=throw that takes down the host process. Rejection
    // is realistic here: steer/abort target a session already tearing down.
    //
    // Asserted via a .catch spy rather than process.on("unhandledRejection"):
    // vitest's runner intercepts unhandled rejections, so the leak version of
    // this test passed and reported nothing. That couples the test to `.catch`
    // specifically — rewriting the guard as try/await/catch would need this
    // updated.
    const steerPromise = Promise.reject(new Error("session closing"));
    const abortPromise = Promise.reject(new Error("already aborting"));
    // Mark handled before spying: the guard only attaches its handler a few
    // ticks later, and the gap would otherwise make the test itself leak.
    // spyOn installs an own `catch` afterwards, so the guard still hits the spy.
    steerPromise.catch(() => {});
    abortPromise.catch(() => {});
    const steerCatch = vi.spyOn(steerPromise, "catch");
    const abortCatch = vi.spyOn(abortPromise, "catch");
    session.steer = vi.fn(() => steerPromise);
    session.abort = vi.fn(() => abortPromise);

    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
      graceTurns: 1,
    });
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // Turn 1 steers, turn 2 hard-aborts.
    for (let i = 0; i < 2; i++) {
      session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    }

    expect(steerCatch).toHaveBeenCalled();
    expect(abortCatch).toHaveBeenCalled();

    resolvePrompt();
    const result = await promise;
    // A rejected abort() must not change the reported outcome.
    expect(result.aborted).toBe(true);
  });

  it("handles a rejected abort fired from the parent signal", async () => {
    const { session, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const controller = new AbortController();
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    // forwardAbortSignal fires abort() from a signal listener, so a rejection
    // escapes the run. See "attaches rejection handlers to steer and abort"
    // for why this is a .catch spy and not an unhandledRejection assertion.
    const abortPromise = Promise.reject(new Error("already aborting"));
    abortPromise.catch(() => {});
    const abortCatch = vi.spyOn(abortPromise, "catch");
    session.abort = vi.fn(() => abortPromise);

    controller.abort();

    expect(session.abort).toHaveBeenCalled();
    expect(abortCatch).toHaveBeenCalled();

    resolvePrompt();
    await promise;
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
      session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
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
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

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

    const finalPayload = await session.agent.onPayload!(
      { model: "some-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_completion_tokens).toBe(8192);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("resolves the field via pi's compat chain when model compat is silent", async () => {
    // The failing case: a model absent from the generated catalog has no
    // compat. The extension must resolve the field exactly like pi does
    // (detection finds no max_tokens family → max_completion_tokens), not
    // default to max_tokens, or the provider rejects the request.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "custom-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_completion_tokens).toBe(4096);
    expect(finalPayload.max_tokens).toBeUndefined();
  });

  it("keeps sending max_tokens for catalog models with explicit compat", async () => {
    // Catalog opencode-go models carry compat.maxTokensField = max_tokens;
    // the explicit override wins over detection and behavior is unchanged.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "catalog-model",
      name: "Catalog Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      compat: { maxTokensField: "max_tokens" },
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "catalog-model", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.max_completion_tokens).toBeUndefined();
  });

  it("keeps max_tokens injection for non-openai-completions APIs (anthropic-messages)", async () => {
    // The compat chain is openai-completions-only. For other APIs the hook
    // must keep the pre-fix max_tokens injection: it matches anthropic's
    // native field, and the wrong field here would silently drop the
    // user's limit (pi's base params set the model default instead).
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "claude-sonnet", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.max_completion_tokens).toBeUndefined();
  });

  it("keeps max_tokens injection for other non-completions APIs (openai-responses)", async () => {
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    const model = makeMockModel({
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model });

    const finalPayload = await session.agent.onPayload!(
      { model: "gpt-5", messages: [{ role: "user", content: "do something" }] },
      model,
    );

    expect(finalPayload.max_tokens).toBe(4096);
    expect(finalPayload.max_completion_tokens).toBeUndefined();
  });

  it("resolves the field from the per-request model when the model changed mid-run", async () => {
    // setModel can swap the model mid-run; pi's base params follow the new
    // model, so the hook must resolve the field per request instead of
    // capturing it from the session's spawn-time model.
    mockModules.mockGetAgentConfig.mockReturnValue({
      ...defaultAgentConfig,
      maxTokens: 4096,
    });

    // Spawn-time model: deepseek family → max_tokens.
    const initialModel = makeMockModel({
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
    });

    await runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi, model: initialModel });

    // Per-request model after a mid-run switch: no max_tokens family →
    // max_completion_tokens.
    const switchedModel = makeMockModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    const finalPayload = await session.agent.onPayload!(
      { model: "custom-model", messages: [{ role: "user", content: "do something" }] },
      switchedModel,
    );

    expect(finalPayload.max_completion_tokens).toBe(4096);
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
    const finalPayload = await session.agent.onPayload!(rawPayload, model);

    expect(finalPayload.max_tokens).toBe(2048);
  });
});

/* ------------------------------------------------------------------ */
/*  runAgent — context file gating (includeContextFiles)              */
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

    const ctx = fakeCtx({ ui: { notify: vi.fn() } });

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // At this point setup is done but prompt is still pending — notify should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(ctx.ui.notify).not.toHaveBeenCalled();

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

    const ctx = fakeCtx({ ui: { notify: vi.fn() } });

    await runAgent(ctx, "test-agent", "do something", { pi: fakePi });

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

    const ctx = fakeCtx({ ui: undefined });
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

    const ctx = fakeCtx({ ui: undefined });
    // No ctx.ui — console.warn fallback

    const promise = runAgent(ctx, "test-agent", "do something", { pi: fakePi });

    // Setup done, prompt pending — console.warn should NOT have been called yet
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    expect(warnSpy).not.toHaveBeenCalled();

    resolvePrompt();
    await promise;

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

  /** The message surface the model-error detector reads (role/stopReason/errorMessage). */
  interface TestFeedMessage {
    role: "user" | "assistant";
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  }

  function sessionWithMessages(messages: TestFeedMessage[]) {
    const session = createMockSession();
    Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
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

/* ------------------------------------------------------------------ */
/*  continueAgentSession — resuming a settled session                  */
/* ------------------------------------------------------------------ */

describe("continueAgentSession", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  function fireTextDelta(session: MockSession, delta: string) {
    session
      ._getListeners()
      .forEach((fn: (event: unknown) => void) =>
        fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
      );
  }

  it("prompts the existing session and returns the collected response", async () => {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", {});
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledWith("keep going"));
    fireTextDelta(session, "continued answer");
    resolvePrompt();
    const result = await resultPromise;
    expect(result.responseText).toBe("continued answer");
    expect(result.aborted).toBe(false);
    expect(result.turnLimited).toBe(false);
    expect(result.modelError).toBeUndefined();
  });

  /**
   * Realistic continuation session: the first run's history is already in
   * `messages`, and the prompt appends the continuation's own messages.
   * extractText is mocked to return real text so the fallback scan is exercised.
   */
  function sessionWithPriorRun(continuationMessages: AgentSession["messages"]) {
    const session = createMockSession();
    session.messages = [
      userMessage("first task"),
      assistantMessage({ content: [{ type: "text", text: "first run answer" }] }),
    ];
    session.prompt = vi.fn(async () => {
      session.messages.push(userMessage("keep going"), ...continuationMessages);
    });
    mockModules.mockExtractText.mockImplementation((content: string | ReadonlyArray<{ text?: string }>) => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("");
      return "";
    });
    return session;
  }

  it("does not surface the prior run's text when the continuation ends in a model error", async () => {
    const session = sessionWithPriorRun([assistantMessage({ stopReason: "error", errorMessage: "provider boom" })]);

    const result = await continueAgentSession(asAgentSession(session), "keep going", {});

    // The failed continuation produced no text of its own; the first run's
    // "first run answer" must not leak into the result.
    expect(result.responseText).toBe("");
    expect(result.modelError).toBe("provider boom");
  });

  it("does not surface the prior run's text when the continuation is aborted without text", async () => {
    const session = sessionWithPriorRun([assistantMessage({ stopReason: "aborted" })]);

    const result = await continueAgentSession(asAgentSession(session), "keep going", {});

    expect(result.responseText).toBe("");
    expect(result.modelError).toBeUndefined();
  });

  it("still falls back to the continuation's own assistant text when the collector captured nothing", async () => {
    const session = sessionWithPriorRun([assistantMessage({ content: [{ type: "text", text: "continued answer" }] })]);

    const result = await continueAgentSession(asAgentSession(session), "keep going", {});

    expect(result.responseText).toBe("continued answer");
  });

  it("returns the session so the manager can re-attach it to the record", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {});
    const result = await continueAgentSession(asAgentSession(session), "keep going", {});
    expect(result.session).toBe(session);
  });

  it("never calls onSessionCreated — the session already exists", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {});
    const onSessionCreated = vi.fn();
    await continueAgentSession(asAgentSession(session), "keep going", { onSessionCreated });
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("classifies a provider error from the final assistant message", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {});
    session.messages = [
      assistantMessage({ content: [{ type: "text", text: "x" }], stopReason: "error", errorMessage: "provider boom" }),
    ];
    const result = await continueAgentSession(asAgentSession(session), "keep going", {});
    expect(result.modelError).toBe("provider boom");
  });

  it("applies maxTurns and graceTurns to the continuation's turn tracking", async () => {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", { maxTurns: 1, graceTurns: 2 });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    // Turn 1 hits the soft limit (steer); turn 3 (1 + 2 grace) hard-aborts.
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    expect(session.steer).toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    session._getListeners().forEach((fn) => fn({ type: "turn_end" }));
    expect(session.abort).toHaveBeenCalled();
    resolvePrompt();
    const result = await resultPromise;
    expect(result.aborted).toBe(true);
    expect(result.turnLimited).toBe(true);
  });

  it("forwards an abort signal to the session while the prompt runs", async () => {
    const session = createMockSession();
    let resolvePrompt!: () => void;
    session.prompt = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolvePrompt = r;
        }),
    );
    const controller = new AbortController();
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", { signal: controller.signal });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    controller.abort();
    expect(session.abort).toHaveBeenCalled();
    resolvePrompt();
    await resultPromise;
  });
});
