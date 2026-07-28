import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";

const { mockGetAgentDir, mockMkdirSync, mockWriteFileSync, mockRenameSync, mockReadFileSync } = vi.hoisted(() => ({
  mockGetAgentDir: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  readFileSync: mockReadFileSync,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("config I/O paths", () => {
  it("loads widget visibility settings and supplies their true defaults", async () => {
    mockGetAgentDir.mockReturnValue("/agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().agent.widgetShowModelThinking).toBe(true);
    expect(loadConfig().agent.widgetShowStartTime).toBe(true);

    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false, widgetShowModelThinking: false, widgetShowStartTime: false },
      concurrency: { default: 4 },
    }));
    expect(loadConfig().agent.widgetShowModelThinking).toBe(false);
    expect(loadConfig().agent.widgetShowStartTime).toBe(false);
  });

  it("uses Pi's agent directory for config and custom prompts when HOME is unset", async () => {
    const agentDir = "C:\\Users\\Pi User\\.pi\\agent";
    vi.stubEnv("HOME", "");
    mockGetAgentDir.mockReturnValue(agentDir);
    vi.resetModules();

    const { CUSTOM_PROMPT_PATH, saveConfigAtomic } = await import("../../src/config/config-io.ts");
    saveConfigAtomic({ agent: {} as any, concurrency: {} as any });

    const configPath = join(agentDir, "subagents-lite.json");
    expect(mockGetAgentDir).toHaveBeenCalledOnce();
    expect(CUSTOM_PROMPT_PATH).toBe(join(agentDir, "subagents-lite-prompt.md"));
    expect(mockMkdirSync).toHaveBeenCalledWith(agentDir, { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(`${configPath}.tmp`, expect.any(String), "utf-8");
    expect(mockRenameSync).toHaveBeenCalledWith(`${configPath}.tmp`, configPath);
  });
});
