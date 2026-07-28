/**
 * A queued worktree spawn must retain the definition discovered for that worktree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("../../src/shell.js", () => ({
  getStore: () => ({ agent: { deltaInputTokens: false } }),
  getWidget: () => undefined,
  getPiInstance: () => undefined,
  getSessionCtx: () => undefined,
}));

import { AgentManager } from "../../src/agents/agent-manager.js";
import { SpawnCoordinator } from "../../src/spawn/spawn-coordinator.js";
import {
  resolveWorktreeAgent,
  registerAgents,
  setAgentScanDirs,
} from "../../src/agents/agent-types.js";

function runResult() {
  return {
    responseText: "done",
    session: { messages: [], dispose: vi.fn() },
    aborted: false,
    turnLimited: false,
  };
}

describe("queued worktree agent configuration", () => {
  let manager: AgentManager;

  beforeEach(() => {
    mocks.runAgent.mockReset();
    registerAgents(new Map(), { disableDefaultAgents: true });
    setAgentScanDirs("", "");
    manager = new AgentManager(undefined, { default: 1 });
  });

  afterEach(() => {
    manager.dispose();
  });

  it("runs a queued A definition after B discovery without consulting B's definition", async () => {
    const worktreeA = tempDirWithFiles([
      {
        name: "reviewer.md",
        content: makeAgentMd({
          name: "reviewer",
          description: "Worktree A reviewer",
          tools: "read",
        }).replace("System prompt body text.", "A-only prompt."),
      },
    ], "worktree-a-agents");
    const worktreeB = tempDirWithFiles([
      {
        name: "reviewer.md",
        content: makeAgentMd({
          name: "reviewer",
          description: "Worktree B reviewer",
          tools: "bash",
        }).replace("System prompt body text.", "B-only prompt."),
      },
    ], "worktree-b-agents");

    try {
      const a = await resolveWorktreeAgent("reviewer", worktreeA.dir, { disableDefaultAgents: true });
      expect(a).toBeDefined();
      const coordinator = new SpawnCoordinator(manager);
      const ctx = { cwd: "/parent", modelRegistry: {} } as any;
      const pi = { exec: vi.fn() } as any;
      let unblock!: (result: ReturnType<typeof runResult>) => void;
      const blocked = new Promise<ReturnType<typeof runResult>>((resolve) => { unblock = resolve; });
      mocks.runAgent.mockReturnValueOnce(blocked).mockResolvedValue(runResult());

      manager.spawn(pi, ctx, "blocker", "hold the slot", {
        description: "blocker",
        modelKey: "test/model",
      });
      await coordinator.spawn(pi, ctx, {
        type: "reviewer",
        prompt: "review A",
        description: "queued A",
        modelKey: "test/model",
        agentConfig: a!.config,
        graceTurns: 1,
        runInBackground: true,
      });

      expect(mocks.runAgent).toHaveBeenCalledTimes(1);
      const b = await resolveWorktreeAgent("reviewer", worktreeB.dir, { disableDefaultAgents: true });
      expect(b?.config.systemPrompt).toBe("B-only prompt.");

      unblock(runResult());
      await vi.waitFor(() => expect(mocks.runAgent).toHaveBeenCalledTimes(2));

      const queuedOptions = mocks.runAgent.mock.calls[1][3];
      expect(queuedOptions.agentConfig).toEqual(expect.objectContaining({
        description: "Worktree A reviewer",
        systemPrompt: "A-only prompt.",
        registeredTools: ["read"],
        tools: ["read"],
      }));
    } finally {
      worktreeA.cleanup();
      worktreeB.cleanup();
    }
  });
});
