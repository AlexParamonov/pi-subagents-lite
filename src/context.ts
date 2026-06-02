/**
 * context.ts — Message content extraction and conversation snapshot formatting.
 *
 * extractText: pull text from message content blocks.
 * buildSnapshotMarkdown: format agent conversation as markdown for snapshot viewer.
 */

import { summarizeToolArgs } from "./format.js";

function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text";
}

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join("\n");
}

/**
 * Build a markdown snapshot of the full agent conversation from session messages.
 *
 * Formatting rules:
 *   - User messages: `> user: text` blockquote
 *   - Assistant messages: regular markdown text
 *   - Tool results: `> ToolName: summarized args` blockquote (using summarizeToolArgs)
 *   - Unrecognized message roles are skipped
 *
 * Tool arguments live on ToolCall blocks inside AssistantMessage.content (linked by id),
 * not on ToolResultMessage. We pre-build a lookup map.
 *
 * @param messages - Agent session messages (from AgentSession.messages)
 * @returns Formatted markdown string
 */
export function buildSnapshotMarkdown(messages: readonly any[]): string {
  // Build toolCallId -> arguments map from assistant messages
  const argsMap = new Map<string, Record<string, unknown>>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.id && block.arguments) {
          argsMap.set(block.id, block.arguments);
        }
      }
    }
  }

  const lines: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const content = msg.content;
        const text =
          typeof content === "string"
            ? content
            : extractText(content ?? []);
        lines.push(`> user: ${text}`, "");
        break;
      }
      case "assistant": {
        const text = extractText(msg.content ?? []);
        if (text) {
          lines.push(text, "");
        }
        break;
      }
      case "toolResult": {
        const name = msg.toolName ?? "tool";
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);

        // Args live on the ToolCall (assistant message), looked up by toolCallId
        const toolArgs = argsMap.get(msg.toolCallId);
        let summary = summarizeToolArgs(name, toolArgs);
        if (summary) {
          // Strip outer parens from summarizeToolArgs output for cleaner display
          if (summary.startsWith("(") && summary.endsWith(")")) {
            summary = summary.slice(1, -1);
          }
          // Strip leading space from default multi-key output
          if (summary.startsWith(" ")) {
            summary = summary.trimStart();
          }
        }
        lines.push(summary ? `> ${displayName}: ${summary}` : `> ${displayName}`, "");
        break;
      }
      // Skip custom/unrecognized message types
    }
  }

  return lines.join("\n");
}
