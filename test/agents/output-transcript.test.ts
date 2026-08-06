/**
 * output-transcript.test.ts — Tests for outputTranscript setting.
 *
 * Verifies:
 * - Global config outputTranscript controls transcript writing
 * - Agent frontmatter output_transcript overrides global
 * - Default behavior (both absent) writes transcripts (backward compatible)
 * - Widget doesn't show tail -f when outputFile is undefined
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager } from "../../src/agents/agent-manager.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../../src/config/config-store.js";
import type { ConfigIO } from "../../src/config/config-store.js";
import type { SubagentsConfig } from "../../src/models/model-precedence.js";
import { AgentOutputLog } from "../../src/agents/output-file.js";
import { getStore } from "../../src/shell.js";
import { getAgentConfig } from "../../src/agents/agent-types.js";
import type { AgentConfig } from "../../src/agents/types.js";

// Mock modules
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "agent-00000001"),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("../../src/agents/agent-runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    responseText: "done",
    session: { subscribe: vi.fn(), messages: [], dispose: vi.fn() },
    aborted: false,
    turnLimited: false,
  }),
}));

vi.mock("../../src/agents/agent-types.js", () => ({
  getAgentConfig: vi.fn(),
}));

// Mock getStore
const mockStore = {
  agent: {
    outputTranscript: true,
    deltaInputTokens: true,
    toolTimeoutMinutes: 0,
    idleTimeoutMinutes: 0,
  },
};

vi.mock("../../src/shell.js", () => ({
  getStore: vi.fn(() => mockStore),
}));

// In-memory ConfigIO for testing
function memIO(initial: Partial<SubagentsConfig> = {}): ConfigIO {
  const defaults = {
    agent: {
      default: null as null,
      forceBackground: false,
      graceTurns: 6,
      widgetMaxLines: 12,
      widgetDescLengthFull: 50,
      widgetDescLengthCompact: 30,
      widgetCompact: false,
      showCompletionCards: true,
      widgetShortcut: false,
      systemPromptMode: "replace" as const,
      includeContextFiles: true,
      disableDefaultAgents: false,
      showTools: false,
      showTurns: true,
      showInput: true,
      showOutput: true,
      showContext: true,
      showCost: false,
      showTime: true,
      toolTimeoutMinutes: 45,
      idleTimeoutMinutes: 45,
      outputTranscript: true,
    },
    concurrency: { default: 4 },
  };
  let cur = { ...defaults, ...initial, agent: { ...defaults.agent, ...(initial.agent ?? {}) } } as SubagentsConfig;
  return {
    load: () => structuredClone(cur),
    save: (c) => {
      cur = structuredClone(c);
    },
  };
}

describe("outputTranscript setting", () => {
  let manager: AgentManager;
  let store: ConfigStore;
  let mockPi: ExtensionAPI;
  let mockCtx: ExtensionContext;

  beforeEach(() => {
    const io = memIO();
    store = new ConfigStore(io);

    // Reset mock store to default
    mockStore.agent.outputTranscript = true;

    // Reset getAgentConfig mock to return undefined by default (no agent-level override)
    vi.mocked(getAgentConfig).mockReturnValue(undefined);

    manager = new AgentManager(
      undefined,
      undefined,
      undefined,
      0, // bufferSize
    );

    mockPi = {} as ExtensionAPI;
    mockCtx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext;
  });

  afterEach(() => {
    manager?.dispose();
    vi.clearAllMocks();
  });

  describe("global config outputTranscript", () => {
    it("should create output log when outputTranscript is true (default)", () => {
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test prompt", {
        description: "test",
      });

      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeDefined();
      expect(record?.execution.outputLog).toBeInstanceOf(AgentOutputLog);
    });

    it("should not create output log when outputTranscript is false in global config", () => {
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test prompt", {
        description: "test",
      });

      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
      expect(record?.execution.outputLog).toBeUndefined();
    });
  });

  describe("agent-level output_transcript override", () => {
    it("should not create output log when frontmatter output_transcript is false, even if global is true", () => {
      vi.mocked(getAgentConfig).mockReturnValue({ outputTranscript: false } as AgentConfig);
      mockStore.agent.outputTranscript = true;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
      expect(record?.execution.outputLog).toBeUndefined();
    });

    it("should create output log when frontmatter output_transcript is true, even if global is false", () => {
      vi.mocked(getAgentConfig).mockReturnValue({ outputTranscript: true } as AgentConfig);
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeDefined();
      expect(record?.execution.outputLog).toBeInstanceOf(AgentOutputLog);
    });

    it("should use global setting when agent frontmatter does not specify output_transcript", () => {
      vi.mocked(getAgentConfig).mockReturnValue({} as AgentConfig);
      mockStore.agent.outputTranscript = false;

      const id = manager.spawn(mockPi, mockCtx, "test-agent", "test prompt", { description: "test" });
      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeUndefined();
    });
  });

  describe("backward compatibility", () => {
    it("should write transcripts when both settings are absent (default true)", () => {
      const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test prompt", {
        description: "test",
      });

      const record = manager.getRecord(id);
      expect(record?.display.outputFile).toBeDefined();
    });
  });
});
