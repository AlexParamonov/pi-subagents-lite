/**
 * agent-runner-loader-isolation.test.ts — The security boundary of the child
 * announcements: the options a child's resource loader is built from may never
 * reach the parent's event bus, which would let a child-loaded extension read
 * parent traffic and forge the child-lifecycle channels. Kept alone while the
 * rest of that feature's coverage was cut (tasks/lessons.md).
 *
 * Shared mocks: agent-runner-mocks.ts (must be the first import).
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { fakeCtx } from "../fixtures.js";
import { asExtensionAPI } from "../pi-boundaries.js";
import { mockModules, resetMocks, createMockSession } from "./agent-runner-mocks.js";
import { runAgent } from "../../src/agents/agent-runner.js";

describe("runAgent — the child's resource loader", () => {
  beforeEach(() => {
    resetMocks();
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  it("is built from options that reach neither the parent's event bus nor its pi instance", async () => {
    const events: EventBus = { emit: vi.fn(), on: () => () => {} };
    const pi = asExtensionAPI({
      events,
      exec: vi.fn(async () => ({ code: 0, stdout: "true", stderr: "" })),
    });

    await runAgent(fakeCtx(), "test-agent", "task", { pi });

    const loaderOpts = mockModules.getLoaderOpts();
    // Anti-vacuity: the child loader was constructed, and this bus is the one the run used.
    expect(loaderOpts).not.toBeNull();
    expect(events.emit).toHaveBeenCalled();
    expect(Object.values(loaderOpts!)).not.toContain(events);
    expect(Object.values(loaderOpts!)).not.toContain(pi);
  });
});
