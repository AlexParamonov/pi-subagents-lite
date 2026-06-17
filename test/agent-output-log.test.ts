/**
 * agent-output-log.test.ts — Tests for AgentOutputLog lifecycle class.
 *
 * Tests focus on:
 *   - Constructor: creates path + writes initial [USER] entry
 *   - attach(): subscribes session stream to output file
 *   - finalize(): flushes, writes [DONE] line with final stats, unsubscribes
 *   - readonly path property
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createMockSession, tempDirFixture } from "./fixtures";

// --- Module under test ---
import { AgentOutputLog } from "../src/agents/output-file.js";

describe("AgentOutputLog", () => {
  const testAgentId = "test-agent-123";
  const fixture = tempDirFixture();

  beforeEach(() => {
    fixture.setup();
  });
  afterEach(() => {
    fixture.teardown();
  });

  describe("constructor", () => {
    it("creates the output file path", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "explore auth", dir);
      expect(log.path).toBe(`${dir}/${testAgentId}.log`);
    });

    it("writes initial [USER] entry to the file", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "explore auth module", dir);

      const content = readFileSync(log.path, "utf-8");
      expect(content).toMatch(/\[USER\]\s+explore auth module/);
    });

    it("includes an ISO timestamp in the initial entry", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "hello", dir);

      const content = readFileSync(log.path, "utf-8").trim();
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("uses default baseDir when omitted", () => {
      const log = new AgentOutputLog(testAgentId, "test prompt");
      expect(log.path).toBe(`/tmp/pi-agent-outputs/${testAgentId}.log`);
    });
  });

  describe("attach", () => {
    it("subscribes to session events", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      log.attach(session);

      expect(session.subscribe).toHaveBeenCalledTimes(1);
    });

    it("streams messages on turn_end events", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      const initialUserMsg = { role: "user", content: "test" };
      const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, assistantMsg],
        configurable: true,
      });

      log.attach(session);
      session._fireTurnEnd();

      const content = readFileSync(log.path, "utf-8");
      expect(content).toContain("[ASSISTANT]");
      expect(content).toContain("Hello, I am ready.");
    });
  });

  describe("finalize", () => {
    it("writes DONE line with final stats", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      log.attach(session);
      log.finalize({ turnCount: 3, toolUseCount: 5, totalTokens: 12400, cost: 0.024 });

      const content = readFileSync(log.path, "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toMatch(/\[DONE\]/);
      expect(lastLine).toContain("3 turns");
      expect(lastLine).toContain("5 tool uses");
      expect(lastLine).toContain("12.4k tokens");
      expect(lastLine).toContain("$0.024");
    });

    it("flushes remaining messages before writing DONE", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      const initialUserMsg = { role: "user", content: "test" };
      const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Final answer." }] };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, assistantMsg],
        configurable: true,
      });

      log.attach(session);
      log.finalize({ turnCount: 1, toolUseCount: 0, totalTokens: 500, cost: 0 });

      const content = readFileSync(log.path, "utf-8");
      // Final answer should appear
      expect(content).toContain("[ASSISTANT]");
      expect(content).toContain("Final answer.");
      // DONE line should be last
      const lines = content.trim().split("\n");
      expect(lines[lines.length - 1]).toContain("[DONE]");
    });

    it("unsubscribes from session on finalize", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      log.attach(session);
      log.finalize({ turnCount: 0, toolUseCount: 0, totalTokens: 0, cost: 0 });

      expect(session._getListeners().length).toBe(0);
    });

    it("writes DONE line with zero stats when all zeros passed", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      const session = createMockSession() as any;

      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      log.attach(session);
      log.finalize({ turnCount: 0, toolUseCount: 0, totalTokens: 0, cost: 0 });

      const content = readFileSync(log.path, "utf-8");
      const lastLine = content.trim().split("\n").slice(-1)[0];
      expect(lastLine).toContain("[DONE]");
      expect(lastLine).toContain("0 turns");
      expect(lastLine).toContain("$0.000");
    });

    it("does not throw when finalize is called without attach", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);

      // Should not throw — finalize without attach just writes the DONE line
      expect(() => {
        log.finalize({ turnCount: 0, toolUseCount: 0, totalTokens: 0, cost: 0 });
      }).not.toThrow();
    });
  });

  describe("readonly path", () => {
    it("exposes the output file path as a readonly property", () => {
      const dir = fixture.getDir();
      const log = new AgentOutputLog(testAgentId, "test", dir);
      expect(log.path).toBe(`${dir}/${testAgentId}.log`);
    });
  });
});
