/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Forked from upstream pi-subagents. Key modifications:
 *   - Rewrote from JSONL to human-readable format
 *   - Path changed to /tmp/pi-agent-outputs/<agentId>.log (no CID-encoded nesting)
 *   - Directory created with 0o700 permissions
 *   - Append-only, human-readable, supports `tail -f`
 *   - Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Get an ISO 8601 timestamp string suitable for log output. */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Create the output file path for an agent.
 * Path: /tmp/pi-agent-outputs/<agentId>.log
 * Ensures the parent directory exists with 0o700 permissions.
 */
export function createOutputFilePath(agentId: string): string {
  const dir = "/tmp/pi-agent-outputs";
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
  const name = item.name ?? item.toolName ?? "unknown";
  // pi-ai ToolCall uses `arguments`, legacy/anthropic format uses `input`
  const rawArgs = (item.arguments ?? item.input) as Record<string, unknown> | undefined;
  let argsStr = "";
  if (rawArgs && typeof rawArgs === "object" && Object.keys(rawArgs).length > 0) {
    const keys = Object.keys(rawArgs);
    if (keys.length === 1) {
      // Single-arg shorthand: read("src/file.ts")
      const val = rawArgs[keys[0]];
      const display = typeof val === "string" && val.length > 200
        ? JSON.stringify(val.slice(0, 200) + "...")
        : JSON.stringify(val);
      argsStr = `(${display})`;
    } else {
      argsStr = ` ${JSON.stringify(rawArgs)}`;
    }
  }
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
 * Format a single message content item as log lines.
 * Handles text, toolUse/toolCall, and thinking content.
 */
function formatMessageLine(
  role: "ASSISTANT" | "TOOL" | "USER",
  content: string | ReadonlyArray<Record<string, unknown>> | undefined,
): string {
  if (typeof content === "string") {
    return splitAndPrefix(content, role);
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item.type === "text" && typeof item.text === "string") {
          return splitAndPrefix(item.text, role);
        }
        if (item.type === "toolUse" || item.type === "toolCall") {
          return formatToolItem(item);
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
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
  stats?: { turnCount: number; toolUseCount: number; totalTokens: number },
): () => void {
  let writtenCount = 1; // initial user prompt already written

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      if (msg.role === "assistant") {
        const lines = formatMessageLine("ASSISTANT", msg.content);
        if (lines) {
          try { appendFileSync(path, lines, "utf-8"); } catch { /* ignore write errors */ }
        }
      } else if (msg.role === "user") {
        const text = extractUserText(msg.content);
        if (text.trim()) {
          try { appendFileSync(path, `${timestamp()} [USER] ${text}\n`, "utf-8"); } catch { /* ignore */ }
        }
      }
      // NOTE: toolResult messages are enumerated as text content and already
      // included in the assistant message content. No separate TOOL_RESULT role.
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    // Final flush
    flush();

    // Write DONE line
    const { turnCount = 0, toolUseCount = 0, totalTokens = 0 } = stats ?? {};
    const tokensStr = totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k tokens`
      : `${totalTokens} tokens`;
    try {
      appendFileSync(
        path,
        `${timestamp()} [DONE] ${turnCount} turns, ${toolUseCount} tool uses, ${tokensStr}\n`,
        "utf-8",
      );
    } catch { /* ignore write errors */ }

    // Unsubscribe from session events
    unsubscribe();
  };
}
