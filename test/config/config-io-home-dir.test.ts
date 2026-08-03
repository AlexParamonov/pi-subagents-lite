/**
 * config-io-home-dir.test.ts — Verifies CONFIG_DIR uses getAgentDir()
 * instead of process.env.HOME, so it works on Windows.
 */

import { describe, it, expect, vi, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Per-run temp dir: loadConfig() must never read a real user config file,
// on any OS. A fresh mkdtemp directory guarantees the defaults test below
// does not depend on the machine's filesystem state.
const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-config-"));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { CUSTOM_PROMPT_PATH, loadConfig } = await import("../../src/config/config-io.js");

afterAll(() => {
  rmSync(MOCK_AGENT_DIR, { recursive: true, force: true });
});

describe("config-io home directory resolution", () => {
  it("uses getAgentDir() for CUSTOM_PROMPT_PATH", () => {
    expect(CUSTOM_PROMPT_PATH).toBe(join(MOCK_AGENT_DIR, "subagents-lite-prompt.md"));
  });
});

describe("loadConfig defaults", () => {
  it("bakes in widget and watchdog defaults when no config file exists", () => {
    // The temp dir is freshly created and empty, so loadConfig returns
    // the full DEFAULT_AGENT merge — guards against defaults being dropped.
    const config = loadConfig();
    expect(config.agent.widgetMaxLines).toBe(12);
    expect(config.agent.toolTimeoutMinutes).toBe(45);
    expect(config.agent.idleTimeoutMinutes).toBe(45);
  });
});
