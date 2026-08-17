/**
 * restart-last-agents.test.ts — Tests for findLastAgentCallsFromEntries.
 *
 * The pure function extracts Agent tool calls from the most recent assistant
 * message in session history. The orchestration (skip running, spawn, notify)
 * is tested via menu-debug integration tests.
 */

import { describe, it, expect } from "vitest";
import type { CompactionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { findLastAgentCallsFromEntries } from "../../src/agents/restart-last-agents.js";

/** Build a minimal SessionMessageEntry with typed content blocks. */
function messageEntry(
  id: string,
  role: "user" | "assistant" | "toolResult",
  content: string | unknown[],
): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content,
    },
  } as SessionMessageEntry;
}

function agentToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: "toolCall",
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    name: "Agent",
    arguments: args,
  };
}

function bashToolCall(command: string): ToolCall {
  return {
    type: "toolCall",
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    name: "bash",
    arguments: { command },
  };
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

describe("findLastAgentCallsFromEntries", () => {
  it("returns empty array when no entries exist", () => {
    expect(findLastAgentCallsFromEntries([])).toEqual([]);
  });

  it("returns empty when no assistant messages exist", () => {
    const entries = [messageEntry("u1", "user", [textBlock("hello")])];
    expect(findLastAgentCallsFromEntries(entries)).toEqual([]);
  });

  it("returns empty when assistant messages have no tool calls", () => {
    const entries = [
      messageEntry("u1", "user", [textBlock("hello")]),
      messageEntry("a1", "assistant", [textBlock("I can help")]),
    ];
    expect(findLastAgentCallsFromEntries(entries)).toEqual([]);
  });

  it("returns empty when tool calls are not Agent type", () => {
    const entries = [messageEntry("a1", "assistant", [bashToolCall("ls")])];
    expect(findLastAgentCallsFromEntries(entries)).toEqual([]);
  });

  it("extracts a single Agent tool call from the last assistant message", () => {
    const entries = [
      messageEntry("a1", "assistant", [
        agentToolCall({ prompt: "research topic", agent: "scout", description: "Research the topic" }),
      ]),
    ];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      prompt: "research topic",
      agent: "scout",
      description: "Research the topic",
    });
  });

  it("extracts multiple Agent tool calls from the same assistant message", () => {
    const entries = [
      messageEntry("a1", "assistant", [
        agentToolCall({ prompt: "task one", agent: "scout", description: "Do task one" }),
        agentToolCall({ prompt: "task two", agent: "builder", description: "Do task two" }),
      ]),
    ];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(2);
    expect(result[0].prompt).toBe("task one");
    expect(result[1].prompt).toBe("task two");
  });

  it("ignores non-Agent tool calls in the same message", () => {
    const entries = [
      messageEntry("a1", "assistant", [
        bashToolCall("ls"),
        agentToolCall({ prompt: "do something", description: "Something" }),
        { type: "toolCall", id: "tc-read", name: "read", arguments: { path: "foo.ts" } },
      ]),
    ];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe("do something");
  });

  it("uses only the most recent assistant message with Agent calls", () => {
    const entries = [
      messageEntry("a1", "assistant", [agentToolCall({ prompt: "old task", description: "Old" })]),
      messageEntry("u1", "user", [textBlock("now do this")]),
      messageEntry("a2", "assistant", [textBlock("sure")]),
      messageEntry("u2", "user", [textBlock("and this")]),
      messageEntry("a3", "assistant", [agentToolCall({ prompt: "new task", description: "New" })]),
    ];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe("new task");
  });

  it("skips non-message entries gracefully", () => {
    const compaction: CompactionEntry = {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "old context",
      firstKeptEntryId: "x",
      tokensBefore: 5000,
    };
    const entries = [
      compaction,
      messageEntry("a1", "assistant", [agentToolCall({ prompt: "task", description: "Task" })]),
    ];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0].prompt).toBe("task");
  });

  it("preserves all original arguments from the tool call", () => {
    const args = {
      prompt: "full task",
      agent: "scout",
      description: "Full task desc",
      worktree_path: "/some/path",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: "high",
      run_in_background: true,
      max_turns: 10,
    };
    const entries = [messageEntry("a1", "assistant", [agentToolCall(args)])];
    const result = findLastAgentCallsFromEntries(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(args);
  });

  it("returns empty when assistant content is a plain string", () => {
    const entries = [messageEntry("a1", "assistant", "just text")];
    expect(findLastAgentCallsFromEntries(entries)).toEqual([]);
  });

  it("returns empty when content blocks are malformed", () => {
    const entries = [
      messageEntry("a1", "assistant", [
        null,
        undefined,
        { type: "text" },
        { name: "Agent" }, // missing type field
      ]),
    ];
    expect(findLastAgentCallsFromEntries(entries)).toEqual([]);
  });
});
