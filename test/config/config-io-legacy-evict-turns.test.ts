/**
 * config-io-legacy-evict-turns.test.ts — US-15: a config file carrying the
 * removed `finishedEvictTurns` key loads and normalizes without error, with
 * the legacy key stripped and no other keys touched (ADR-0006).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Per-run temp dir: loadConfig() must never read a real user config file.
const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-legacy-config-"));
const CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { loadConfig } = await import("../../src/config/config-io.js");

afterAll(() => {
  rmSync(MOCK_AGENT_DIR, { recursive: true, force: true });
});

describe("loadConfig with a legacy finishedEvictTurns key", () => {
  beforeAll(() => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        agent: {
          forceBackground: true,
          finishedRetentionMinutes: 3,
          finishedEvictTurns: 7,
        },
      }),
    );
  });

  it("loads and normalizes without error, preserving defaults and loaded values", () => {
    expect(() => loadConfig()).not.toThrow();
    const config = loadConfig();
    // Defaults are still merged for keys the file does not carry.
    expect(config.agent.graceTurns).toBe(6);
    // Loaded values still win for surviving keys.
    expect(config.agent.finishedRetentionMinutes).toBe(3);
  });

  it("strips the legacy key without touching other keys", () => {
    const config = loadConfig();
    expect("finishedEvictTurns" in config.agent).toBe(false);
    expect(config.agent.forceBackground).toBe(true);
  });
});
