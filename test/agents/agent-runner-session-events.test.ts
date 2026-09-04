/**
 * agent-runner-session-events.test.ts — Session-event wiring for agent-runner:
 * retry-classifier patching and subscribeToSessionEvents forwarding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";

const fakePi = makeFakePi();

import { runAgent, subscribeToSessionEvents } from "../../src/agents/agent-runner.js";

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
