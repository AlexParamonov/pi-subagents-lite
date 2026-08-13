/**
 * events-project-trust-gate.test.ts — Verifies scanAndRegisterAgents gates
 * project-local agent directories behind ctx.isProjectTrusted().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const mockSetAgentScanDirs = vi.fn();
const mockSetProjectDir = vi.fn();

const MOCK_AGENT_DIR = "/home/user/.pi/agent";
const MOCK_CWD = "/home/user/project";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

vi.mock("../src/agents/agent-types.js", () => ({
  getConfig: vi.fn(),
  registerAgents: vi.fn(),
  getAvailableTypes: vi.fn(() => []),
  setAgentScanDirs: mockSetAgentScanDirs,
  scanAndMerge: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../src/agents/default-agents.js", () => ({
  DEFAULT_AGENTS: new Map(),
}));

vi.mock("../src/agents/agent-discovery.js", () => ({
  scanAgentFilesInDir: vi.fn().mockResolvedValue(new Map()),
  mergeAgents: vi.fn(),
}));

vi.mock("../src/agents/agent-manager.js", () => ({
  AgentManager: class AgentManager {
    setOnComplete(): void {}
  },
}));

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class AgentWidget {},
}));

vi.mock("../src/ui/result-viewer.js", () => ({
  ResultViewer: class ResultViewer {},
}));

vi.mock("../src/spawn/spawn-coordinator.js", () => ({
  SpawnCoordinator: class SpawnCoordinator {},
}));

vi.mock("../src/agents/tool-execution.js", () => ({
  toolCallListener: vi.fn(),
}));

vi.mock("../src/registration.js", () => ({
  registerAgentTool: vi.fn(),
}));

vi.mock("../src/prompt/context.js", () => ({
  buildSnapshotMarkdown: vi.fn(() => ""),
}));

vi.mock("../src/ui/format.js", () => ({
  formatMs: vi.fn(() => "0s"),
  buildStatsParts: vi.fn(() => []),
  getDisplayName: vi.fn((type: string) => type),
}));

vi.mock("../src/ui/menu/menus.js", () => ({
  buildAgentsMenu: vi.fn(() => null),
  buildAgentSpawnMenu: vi.fn(() => null),
  buildAgentRunningMenu: vi.fn(() => null),
  buildAgentConcurrencyMenu: vi.fn(() => null),
  buildAgentDebugMenu: vi.fn(() => null),
  buildAgentModelSettingsMenu: vi.fn(() => null),
  buildAgentSpawnWizardMenu: vi.fn(() => null),
  buildAgentSystemPromptMenu: vi.fn(() => null),
  buildAgentWidgetSettingsMenu: vi.fn(() => null),
}));

vi.mock("../src/shell.js", () => ({
  getManager: vi.fn(() => null),
  getWidget: vi.fn(() => null),
  getStore: vi.fn(() => ({
    agent: { disableDefaultAgents: false },
    setDeps: vi.fn(),
    setProjectDir: mockSetProjectDir,
    reload: vi.fn(),
    notifyToolsExpanded: vi.fn(),
    dispose: vi.fn(),
  })),
  getCoordinator: vi.fn(() => null),
  getPiInstance: vi.fn(() => null),
  getSessionCtx: vi.fn(() => ({})),
  setSessionCtx: vi.fn(),
  setManager: vi.fn(),
  setWidget: vi.fn(),
  setCoordinator: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", () => ({
  matchesKey: vi.fn(() => false),
  isKeyRelease: vi.fn(() => false),
  truncateToWidth: (text: string, width: number) => text,
  Editor: class Editor {},
  Container: class Container {},
  Markdown: class Markdown {},
  Spacer: class Spacer {},
  Text: class Text {},
  getKeybindings: () => [],
  visibleWidth: (text: string) => text.length,
}));

// Import after mocks
const { scanAndRegisterAgents, loadConfigAndRegisterAgents } = await import("../src/events.js");

describe("events.ts project trust gate", () => {
  beforeEach(() => {
    mockSetAgentScanDirs.mockClear();
  });

  it("loads project dirs when project is trusted", async () => {
    const ctx = {
      cwd: MOCK_CWD,
      isProjectTrusted: () => true,
    } as any;
    await scanAndRegisterAgents(ctx);

    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join(MOCK_AGENT_DIR, "agents"),
      join(MOCK_CWD, ".pi", "agents"),
      join(MOCK_CWD, ".agents", "agents"),
    );
  });

  it("skips project dirs when project is untrusted", async () => {
    const ctx = {
      cwd: MOCK_CWD,
      isProjectTrusted: () => false,
    } as any;
    await scanAndRegisterAgents(ctx);

    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join(MOCK_AGENT_DIR, "agents"), // user dir always loaded
      "", // projectAgentDir blocked
      "", // sharedAgentDir blocked
    );
  });

  it("always loads user-level agent dir regardless of trust", async () => {
    // Trusted
    {
      const ctx = { cwd: MOCK_CWD, isProjectTrusted: () => true } as any;
      await scanAndRegisterAgents(ctx);
      const [userDir] = mockSetAgentScanDirs.mock.calls[0];
      expect(userDir).toBe(join(MOCK_AGENT_DIR, "agents"));
    }

    // Untrusted
    mockSetAgentScanDirs.mockClear();
    {
      const ctx = { cwd: MOCK_CWD, isProjectTrusted: () => false } as any;
      await scanAndRegisterAgents(ctx);
      const [userDir] = mockSetAgentScanDirs.mock.calls[0];
      expect(userDir).toBe(join(MOCK_AGENT_DIR, "agents"));
    }
  });

  it("loadConfigAndRegisterAgents points the store at the project .pi dir when trusted", async () => {
    const ctx = { cwd: MOCK_CWD, isProjectTrusted: () => true } as any;
    await loadConfigAndRegisterAgents(ctx);

    expect(mockSetProjectDir).toHaveBeenCalledWith(join(MOCK_CWD, ".pi"));
  });

  it("loadConfigAndRegisterAgents skips the project config when untrusted", async () => {
    const ctx = { cwd: MOCK_CWD, isProjectTrusted: () => false } as any;
    await loadConfigAndRegisterAgents(ctx);

    expect(mockSetProjectDir).toHaveBeenCalledWith(undefined);
  });
});
