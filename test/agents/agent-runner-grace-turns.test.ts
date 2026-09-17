import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createPendingPromptSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

const fakePi = makeFakePi();

describe("runAgent — grace turns", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
  });

  it("uses default grace turns (6) when not specified in options", async () => {
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, no graceTurns → default 6 → steer at turn 1, abort at turn 1+6=7
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
    });

    await promptStarted;

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=3 → steer at turn 2, abort at turn 2+3=5
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 3,
    });

    await promptStarted;

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=2, graceTurns=0 → steer at turn 2, abort at turn 3
    // (steer and abort can't fire on same turn due to if/else-if structure)
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 2,
      graceTurns: 0,
    });

    await promptStarted;

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
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
    await promptStarted;

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    const controller = new AbortController();
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      signal: controller.signal,
    });
    await promptStarted;

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
    const { session, promptStarted, resolvePrompt } = createPendingPromptSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });

    // maxTurns=1, graceTurns=5 → steer at turn 1, abort at turn 6
    const promise = runAgent(fakeCtx(), "test-agent", "do something", {
      pi: fakePi,
      maxTurns: 1,
      graceTurns: 5,
    });

    await promptStarted;

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
