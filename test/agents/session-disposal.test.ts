import { describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { disposeAgentSession } from "../../src/agents/session-disposal.js";

function fixture() {
  const order: string[] = [];
  const session = {
    abort: vi.fn(async () => {
      order.push("abort");
    }),
    extensionRunner: {
      emit: vi.fn<(event: SessionShutdownEvent) => Promise<void>>(async () => {
        order.push("shutdown");
      }),
    },
    dispose: vi.fn(() => {
      order.push("dispose");
    }),
  };
  return { session, order };
}

describe("child session teardown", () => {
  it("aborts, awaits extension shutdown, then disposes exactly once", async () => {
    const { session, order } = fixture();
    const first = disposeAgentSession(session);
    expect(disposeAgentSession(session)).toBe(first);
    await first;
    expect(order).toEqual(["abort", "shutdown", "dispose"]);
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("still releases extension resources and disposes if abort fails", async () => {
    const { session, order } = fixture();
    session.abort.mockRejectedValue(new Error("abort failed"));
    await expect(disposeAgentSession(session)).rejects.toThrow("abort failed");
    expect(order).toEqual(["shutdown", "dispose"]);
  });

  it("disposes even when an extension shutdown handler fails", async () => {
    const { session } = fixture();
    session.extensionRunner.emit.mockRejectedValue(new Error("shutdown failed"));
    await expect(disposeAgentSession(session)).rejects.toThrow("shutdown failed");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});
