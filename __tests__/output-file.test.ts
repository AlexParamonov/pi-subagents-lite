/**
 * output-file.test.ts — Tests for human-readable output logging.
 *
 * Tests focus on:
 *   - Path construction (/tmp/pi-agent-outputs/<agentId>.log)
 *   - Initial entry format ([USER] with timestamp)
 *   - Streaming session events to the output file
 *   - Final DONE line on cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cleanupOutputFiles, createMockSession } from "./fixtures";

// --- Module under test ---
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../extensions/output-file.js";

describe("output-file", () => {
  const testAgentId = "test-agent-123";

  beforeEach(() => cleanupOutputFiles());
  afterEach(() => cleanupOutputFiles());

  describe("createOutputFilePath", () => {
    it("returns /tmp/pi-agent-outputs/<agentId>.log", () => {
      const result = createOutputFilePath(testAgentId);
      expect(result).toBe(`/tmp/pi-agent-outputs/${testAgentId}.log`);
    });

    it("creates the directory with 0o700 permissions", () => {
      const result = createOutputFilePath(testAgentId);
      expect(existsSync("/tmp/pi-agent-outputs")).toBe(true);
      // Verify directory was created
      const stat = statSync("/tmp/pi-agent-outputs");
      expect(stat.isDirectory()).toBe(true);
      // Verify no group/other permissions (0o700 = owner rwx only)
      expect(stat.mode & 0o077).toBe(0);
    });

    it("returns consistent path for same agentId", () => {
      const a = createOutputFilePath("same-id");
      const b = createOutputFilePath("same-id");
      expect(a).toBe(b);
    });
  });

  describe("writeInitialEntry", () => {
    it("writes a [USER] line to the file", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "explore auth module");

      const content = readFileSync(path, "utf-8");
      expect(content).toMatch(/^[\dT:Z.-]+\s+\[USER\]\s+explore auth module\n$/);
    });

    it("includes an ISO timestamp at the start of the line", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "hello");

      const content = readFileSync(path, "utf-8").trim();
      // Should start with ISO-like timestamp
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes the [USER] tag", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "test");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[USER]");
    });

    it("includes the prompt text", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "do something useful");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("do something useful");
    });
  });

  describe("streamToOutputFile", () => {
    it("appends TOOL lines when session events fire", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "explore auth module");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "explore auth module" };
      const toolMsg = { role: "assistant", content: [{ type: "toolUse", name: "read", input: { path: "src/auth.ts" } }] };
      const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Found the auth module..." }] };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg, assistantMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]).toContain("[USER]");
      // Should show compact read("src/auth.ts") instead of bare read
      expect(content).toMatch(/\[TOOL\] read\("src\/auth\.ts"\)/);

      cleanup();
    });

    it("writes TOOL lines with pi-ai ToolCall format (arguments key)", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "check imports");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "check imports" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call_123",
          name: "grep",
          arguments: { pattern: "import", path: "./src" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      // Multi-arg shows as JSON
      expect(content).toMatch(/\[TOOL\] grep \{"pattern":"import","path":"\.\/src"\}$/m);

      cleanup();
    });

    it("truncates long single-arg values", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "read long file");

      const longPath = "a".repeat(300);
      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "read long file" };
      const toolMsg = {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: longPath } }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toMatch(/\[TOOL\] read\("/);
      expect(content).toContain("...");

      cleanup();
    });

    it("appends DONE line on cleanup", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "explore auth module");

      const session = createMockSession() as any;
      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path, {
        turnCount: 3,
        toolUseCount: 5,
        totalTokens: 12400,
      });

      cleanup();

      const content = readFileSync(path, "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toMatch(/^[\dT:Z.-]+\s+\[DONE\]/);
      expect(lastLine).toContain("3 turns");
      expect(lastLine).toContain("5 tool uses");
      expect(lastLine).toContain("12.4k tokens");
    });

    it("appends [ASSISTANT] lines for text messages", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "test");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "test" };
      const assistantMsg = { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, assistantMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[ASSISTANT]");
      expect(content).toContain("Hello, I am ready.");

      cleanup();
    });

    it("logs thinking blocks as [THINKING] lines", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "think about this");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "think about this" };
      const assistantMsg = {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason step by step..." },
          { type: "text", text: "Here is the answer." },
        ],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, assistantMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toMatch(/\[THINKING\]/);
      expect(content).toContain("Let me reason step by step...");
      expect(content).toMatch(/\[ASSISTANT\]/);
      expect(content).toContain("Here is the answer.");

      cleanup();
    });

    it("marks redacted thinking blocks", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "sensitive");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "sensitive" };
      const assistantMsg = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "REDACTED", redacted: true }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, assistantMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toMatch(/\[THINKING\]/);
      expect(content).toContain("[redacted]");
      expect(content).not.toContain("REDACTED");

      cleanup();
    });

    it("returns a cleanup function that unsubscribes", () => {
      const path = createOutputFilePath(testAgentId);
      writeInitialEntry(path, "test");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "test" };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      cleanup();

      expect(session._getListeners().length).toBe(0);
    });
  });
});
