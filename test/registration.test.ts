import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/tool-execution.js", () => ({
  executeAgentTool: vi.fn(),
  executeStopAgentTool: vi.fn(),
}));
vi.mock("../src/agents/agent-status.js", () => ({ executeAgentStatusTool: vi.fn() }));
vi.mock("../src/ui/renderer.js", () => ({
  renderAgentToolCall: vi.fn(),
  renderAgentToolResult: vi.fn(),
  renderSubagentResult: vi.fn(),
}));
vi.mock("../src/ui/menu/menus.js", () => ({ showAgentsMainMenu: vi.fn() }));
vi.mock("../src/shell.js", () => ({ getStore: () => ({ agent: { showCost: false } }) }));

import { registerTools } from "../src/registration.ts";

function registerSchema(): Record<string, unknown> {
  const registerTool = vi.fn();
  registerTools({ registerTool, registerMessageRenderer: vi.fn(), registerCommand: vi.fn() } as any);
  return registerTool.mock.calls.find(([tool]) => tool.name === "Agent")[0].parameters;
}

describe("Agent tool schema", () => {
  it("is bare and byte-stable regardless of dynamic agent settings", () => {
    const first = registerSchema();
    const second = registerSchema();

    expect(first.properties.agent.description).toBeUndefined();
    expect(second).toEqual(first);
  });
});
