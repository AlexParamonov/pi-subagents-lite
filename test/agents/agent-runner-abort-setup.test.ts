/**
 * agent-runner-abort-setup.test.ts — Abort during session setup.
 *
 * A parent interrupt (stop) can land while a spawn is still setting up. The
 * runner must then either skip session creation entirely or dispose the
 * session it already created through the shared teardown, so no setup abort
 * leaves an undisposed child session.
 *
 * Shared mocks: agent-runner-mocks.ts (must be the first import).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, resetMocks, createMockSession, type MockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

describe("runAgent — abort during setup", () => {
  let session: MockSession;
  const fakePi = makeFakePi();

  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  it("skips session creation when the signal aborts before the resource load", async () => {
    const controller = new AbortController();
    fakePi.exec.mockImplementation(async () => {
      controller.abort();
      return { code: 0, stdout: "true" };
    });

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: fakePi, signal: controller.signal })).rejects.toThrow(
      /aborted during setup/,
    );

    expect(mockModules.mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("disposes the created session through the teardown when the signal aborts after creation", async () => {
    const controller = new AbortController();
    mockModules.mockCreateAgentSession.mockImplementation(async () => {
      controller.abort();
      return { session, extensionsResult: {} };
    });

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: fakePi, signal: controller.signal })).rejects.toThrow(
      /aborted during setup/,
    );

    expect(session.abort).toHaveBeenCalled();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the created session when setup fails after creation", async () => {
    session.bindExtensions.mockRejectedValue(new Error("bind failed"));

    await expect(runAgent(fakeCtx(), "test-agent", "task", { pi: fakePi })).rejects.toThrow("bind failed");

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("runs normally when no signal is given", async () => {
    const result = await runAgent(fakeCtx(), "test-agent", "task", { pi: fakePi });

    expect(result.responseText).toBeDefined();
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
