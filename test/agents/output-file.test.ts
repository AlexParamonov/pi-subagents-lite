/**
 * output-file.test.ts — Tests for output-file.ts.
 *
 * Covers both the AgentOutputLog lifecycle class and the lower-level
 * functions (createOutputFilePath, writeInitialEntry, streamToOutputFile).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
  AgentOutputLog,
} from "../../src/agents/output-file.js";

const testAgentId = "test-agent-123";
const fixture = tempDirFixture();

beforeEach(() => fixture.setup());
afterEach(() => fixture.teardown());

// --- createOutputFilePath ---

describe("createOutputFilePath", () => {
  it("returns <baseDir>/<agentId>.log", () => {
    const dir = fixture.getDir();
    const result = createOutputFilePath(testAgentId, dir);
    expect(result).toBe(`${dir}/${testAgentId}.log`);
  });

  it("creates the directory with 0o700 permissions", () => {
    const dir = fixture.getDir() + "/sub";
    createOutputFilePath(testAgentId, dir);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o077).toBeLessThanOrEqual(0);
  });

  it("returns consistent path for same agentId", () => {
    const dir = fixture.getDir();
    expect(createOutputFilePath("same-id", dir)).toBe(createOutputFilePath("same-id", dir));
  });
});

// --- writeInitialEntry ---
describe("writeInitialEntry", () => {
  it("writes a [USER] line with ISO timestamp and prompt text", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const content = readFileSync(path, "utf-8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(content).toContain("[USER]");
    expect(content).toContain("explore auth module");
  });
});

// --- streamToOutputFile ---

describe("streamToOutputFile", () => {
  function setupSession(messages: any[]) {
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
    return session;
  }

  it("appends TOOL lines when session events fire", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const session = setupSession([
      { role: "user", content: "explore auth module" },
      { role: "assistant", content: [{ type: "toolUse", name: "read", input: { path: "src/auth.ts" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toMatch(/\[TOOL\] read\("src\/auth\.ts"\)/);
    cleanup();
  });

  it("writes TOOL lines with pi-ai ToolCall format (arguments key)", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "check imports");

    const session = setupSession([
      { role: "user", content: "check imports" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_123", name: "grep", arguments: { pattern: "import", path: "./src" } }],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] grep("import", "' + "./src" + '")');
    cleanup();
  });

  it("appends DONE line on cleanup", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "explore auth module");

    const session = setupSession([]);
    const cleanup = streamToOutputFile(session, path, {
      turnCount: 3,
      toolUseCount: 5,
      totalTokens: 12400,
    });
    cleanup();

    const lastLine = readFileSync(path, "utf-8").trim().split("\n").at(-1)!;
    expect(lastLine).toMatch(/\[DONE\]/);
    expect(lastLine).toContain("3 turns");
    expect(lastLine).toContain("5 tool uses");
    expect(lastLine).toContain("12.4k tokens");
    expect(lastLine).not.toContain("$");
  });

  it("does not include cost in DONE line", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "check no cost");

    const session = setupSession([]);
    const cleanup = streamToOutputFile(session, path, {
      turnCount: 2,
      toolUseCount: 3,
      totalTokens: 15000,
    });
    cleanup();

    const lastLine = readFileSync(path, "utf-8").trim().split("\n").at(-1)!;
    expect(lastLine).not.toContain("$");
  });

  it("appends [ASSISTANT] lines for text messages", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] },
    ]);
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

    const session = setupSession([
      { role: "user", content: "think about this" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason step by step..." },
          { type: "text", text: "Here is the answer." },
        ],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toMatch(/\[THINKING\]/);
    expect(content).toContain("Let me reason step by step...");
    expect(content).toMatch(/\[ASSISTANT\]/);
    cleanup();
  });

  it("marks redacted thinking blocks", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "sensitive");

    const session = setupSession([
      { role: "user", content: "sensitive" },
      { role: "assistant", content: [{ type: "thinking", thinking: "REDACTED", redacted: true }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("[redacted]");
    expect(content).not.toContain("REDACTED");
    cleanup();
  });

  it("returns a cleanup function that unsubscribes", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([{ role: "user", content: "test" }]);
    const cleanup = streamToOutputFile(session, path);
    cleanup();

    expect(session._getListeners().length).toBe(0);
  });

  // Compaction handling

  it("flushes unwritten messages on compaction_start", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "message 1" }] },
      { role: "assistant", content: [{ type: "text", text: "message 2" }] },
    ]);
    const cleanup = streamToOutputFile(session, path);

    // Don't fire turn_end - messages 1 and 2 are unwritten
    // Fire compaction_start - should flush unwritten messages
    session._fireCompactionStart("threshold");

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("message 1");
    expect(content).toContain("message 2");
    cleanup();
  });

  it("re-anchors writtenCount after successful compaction", async () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "pre-compaction message" }] },
    ]);
    const cleanup = streamToOutputFile(session, path);

    session._fireTurnEnd();

    // Simulate compaction by replacing messages with shorter array
    const compactedMessages = [
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "summary" }] },
      { role: "assistant", content: [{ type: "text", text: "post-compaction message" }] },
    ];
    Object.defineProperty(session, "messages", { get: () => compactedMessages, configurable: true });

    session._fireCompactionEnd({
      reason: "threshold",
      aborted: false,
      result: { tokensBefore: 10000, tokensAfter: 2000 },
    });

    // Wait for microtask to complete (re-anchoring writtenCount)
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    // Fire turn_end to trigger flush of post-compaction message
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("pre-compaction message");
    expect(content).toContain("summary");
    expect(content).toContain("post-compaction message");
    cleanup();
  });

  it("does not re-anchor on aborted compaction", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "test");

    const session = setupSession([
      { role: "user", content: "test" },
      { role: "assistant", content: [{ type: "text", text: "pre-compaction message" }] },
    ]);
    const cleanup = streamToOutputFile(session, path);

    session._fireTurnEnd();

    // Simulate compaction (aborted - messages shouldn't change)
    session._fireCompactionEnd({ reason: "threshold", aborted: true, result: undefined });

    // Fire turn_end - should not crash or skip messages
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("pre-compaction message");
    cleanup();
  });
  // Tool argument summarization

  it("summarizes write tool with path and content size", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "create file");

    const session = setupSession([
      { role: "user", content: "create file" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "write", arguments: { path: "/tmp/test.txt", content: "hello world\nline2" } },
        ],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] write("/tmp/test.txt", 17 chars)');
    cleanup();
  });

  it("summarizes edit tool with path and edit count", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "edit file");

    const session = setupSession([
      { role: "user", content: "edit file" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "edit",
            arguments: {
              path: "src/file.ts",
              edits: [
                { oldText: "foo", newText: "bar" },
                { oldText: "x", newText: "y" },
              ],
            },
          },
        ],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] edit("src/file.ts", 2 edits)');
    cleanup();
  });

  it("summarizes bash tool without heredoc", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run command");

    const session = setupSession([
      { role: "user", content: "run command" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run build" } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] bash("npm run build")');
    cleanup();
  });

  it("summarizes bash tool stripping heredoc", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run heredoc");

    const session = setupSession([
      { role: "user", content: "run heredoc" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "cat <<EOF\nline1\nline2\nEOF" } }],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] bash("cat")');
    cleanup();
  });

  it("truncates long bash commands", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "long command");

    const session = setupSession([
      { role: "user", content: "long command" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "a".repeat(400) } }] },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain('[TOOL] bash("');
    expect(content).toContain("…");
    cleanup();
  });

  it("summarizes rg tool like grep", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "search with rg");

    const session = setupSession([
      { role: "user", content: "search with rg" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "rg", arguments: { pattern: "function", path: "./src" } }],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain('[TOOL] rg("function", "');
    cleanup();
  });

  it("uses default formatting for unknown tools", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "custom tool");

    const session = setupSession([
      { role: "user", content: "custom tool" },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "customTool", arguments: { key1: "value1", key2: "value2" } }],
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain('[TOOL] customTool {"key1":"value1","key2":"value2"}');
    cleanup();
  });

  // Tool result handling

  it("logs short tool results as [TOOL_RESULT] lines", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "run read");

    const session = setupSession([
      { role: "user", content: "run read" },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "file content here" }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
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

    const session = setupSession([
      { role: "user", content: "big output" },
      {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "x".repeat(600) }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("[TOOL_RESULT] bash: 600 chars");
    expect(content).not.toContain("x".repeat(600));
    cleanup();
  });

  it("handles tool result with exactly 500 chars as short (no truncation)", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "exactly 500");

    const exactContent = "y".repeat(500);
    const session = setupSession([
      { role: "user", content: "exactly 500" },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: exactContent }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain(exactContent);
    cleanup();
  });

  it("handles tool result with 501 chars as long (truncated)", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "501 chars");

    const session = setupSession([
      { role: "user", content: "501 chars" },
      {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "z".repeat(501) }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8")).toContain("[TOOL_RESULT] bash: 501 chars");
    cleanup();
  });

  it("skips tool result with empty content", () => {
    const dir = fixture.getDir();
    const path = createOutputFilePath(testAgentId, dir);
    writeInitialEntry(path, "empty result");

    const session = setupSession([
      { role: "user", content: "empty result" },
      {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "   " }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    const cleanup = streamToOutputFile(session, path);
    session._fireTurnEnd();

    expect(readFileSync(path, "utf-8").trim().split("\n").length).toBe(1);
    cleanup();
  });
});

// --- AgentOutputLog ---

describe("AgentOutputLog", () => {
  it("creates the output file path and writes initial [USER] entry", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "explore auth", dir);
    expect(log.path).toBe(`${dir}/${testAgentId}.log`);
    expect(readFileSync(log.path, "utf-8")).toMatch(/\[USER\]\s+explore auth/);
  });

  it("subscribes to session events on attach", () => {
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
    Object.defineProperty(session, "messages", {
      get: () => [
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "text", text: "Hello, I am ready." }] },
      ],
      configurable: true,
    });
    log.attach(session);
    session._fireTurnEnd();

    const content = readFileSync(log.path, "utf-8");
    expect(content).toContain("[ASSISTANT]");
    expect(content).toContain("Hello, I am ready.");
  });

  it("writes DONE line with final stats on finalize", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => [], configurable: true });
    log.attach(session);
    log.finalize({ turnCount: 3, toolUseCount: 5, totalTokens: 12400 });

    const lastLine = readFileSync(log.path, "utf-8").trim().split("\n").at(-1)!;
    expect(lastLine).toMatch(/\[DONE\]/);
    expect(lastLine).toContain("3 turns");
    expect(lastLine).not.toContain("$");
  });

  it("flushes remaining messages before writing DONE", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", {
      get: () => [
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "text", text: "Final answer." }] },
      ],
      configurable: true,
    });
    log.attach(session);
    log.finalize({ turnCount: 1, toolUseCount: 0, totalTokens: 500 });

    const content = readFileSync(log.path, "utf-8");
    expect(content).toContain("Final answer.");
    expect(content.trim().split("\n").at(-1)!).toContain("[DONE]");
  });

  it("unsubscribes from session on finalize", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    const session = createMockSession() as any;
    Object.defineProperty(session, "messages", { get: () => [], configurable: true });
    log.attach(session);
    log.finalize({ turnCount: 0, toolUseCount: 0, totalTokens: 0 });
    expect(session._getListeners().length).toBe(0);
  });

  it("does not throw when finalize is called without attach", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    expect(() => log.finalize({ turnCount: 0, toolUseCount: 0, totalTokens: 0 })).not.toThrow();
  });

  it("exposes the output file path as a readonly property", () => {
    const dir = fixture.getDir();
    const log = new AgentOutputLog(testAgentId, "test", dir);
    expect(log.path).toBe(`${dir}/${testAgentId}.log`);
  });
});
