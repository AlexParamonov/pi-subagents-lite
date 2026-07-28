/**
 * config-io-home-dir.test.ts — Verifies CONFIG_DIR uses getAgentDir()
 * instead of process.env.HOME, so it works on Windows.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/mock-home/.pi/agent",
}));

// Import after mock is set up
const { CUSTOM_PROMPT_PATH } = await import("../../src/config/config-io.js");

describe("config-io home directory resolution", () => {
  it("uses getAgentDir() for CUSTOM_PROMPT_PATH", () => {
    expect(CUSTOM_PROMPT_PATH).toBe("/mock-home/.pi/agent/subagents-lite-prompt.md");
  });
});
