/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: /tmp/pi-agent-outputs/<agentId>.log
 * Append-only, human-readable, supports `tail -f`.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./usage.js";
import { summarizeToolArgs } from "../ui/format.js";


/** Find the last sentence boundary in text. Returns the index of the
 * terminal punctuation character, or -1 if none found. */
function findLastSentenceBoundary(text: string): number {
  // Search backward for the most recent sentence-ending punctuation
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if ([".", "!", "?", ",", "\n"].includes(ch)) {
      return i;
    }
  }
  return -1;
}

/** Format the [DONE] summary line with final stats. */
function formatDoneLine(stats: { turnCount: number; toolUseCount: number; totalTokens: number; cost: number }): string {
  const tokensStr = `${formatTokens(stats.totalTokens)} tokens`;
  const costStr = `$${stats.cost.toFixed(3)}`;
  return `${timestamp()} [DONE] ${stats.turnCount} turns, ${stats.toolUseCount} tool uses, ${tokensStr}, ${costStr}\n`;
}
/** Max content length for full tool result display — longer results get a summary line. */
const MAX_TOOL_RESULT_DISPLAY_LENGTH = 500;

/** Get an ISO 8601 timestamp string suitable for log output. */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Create the output file path for an agent.
 * Default path: /tmp/pi-agent-outputs/<agentId>.log
 * Ensures the parent directory exists with 0o700 permissions.
 *
 * @param baseDir - Optional base directory (defaults to /tmp/pi-agent-outputs).
 *                    Provided for testability; production callers omit it.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const dir = baseDir ?? "/tmp/pi-agent-outputs";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${agentId}.log`);
}

/**
 * Write the initial user prompt entry to the output file.
 * Format: <ISO timestamp> [USER] <prompt>
 */
export function writeInitialEntry(
  path: string,
  prompt: string,
): void {
  const line = `${timestamp()} [USER] ${prompt}\n`;
  writeFileSync(path, line, "utf-8");
}

/**
 * Safe append — silently ignores write errors.
 * Used for best-effort output file writes that must never throw.
 */
function safeAppend(path: string, content: string): void {
  try { appendFileSync(path, content, "utf-8"); } catch { /* ignore write errors */ }
}

/** Split text into non-empty lines, prefixing each with a timestamp and role tag. */
function splitAndPrefix(text: string, role: string): string {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => `${timestamp()} [${role}] ${l}\n`)
    .join("");
}

/** Format a toolUse/toolCall content item as a single log line. */
function formatToolItem(item: Record<string, unknown>): string {
  const name = (item.name ?? item.toolName ?? "unknown") as string;
  // pi-ai ToolCall uses `arguments`, legacy/anthropic format uses `input`
  const rawArgs = (item.arguments ?? item.input) as Record<string, unknown> | undefined;
  const argsStr = summarizeToolArgs(name, rawArgs);
  return `${timestamp()} [TOOL] ${name}${argsStr}\n`;
}

/** Extract text from a user message's content (string or array of items). */
function extractUserText(content: string | ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => String(c.text ?? "")).join("\n");
  }
  return "";
}

/**
 * Format a tool result message as log line(s), truncating if content is too long.
 *
 * - If content length ≤ MAX_TOOL_RESULT_DISPLAY_LENGTH chars: each line is prefixed with [TOOL_RESULT]
 * - If content length > MAX_TOOL_RESULT_DISPLAY_LENGTH chars: single summary line `[TOOL_RESULT] <toolName>: <N> chars`
 */
function formatToolResult(toolName: string, content: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!content || !Array.isArray(content)) return "";

  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (text.length > MAX_TOOL_RESULT_DISPLAY_LENGTH) {
    return `${timestamp()} [TOOL_RESULT] ${toolName}: ${text.length} chars\n`;
  }

  if (!text.trim()) return "";

  return splitAndPrefix(text, "TOOL_RESULT");
}

/**
 * Format a single message content item as log lines.
 * Handles text, toolUse/toolCall, and thinking content.
 */
function formatMessageLine(
  role: "ASSISTANT" | "TOOL" | "USER",
  content: string | ReadonlyArray<Record<string, unknown>> | undefined,
  skipThinkingCount: number = 0,
): string {
  if (typeof content === "string") {
    return splitAndPrefix(content, role);
  }

  if (Array.isArray(content)) {
    let thinkingSkipped = 0;
    return content
      .map((item) => {
        if (item.type === "text" && typeof item.text === "string") {
          return splitAndPrefix(item.text, role);
        }
        if (item.type === "toolUse" || item.type === "toolCall") {
          return formatToolItem(item);
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
          if (thinkingSkipped < skipThinkingCount) {
            thinkingSkipped++;
            return ""; // Already streamed, skip
          }
          const text = item.redacted ? "[redacted]" : item.thinking;
          return splitAndPrefix(text, "THINKING");
        }
        return "";
      })
      .join("");
  }

  return "";
}
/**
 * Subscribe to session events and flush new messages to the output file
 * on each turn_end. Returns a cleanup function that writes the DONE line
 * and unsubscribes.
 *
 * The optional stats parameter provides final summary data for the DONE line.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  stats?: { turnCount: number; toolUseCount: number; totalTokens: number; cost: number },
  bufferSize: number = 0,
): () => void {
  let writtenCount = 1; // initial user prompt already written
  let thinkingBuffer = "";
  let streamedThinkingBlocks = 0; // thinking blocks written live; skipped in the final flush
  let streamedThinkingChars = 0; // track total chars streamed for deduplication
  let thinkingBlockInProgress = false; // true between thinking_start and thinking_end

  const flushThinkingBuffer = () => {
    if (thinkingBuffer.length > 0) {
      safeAppend(path, `${timestamp()} [THINKING] ${thinkingBuffer}\n`);
      streamedThinkingChars += thinkingBuffer.length;
      thinkingBuffer = "";
    }
  };

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      if (msg.role === "assistant") {
        const lines = formatMessageLine("ASSISTANT", msg.content as any, streamedThinkingBlocks);
        if (lines) safeAppend(path, lines);
      } else if (msg.role === "user") {
        const text = extractUserText(msg.content as any);
        if (text.trim()) {
          safeAppend(path, `${timestamp()} [USER] ${text}\n`);
        }
      } else if (msg.role === "toolResult") {
        const msgAny = msg as unknown as Record<string, unknown>;
        const lines = formatToolResult(
          (msgAny.toolName ?? "unknown") as string,
          msgAny.content as ReadonlyArray<Record<string, unknown>> | undefined,
        );
        if (lines) safeAppend(path, lines);
      }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      flushThinkingBuffer();
      // If thinking_end never fired, treat this as if it did to avoid duplicates
      if (thinkingBlockInProgress) {
        streamedThinkingBlocks++;
        thinkingBlockInProgress = false;
      }
      flush();
    }

    if (bufferSize > 0 && event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "thinking_start") {
        // Reset counter for new thinking block
        streamedThinkingChars = 0;
        thinkingBlockInProgress = true;
      } else if (assistantEvent.type === "thinking_delta") {
        thinkingBuffer += assistantEvent.delta;
        if (thinkingBuffer.length >= bufferSize) {
          // Round down to nearest sentence boundary when possible
          const boundary = findLastSentenceBoundary(thinkingBuffer);
          if (boundary >= 0) {
            const flushText = thinkingBuffer.slice(0, boundary + 1);
            thinkingBuffer = thinkingBuffer.slice(boundary + 1);
            safeAppend(path, `${timestamp()} [THINKING] ${flushText}\n`);
            streamedThinkingChars += flushText.length;
          } else {
            // No sentence boundary found, flush at buffer limit
            flushThinkingBuffer();
          }
        }
      } else if (assistantEvent.type === "thinking_end") {
        // thinking_end carries the full block. Flush the buffered tail first
        // (counted in streamedThinkingChars), then stream whatever remains.
        flushThinkingBuffer();
        if (assistantEvent.content && assistantEvent.content.length > streamedThinkingChars) {
          const remaining = assistantEvent.content.slice(streamedThinkingChars);
          safeAppend(path, `${timestamp()} [THINKING] ${remaining}\n`);
          streamedThinkingChars = assistantEvent.content.length;
        }
        streamedThinkingBlocks++;
        thinkingBlockInProgress = false;
      }
    }
  });

  return () => {
    // Final flush
    flushThinkingBuffer();
    flush();

    // Write DONE line
    const doneStats = stats ?? { turnCount: 0, toolUseCount: 0, totalTokens: 0, cost: 0 };
    safeAppend(path, formatDoneLine(doneStats));

    // Unsubscribe from session events
    unsubscribe();
  };
}

// ---------------------------------------------------------------------------
//  AgentOutputLog — lifecycle wrapper for per-agent output streaming
// ---------------------------------------------------------------------------

/** Final stats written to the DONE line at agent completion. */
export interface OutputFinalStats {
  turnCount: number;
  toolUseCount: number;
  totalTokens: number;
  cost: number;
}

/**
 * Manages a single agent's output log lifecycle: create path → write initial
 * entry → attach session stream → finalize with stats → close.
 *
 * The manager holds one instance per agent. At spawn time the constructor
 * creates the file and writes the [USER] entry. When the session is ready,
 * `attach()` subscribes to streaming events. At completion, `finalize()`
 * flushes remaining messages, writes the [DONE] line, and unsubscribes.
 */
export class AgentOutputLog {
  readonly path: string;
  private cleanup?: () => void;
  private statsRef?: OutputFinalStats;
  private bufferSize: number;

  constructor(agentId: string, prompt: string, baseDir?: string, bufferSize: number = 0) {
    this.path = createOutputFilePath(agentId, baseDir);
    writeInitialEntry(this.path, prompt);
    this.bufferSize = bufferSize;
  }

  /**
   * Subscribe to session events so messages stream to the output file.
   * Internally passes a mutable stats reference that `finalize()` populates
   * before the DONE line is written.
   */
  attach(session: AgentSession): void {
    this.statsRef = { turnCount: 0, toolUseCount: 0, totalTokens: 0, cost: 0 };
    this.cleanup = streamToOutputFile(session, this.path, this.statsRef, this.bufferSize);
  }

  /**
   * Flush remaining messages, write the [DONE] line with final stats,
   * and unsubscribe from session events.
   *
   * Safe to call without a prior `attach()` — writes the DONE line only.
   */
  finalize(stats: OutputFinalStats): void {
    if (this.cleanup && this.statsRef) {
      // Populate the mutable stats ref so streamToOutputFile's cleanup
      // writes the actual final values to the DONE line.
      this.statsRef.turnCount = stats.turnCount;
      this.statsRef.toolUseCount = stats.toolUseCount;
      this.statsRef.totalTokens = stats.totalTokens;
      this.statsRef.cost = stats.cost;
      this.cleanup();
      this.cleanup = undefined;
      this.statsRef = undefined;
    } else {
      // No attach was called — write DONE directly
      safeAppend(this.path, formatDoneLine(stats));
    }
  }
}
