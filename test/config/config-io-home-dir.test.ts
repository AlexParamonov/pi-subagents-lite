/**
 * config-io-home-dir.test.ts — Verifies CONFIG_DIR uses getAgentDir()
 * instead of process.env.HOME, so it works on Windows.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

// Windows-style fixture: the fix targets Windows, where HOME may be unset
// and paths contain backslashes and spaces.
const MOCK_AGENT_DIR = "C:\\Users\\Pi User\\.pi\\agent";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { CUSTOM_PROMPT_PATH } = await import("../../src/config/config-io.js");

describe("config-io home directory resolution", () => {
  it("uses getAgentDir() for CUSTOM_PROMPT_PATH", () => {
    expect(CUSTOM_PROMPT_PATH).toBe(join(MOCK_AGENT_DIR, "subagents-lite-prompt.md"));
  });
});
