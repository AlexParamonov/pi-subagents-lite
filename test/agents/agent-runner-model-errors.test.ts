import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

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
