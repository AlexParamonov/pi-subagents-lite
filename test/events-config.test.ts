/**
 * events-config.test.ts — session_start config loading in events.ts:
 * the user agent dir comes from getAgentDir() (not $HOME), and the
 * project/shared agent dirs plus the project config dir are gated
 * behind ctx.isProjectTrusted().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { asExtensionContext } from "./pi-boundaries.js";

const mockSetAgentScanDirs = vi.fn();
const mockSetProjectDir = vi.fn();

// Windows-style fixtures: the home-dir fix targets Windows, where HOME may
// be unset and paths contain backslashes and spaces.
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

describe("events.ts session config loading", () => {
  beforeEach(() => {
    mockSetAgentScanDirs.mockClear();
  });

  it("uses getAgentDir() (not $HOME) for the user dir and loads project dirs when trusted", async () => {
    const ctx = asExtensionContext({ cwd: MOCK_CWD, isProjectTrusted: () => true });
    await scanAndRegisterAgents(ctx);

    // Scan dirs: user (from getAgentDir()), project, shared
    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join(MOCK_AGENT_DIR, "agents"),
      join(MOCK_CWD, ".pi", "agents"),
      join(MOCK_CWD, ".agents", "agents"),
    );
  });

  it("skips project dirs when the project is untrusted", async () => {
    const ctx = asExtensionContext({ cwd: MOCK_CWD, isProjectTrusted: () => false });
    await scanAndRegisterAgents(ctx);

    expect(mockSetAgentScanDirs).toHaveBeenCalledWith(
      join(MOCK_AGENT_DIR, "agents"), // user dir always loaded
      "", // projectAgentDir blocked
      "", // sharedAgentDir blocked
    );
  });

  it("points the store at the project .pi dir when trusted", async () => {
    const ctx = asExtensionContext({ cwd: MOCK_CWD, isProjectTrusted: () => true });
    await loadConfigAndRegisterAgents(ctx);

    expect(mockSetProjectDir).toHaveBeenCalledWith(join(MOCK_CWD, ".pi"));
  });

  it("skips the project config when untrusted", async () => {
    const ctx = asExtensionContext({ cwd: MOCK_CWD, isProjectTrusted: () => false });
    await loadConfigAndRegisterAgents(ctx);

    expect(mockSetProjectDir).toHaveBeenCalledWith(undefined);
  });
});
