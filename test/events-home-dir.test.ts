/**
 * events-home-dir.test.ts — Verifies scanAndRegisterAgents uses getAgentDir()
 * instead of process.env.HOME for the user agent directory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetAgentDir = vi.fn(() => "/mock-home/.pi/agent");
const mockSetAgentScanDirs = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
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
  AgentManager: class AgentManager {},
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
  truncateDesc: vi.fn((desc: string) => desc),
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
const { scanAndRegisterAgents } = await import("../src/events.js");

describe("events.ts home directory resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentDir.mockReturnValue("/mock-home/.pi/agent");
  });

  it("uses getAgentDir() for user agent directory", async () => {
    const ctx = { cwd: "/project" } as any;
    await scanAndRegisterAgents(ctx);

    // setAgentScanDirs is called with (userAgentDir, projectAgentDir, sharedAgentDir)
    expect(mockSetAgentScanDirs).toHaveBeenCalled();
    const callArgs = mockSetAgentScanDirs.mock.calls[0];
    const userAgentDir = callArgs[0];

    // Should be built from getAgentDir() + "agents"
    expect(userAgentDir).toBe("/mock-home/.pi/agent/agents");
  });
});
