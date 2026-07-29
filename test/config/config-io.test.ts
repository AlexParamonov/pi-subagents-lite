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
  it.each([
    ["is absent", {}, "legacy/model"],
    ["is explicitly null", { explorer: null }, null],
    ["is explicitly empty", { explorer: "" }, ""],
    ["has another explicit value", { explorer: "new/model" }, "new/model"],
  ])("migrates legacy Explore only when explorer %s", async (_, explorer, expected) => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { Explore: "legacy/model", ...explorer },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().agent.explorer).toBe(expected);
  });

  it("drops an invalid global thinking value while loading config", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { defaultThinking: "invalid" },
      concurrency: { default: 4 },
    }));
    vi.resetModules();

    const { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().agent.defaultThinking).toBeUndefined();
  });

  it("defaults and preserves widget visibility and orchestration settings", async () => {
    mockGetAgentDir.mockReturnValue("/tmp/pi-agent");
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();
    let { loadConfig } = await import("../../src/config/config-io.ts");
    expect(loadConfig().agent).toMatchObject({
      widgetShowModelThinking: true,
      widgetShowStartTime: true,
      orchestrationPrompt: true,
    });

    mockReadFileSync.mockReturnValue(JSON.stringify({
      agent: { default: null, forceBackground: false, widgetShowModelThinking: false, widgetShowStartTime: false, orchestrationPrompt: false },
      concurrency: { default: 4 },
    }));
    vi.resetModules();
    ({ loadConfig } = await import("../../src/config/config-io.ts"));
    expect(loadConfig().agent).toMatchObject({
      widgetShowModelThinking: false,
      widgetShowStartTime: false,
      orchestrationPrompt: false,
    });
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
