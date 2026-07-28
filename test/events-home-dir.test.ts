/**
 * events-home-dir.test.ts — Verifies scanAndRegisterAgents uses getAgentDir()
 * instead of process.env.HOME for the user agent directory.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

const mockSetAgentScanDirs = vi.fn();

// Windows-style fixtures: the fix targets Windows, where HOME may be unset
// and paths contain backslashes and spaces.
const MOCK_AGENT_DIR = "C:\\Users\\Pi User\\.pi\\agent";
const MOCK_CWD = "C:\\project";

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
  it("uses getAgentDir() for user agent directory", async () => {
    const ctx = { cwd: MOCK_CWD } as any;
    await scanAndRegisterAgents(ctx);

    // Scan dirs: user (from getAgentDir()), project, shared
    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join(MOCK_AGENT_DIR, "agents"),
      join(MOCK_CWD, ".pi", "agents"),
      join(MOCK_CWD, ".agents", "agents"),
    );
  });
});
