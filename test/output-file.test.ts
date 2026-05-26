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
import { createMockSession, tempDirFixture } from "./fixtures";

// --- Module under test ---
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../src/output-file.js";

describe("output-file", () => {
  const testAgentId = "test-agent-123";
  const fixture = tempDirFixture();

  beforeEach(() => {
    fixture.setup();
  });
  afterEach(() => {
    fixture.teardown();
  });

    describe("createOutputFilePath", () => {
    it("returns <baseDir>/<agentId>.log", () => {
      const dir = fixture.getDir();
      const result = createOutputFilePath(testAgentId, dir);
      expect(result).toBe(`${dir}/${testAgentId}.log`);
    });

    it("creates the directory with 0o700 permissions", () => {
      // Use a subdirectory that doesn't exist yet so createOutputFilePath
      // is responsible for creating it (avoids fixture.setup() pre-creating it)
      const dir = fixture.getDir() + "/sub";
      const result = createOutputFilePath(testAgentId, dir);
      expect(existsSync(dir)).toBe(true);
      // Verify directory was created
      const stat = statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      // Verify no group/other permissions (0o700 = owner rwx only)
      // mkdirSync mode is masked by umask, so at minimum 0o700 & ~umask
      expect(stat.mode & 0o077).toBeLessThanOrEqual(0);
    });

    it("returns consistent path for same agentId", () => {
      const dir = fixture.getDir();
      const a = createOutputFilePath("same-id", dir);
      const b = createOutputFilePath("same-id", dir);
      expect(a).toBe(b);
    });

    it("defaults to /tmp/pi-agent-outputs when baseDir is omitted", () => {
      const result = createOutputFilePath("test");
      expect(result).toBe("/tmp/pi-agent-outputs/test.log");
    });
  });

  describe("writeInitialEntry", () => {
    it("writes a [USER] line to the file", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "explore auth module");

      const content = readFileSync(path, "utf-8");
      expect(content).toMatch(/^[\dT:Z.-]+\s+\[USER\]\s+explore auth module\n$/);
    });

    it("includes an ISO timestamp at the start of the line", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "hello");

      const content = readFileSync(path, "utf-8").trim();
      // Should start with ISO-like timestamp
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("includes the [USER] tag", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[USER]");
    });

    it("includes the prompt text", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "do something useful");

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("do something useful");
    });
  });

  describe("streamToOutputFile", () => {
    it("appends TOOL lines when session events fire", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      // grep is summarized as grep("pattern", "/path")
      expect(content).toContain('[TOOL] grep("import", "' + './src' + '")');

      cleanup();
    });

    it("handles long paths with read tool", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      // read shows full path without truncation
      expect(content).toMatch(/\[TOOL\] read\(".*"\)/);
      expect(content).toContain(longPath);

      cleanup();
    });

    it("appends DONE line on cleanup", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
        cost: 0.024,
      });

      cleanup();

      const content = readFileSync(path, "utf-8");
      const lines = content.trim().split("\n");
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toMatch(/^[\dT:Z.-]+\s+\[DONE\]/);
      expect(lastLine).toContain("3 turns");
      expect(lastLine).toContain("5 tool uses");
      expect(lastLine).toContain("12.4k tokens");
      expect(lastLine).toContain("$0.024");
    });

    it("appends DONE line with zero cost for free models", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "explore with local model");

      const session = createMockSession() as any;
      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path, {
        turnCount: 1,
        toolUseCount: 2,
        totalTokens: 500,
        cost: 0,
      });

      cleanup();

      const content = readFileSync(path, "utf-8");
      const lastLine = content.trim().split("\n").slice(-1)[0];
      expect(lastLine).toContain("$0.000");
    });

    it("formats cost as $X.XXX with three decimal places", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "check cost format");

      const session = createMockSession() as any;
      Object.defineProperty(session, "messages", {
        get: () => [],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path, {
        turnCount: 2,
        toolUseCount: 3,
        totalTokens: 15000,
        cost: 0.123456,
      });

      cleanup();

      const content = readFileSync(path, "utf-8");
      const lastLine = content.trim().split("\n").slice(-1)[0];
      // Should round to 3 decimal places
      expect(lastLine).toContain("$0.123");
      expect(lastLine).not.toContain("$0.123456");
    });

    it("appends [ASSISTANT] lines for text messages", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
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

    // ------------------------------------------------------------------ //
    //  Tool argument summarization                                       //
    // ------------------------------------------------------------------ //

    it("summarizes write tool with path and content size", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "create file");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "create file" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "write",
          arguments: { file_path: "/tmp/test.txt", content: "hello world\nline2" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] write("/tmp/test.txt", 17 chars)');

      cleanup();
    });

    it("summarizes edit tool with path and edit count", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "edit file");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "edit file" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "edit",
          arguments: { path: "src/file.ts", edits: [{ oldText: "foo", newText: "bar" }, { oldText: "x", newText: "y" }] },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] edit("src/file.ts", 2 edits)');

      cleanup();
    });

    it("summarizes bash tool without heredoc", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "run command");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "run command" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "bash",
          arguments: { command: "npm run build" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] bash("npm run build")');

      cleanup();
    });

    it("summarizes bash tool stripping heredoc", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "run heredoc");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "run heredoc" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "bash",
          arguments: { command: "cat <<EOF\nline1\nline2\nEOF" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] bash("cat")');

      cleanup();
    });

    it("truncates long bash commands", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "long command");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "long command" };
      const longCmd = "a".repeat(150);
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "bash",
          arguments: { command: longCmd },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] bash("');
      expect(content).toContain("…");
      // Should be truncated to 100 chars + ellipsis
      expect(content).not.toContain(longCmd);

      cleanup();
    });

    it("summarizes rg tool like grep", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "search with rg");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "search with rg" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "rg",
          arguments: { pattern: "function", path: "./src" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain('[TOOL] rg("function", "');
      expect(content).toContain('/src');

      cleanup();
    });

    it("uses default formatting for unknown tools", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "custom tool");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "custom tool" };
      const toolMsg = {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "customTool",
          arguments: { key1: "value1", key2: "value2" },
        }],
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, toolMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      // Non-heavy tools show JSON args
      expect(content).toContain('[TOOL] customTool {"key1":"value1","key2":"value2"}');

      cleanup();
    });

    // ------------------------------------------------------------------ //
    //  Tool result handling                                              //
    // ------------------------------------------------------------------ //

    it("logs short tool results as [TOOL_RESULT] lines", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "run read");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "run read" };
      const resultMsg = {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "file content here" }],
        isError: false,
        timestamp: Date.now(),
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, resultMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[TOOL_RESULT]");
      expect(content).toContain("file content here");

      cleanup();
    });

    it("truncates long tool results with summary line", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "big output");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "big output" };
      const longContent = "x".repeat(600);
      const resultMsg = {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: longContent }],
        isError: false,
        timestamp: Date.now(),
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, resultMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[TOOL_RESULT] bash: 600 chars");
      // Full content should NOT appear
      expect(content).not.toContain(longContent);

      cleanup();
    });

    it("handles tool result with exactly 500 chars as short (no truncation)", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "exactly 500");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "exactly 500" };
      const exactContent = "y".repeat(500);
      const resultMsg = {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: exactContent }],
        isError: false,
        timestamp: Date.now(),
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, resultMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      // Exactly 500 chars should show full content (not truncated)
      expect(content).toContain(exactContent);
      expect(content).not.toContain("[TOOL_RESULT] read: 500 chars");

      cleanup();
    });

    it("handles tool result with 501 chars as long (truncated)", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "501 chars");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "501 chars" };
      const exactContent = "z".repeat(501);
      const resultMsg = {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: exactContent }],
        isError: false,
        timestamp: Date.now(),
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, resultMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[TOOL_RESULT] bash: 501 chars");
      expect(content).not.toContain(exactContent);

      cleanup();
    });

    it("skips tool result with empty content", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "empty result");

      const session = createMockSession() as any;
      const initialUserMsg = { role: "user", content: "empty result" };
      const resultMsg = {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "   " }],
        isError: false,
        timestamp: Date.now(),
      };
      Object.defineProperty(session, "messages", {
        get: () => [initialUserMsg, resultMsg],
        configurable: true,
      });

      const cleanup = streamToOutputFile(session, path);
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      // Only the initial user message should be present
      expect(content.trim().split("\n").length).toBe(1);

      cleanup();
    });
  });
});
