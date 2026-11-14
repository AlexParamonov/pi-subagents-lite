import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import {
  mockModules,
  resetMocks,
  createMockSession,
  createPendingPromptSession,
  assistantMessage,
  type MockSession,
} from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

describe("runAgent — settled response text", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  // The nudge card reads the reply from the line below the envelope separator, which needs trimmed text.
  function startRun(session: MockSession) {
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
    return runAgent(fakeCtx(), "test-agent", "do something", { pi: fakePi });
  }

  function fireTextDelta(session: MockSession, delta: string) {
    session
      ._getListeners()
      .forEach((fn) => fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }));
  }

  it("trims whitespace around the streamed reply", async () => {
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    const promise = startRun(session);

    await promptStarted;
    fireTextDelta(session, "\n\n  Fixed the flake.");
    fireTextDelta(session, "\n\nDone.\n  ");
    resolvePrompt();

    expect((await promise).responseText).toBe("Fixed the flake.\n\nDone.");
  });

  it("trims whitespace around the fallback assistant text", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => {
      session.messages.push(assistantMessage({ content: [{ type: "text", text: "\n\n  Fixed the flake.\n\n" }] }));
    });
    mockModules.mockExtractText.mockImplementation((content: string | ReadonlyArray<{ text?: string }>) =>
      typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""),
    );

    expect((await startRun(session)).responseText).toBe("Fixed the flake.");
  });
});
