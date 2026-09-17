import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { asAgentSession } from "../pi-boundaries.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  mockModules,
  resetMocks,
  createMockSession,
  createPendingPromptSession,
  type MockSession,
  assistantMessage,
  userMessage,
} from "./agent-runner-mocks.js";
import { continueAgentSession } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", {});
    expect(await promptStarted).toBe("keep going");
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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", { maxTurns: 1, graceTurns: 2 });
    await promptStarted;
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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    const controller = new AbortController();
    const resultPromise = continueAgentSession(asAgentSession(session), "keep going", { signal: controller.signal });
    await promptStarted;
    controller.abort();
    expect(session.abort).toHaveBeenCalled();
    resolvePrompt();
    await resultPromise;
  });
});
