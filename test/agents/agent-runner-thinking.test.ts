/**
 * agent-runner-thinking.test.ts — Runtime thinking resolution in the spawn
 * runner (initSession).
 *
 * Pins the spawn-effective precedence:
 *   explicit param > frontmatter > pi per-model (trust-gated SettingsManager,
 *   keyed by the resolved model's provider/modelId) > defaultThinking >
 *   nothing passed (pi's own fallback: defaultThinkingLevel → medium, clamped)
 *
 * The per-model read must go through the same trust-gated SettingsManager
 * instance the session is created with, so the project-trust gate applies
 * identically to the read.
 */

import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fakeCtx, fakePi as makeFakePi } from "../fixtures.js";
import { mockModules, defaultAgentConfig, resetMocks, createMockSession, makeMockModel } from "./agent-runner-mocks.js";
import type { MockSettingsManager } from "./agent-runner-mocks.js";
import type { ThinkingLevel } from "../../src/types.js";

const fakePi = makeFakePi();

import { runAgent } from "../../src/agents/agent-runner.js";

const SPAWN_MODEL = makeMockModel({ provider: "anthropic", id: "claude-opus-4-1", reasoning: true });

/** Install a trust-gated SettingsManager mock whose per-model read returns `perModel`. */
function mockSettingsManager(perModel: ThinkingLevel | undefined): MockSettingsManager {
  const sm: MockSettingsManager = {
    getModelThinkingLevel: vi.fn(() => perModel),
  };
  mockModules.mockSettingsManagerCreate.mockReturnValue(sm);
  return sm;
}

/** The options createAgentSession received (the session-creation contract). */
function sessionOpts(): Record<string, unknown> {
  const call = mockModules.mockCreateAgentSession.mock.calls[0];
  expect(call).toBeDefined();
  return call![0] as unknown as Record<string, unknown>;
}

async function runWithSpawnModel(thinkingLevel?: ThinkingLevel, parentLevel?: ThinkingLevel) {
  return runAgent(fakeCtx({ thinkingLevel: parentLevel }), "test-agent", "do something", {
    pi: fakePi,
    model: SPAWN_MODEL,
    thinkingLevel,
  });
}

describe("runAgent — runtime thinking resolution", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  it("passes the per-model level when only modelThinkingLevels is set for the resolved model", async () => {
    const sm = mockSettingsManager("high");

    await runWithSpawnModel();

    expect(sm.getModelThinkingLevel).toHaveBeenCalledWith("anthropic", "claude-opus-4-1");
    expect(sessionOpts().thinkingLevel).toBe("high");
  });

  it("reads the per-model level from the same trust-gated instance the session gets", async () => {
    const sm = mockSettingsManager("high");

    await runWithSpawnModel();

    expect(sessionOpts().settingsManager).toBe(sm);
  });

  it("frontmatter thinking beats the per-model setting", async () => {
    mockSettingsManager("high");
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, thinkingLevel: "low" });

    await runWithSpawnModel();

    expect(sessionOpts().thinkingLevel).toBe("low");
  });

  it("the explicit spawn param beats frontmatter and the per-model setting", async () => {
    mockSettingsManager("high");
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, thinkingLevel: "low" });

    await runWithSpawnModel("medium");

    expect(sessionOpts().thinkingLevel).toBe("medium");
  });

  it("per-model beats the defaultThinking setting (default thinking only overrides pi's global default)", async () => {
    mockSettingsManager("low");
    mockModules.mockDefaultThinking = "max";

    await runWithSpawnModel();

    expect(sessionOpts().thinkingLevel).toBe("low");
  });

  it("falls back to the defaultThinking setting when frontmatter and per-model are unset", async () => {
    mockSettingsManager(undefined);
    mockModules.mockDefaultThinking = "max";

    await runWithSpawnModel();

    expect(sessionOpts().thinkingLevel).toBe("max");
  });

  it("passes nothing when no thinking source is set, so pi's own fallback applies", async () => {
    mockSettingsManager(undefined);

    await runWithSpawnModel();

    expect(sessionOpts().thinkingLevel).toBeUndefined();
  });
});

describe("runAgent — the `parent` value", () => {
  beforeEach(() => {
    resetMocks();
    fakePi.exec.mockResolvedValue({ code: 0, stdout: "true" });
    const session = createMockSession();
    session.getActiveToolNames.mockReturnValue(["read", "bash", "edit"]);
    mockModules.mockCreateAgentSession.mockResolvedValue({ session, extensionsResult: {} });
  });

  it("runs at the parent level when frontmatter holds `parent`, beating the per-model level", async () => {
    mockSettingsManager("high");
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, thinkingLevel: "parent" });

    await runWithSpawnModel(undefined, "minimal");

    expect(sessionOpts().thinkingLevel).toBe("minimal");
  });

  it("runs at the parent level when defaultThinking holds `parent`", async () => {
    mockSettingsManager(undefined);
    mockModules.mockDefaultThinking = "parent";

    await runWithSpawnModel(undefined, "low");

    expect(sessionOpts().thinkingLevel).toBe("low");
  });

  it("keeps a concrete higher source above a lower `parent`", async () => {
    mockSettingsManager(undefined);
    mockModules.mockDefaultThinking = "parent";
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, thinkingLevel: "low" });

    await runWithSpawnModel(undefined, "minimal");

    expect(sessionOpts().thinkingLevel).toBe("low");
  });

  it("treats a `parent` source as unwritten when the parent has no level, never passing `parent`", async () => {
    mockSettingsManager("high");
    mockModules.mockGetAgentConfig.mockReturnValue({ ...defaultAgentConfig, thinkingLevel: "parent" });

    await runWithSpawnModel();

    expect(sessionOpts().thinkingLevel).toBe("high");
  });

  it("passes nothing when `parent` is the only source and the parent has no level", async () => {
    mockSettingsManager(undefined);
    mockModules.mockDefaultThinking = "parent";

    await runWithSpawnModel();

    expect(sessionOpts()).not.toHaveProperty("thinkingLevel");
  });
});
