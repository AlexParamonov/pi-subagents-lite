/**
 * agent-types-mock.ts — Shared mock factory for agent-types.js getAgentConfig.
 *
 * Provides a standard getAgentConfig mock that returns test agent configs
 * with computed displayName. Use in vi.mock() factory bodies.
 */

import { vi } from "vitest";

/**
 * Returns a getAgentConfig mock function.
 * The returned function creates a test agent config with:
 *   - name: the agent type string
 *   - displayName: title-cased type string
 *   - description: "Test agent <type>"
 *   - systemPrompt: "test"
 *
 * Usage in vi.mock factory:
 *   vi.mock("../src/agents/agent-types.js", () => ({
 *     getAgentConfig: agentConfigMock(),
 *     ...
 *   }));
 */
export function agentConfigMock() {
  return vi.fn((type: string) => ({
    name: type,
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    description: `Test agent ${type}`,
    systemPrompt: "test",
  }));
}
