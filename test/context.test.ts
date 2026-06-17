/**
 * context.test.ts — Tests for conversation context helpers.
 *
 * Tests focus on:
 *   - extractText: extracting text from content arrays
 *   - buildSnapshotMarkdown: formatting agent messages as markdown
 */

import { describe, it, expect } from "vitest";
import { extractText, buildSnapshotMarkdown } from "../src/prompt/context.js";

/* ------------------------------------------------------------------ */
/*  extractText                                                        */
/* ------------------------------------------------------------------ */

describe("extractText", () => {
  it("extracts text from a simple content array", () => {
    const content = [
      { type: "text", text: "Hello world" },
    ];
    expect(extractText(content)).toBe("Hello world");
  });

  it("joins multiple text blocks with newlines", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];
    expect(extractText(content)).toBe("First line\nSecond line");
  });

  it("filters out non-text blocks", () => {
    const content = [
      { type: "text", text: "Visible" },
      { type: "image", data: "base64...", mimeType: "image/png" },
      { type: "toolCall", id: "tc1", name: "read", arguments: {} },
    ];
    expect(extractText(content)).toBe("Visible");
  });

  it("returns empty string for empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("handles null/undefined text fields", () => {
    const content = [
      { type: "text", text: null },
      { type: "text", text: "Valid" },
    ];
    expect(extractText(content)).toBe("\nValid");
  });
});

/* ------------------------------------------------------------------ */
/*  buildSnapshotMarkdown                                              */
/* ------------------------------------------------------------------ */

describe("buildSnapshotMarkdown", () => {
  it("formats a user message with string content as blockquote", () => {
    const messages = [
      { role: "user", content: "What is the weather?", timestamp: 1000 },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> user: What is the weather?\n");
  });

  it("formats a user message with array content as blockquote", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "What is the weather?" }],
        timestamp: 1000,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> user: What is the weather?\n");
  });

  it("formats an assistant message as regular markdown text", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "The weather is sunny." }],
        timestamp: 2000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("The weather is sunny.\n");
  });

  it("formats assistant message with thinking content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me calculate..." },
          { type: "text", text: "The answer is 42." },
        ],
        timestamp: 2000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("The answer is 42.\n");
  });

  it("formats tool result with summarized args from assistant toolCall (bash)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -la" } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt\nfile2.txt" }],
        isError: false,
        timestamp: 3000,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> Bash: \"ls -la\"\n");
  });

  it("formats tool result with summarized args from assistant toolCall (read)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "src/index.ts" } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
        timestamp: 3001,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> Read: \"src/index.ts\"\n");
  });

  it("formats tool result with summarized args from assistant toolCall (write)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc3", name: "write", arguments: { file_path: "/tmp/test.txt", content: "hello\nworld" } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc3",
        toolName: "write",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3002,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> Write: \"/tmp/test.txt\", 11 chars\n");
  });

  it("formats tool result with summarized args from assistant toolCall (edit)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc4", name: "edit", arguments: { path: "src/file.ts", edits: [{ oldText: "foo", newText: "bar" }] } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc4",
        toolName: "edit",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3003,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> Edit: \"src/file.ts\", 1 edits\n");
  });

  it("formats tool result with summarized args from assistant toolCall (grep)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc5", name: "grep", arguments: { pattern: "import", path: "./src" } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc5",
        toolName: "grep",
        content: [{ type: "text", text: "matches" }],
        isError: false,
        timestamp: 3004,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> Grep: \"import\", \"./src\"\n");
  });

  it("shows tool name only when no matching toolCall args found", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "tc6",
        toolName: "bash",
        content: [{ type: "text", text: "file.txt\nfile2.txt\n" }],
        isError: false,
        timestamp: 3005,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    // No assistant message with toolCall, so just show the tool name
    expect(result).toBe("> Bash\n");
  });

  it("handles multiple messages in sequence", () => {
    const messages = [
      { role: "user", content: "List files", timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running ls..." },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "src/\ntest/" }],
        isError: false,
        timestamp: 3000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the files." }],
        timestamp: 4000,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe([
      "> user: List files",
      "",
      "Running ls...",
      "",
      "> Bash: \"ls\"",
      "",
      "Here are the files.",
      "",
    ].join("\n"));
  });

  it("returns empty string for empty messages array", () => {
    expect(buildSnapshotMarkdown([])).toBe("");
  });

  it("skips custom/unrecognized message roles", () => {
    const messages = [
      { role: "user", content: "Hello", timestamp: 1000 },
      { role: "custom_notification", content: "something" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "src/file.ts", edits: [{ oldText: "a", newText: "b" }] } }],
        timestamp: 1500,
      },
      { role: "toolResult", toolCallId: "tc1", toolName: "edit", content: [], isError: false, timestamp: 2000 },
    ];
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("> user: Hello\n\n> Edit: \"src/file.ts\", 1 edits\n");
  });

  it("handles assistant message with no text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/test" } },
        ],
        timestamp: 1000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4",
      },
    ];
    // Only text blocks are extracted; tool calls produce no text
    const result = buildSnapshotMarkdown(messages);
    expect(result).toBe("");
  });

  it("uses default tool name for toolResult when toolName is missing", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 1000,
      },
    ];
    const result = buildSnapshotMarkdown(messages);
    // No toolName, defaults to "tool"; no matching toolCall args
    expect(result).toBe("> Tool\n");
  });
});
