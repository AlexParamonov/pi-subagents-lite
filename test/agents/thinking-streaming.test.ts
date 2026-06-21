/**
 * thinking-streaming.test.ts — Tests for streaming thinking blocks to output file.
 *
 * Verifies:
 * - Config option `outputThinkingBufferSize` is respected
 * - Thinking deltas buffer until configured size or newline
 * - Buffer flushes on thinking_end and turn_end events
 * - No duplicate thinking content at turn_end
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../../src/agents/output-file.js";

const testAgentId = "test-thinking-streaming";
const fixture = tempDirFixture();

beforeEach(() => fixture.setup());
afterEach(() => fixture.teardown());

function setupSession(messages: any[]) {
  const session = createMockSession() as any;
  Object.defineProperty(session, "messages", { get: () => messages, configurable: true });
  return session;
}

describe("streamToOutputFile with thinking streaming", () => {
  describe("when outputThinkingBufferSize is 0 or undefined (default)", () => {
    it("does not stream thinking deltas during message_update events", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "Let me think..." }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 0);
      
      // Fire thinking_delta event
      session._fireThinkingDelta("Let me think...");
      
      // Check that nothing was written yet
      const contentBefore = readFileSync(path, "utf-8");
      expect(contentBefore).not.toContain("Let me think...");
      
      // Fire turn_end to flush everything
      session._fireTurnEnd();
      
      // Now thinking should appear (flushed at turn_end)
      const contentAfter = readFileSync(path, "utf-8");
      expect(contentAfter).toContain("[THINKING]");
      expect(contentAfter).toContain("Let me think...");
      
      cleanup();
    });
  });

  describe("when outputThinkingBufferSize > 0", () => {
    it("streams thinking deltas to output file", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 10);
      
      // Fire thinking_delta event
      session._fireThinkingDelta("Hello ");
      
      // Buffer is not full yet (6 chars < 10), so nothing should be written
      const contentAfterDelta = readFileSync(path, "utf-8");
      expect(contentAfterDelta).not.toContain("Hello ");
      
      // Fire turn_end to flush the buffer
      session._fireTurnEnd();
      
      // Now the thinking should appear
      const contentAfterTurnEnd = readFileSync(path, "utf-8");
      expect(contentAfterTurnEnd).toContain("[THINKING]");
      expect(contentAfterTurnEnd).toContain("Hello ");
      
      cleanup();
    });

    it("flushes buffer when it reaches configured size", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 5);
      
      // First delta (5 chars - buffer size)
      session._fireThinkingDelta("Hello");
      
      // Buffer should be flushed because it reached the size limit
      const contentAfterFirst = readFileSync(path, "utf-8");
      expect(contentAfterFirst).toContain("[THINKING]");
      expect(contentAfterFirst).toContain("Hello");
      
      cleanup();
    });

    it("flushes buffer when it contains a newline", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);
      
      // Fire delta with newline (should flush even if buffer < size limit)
      session._fireThinkingDelta("Line 1\n");
      
      const contentAfterNewline = readFileSync(path, "utf-8");
      expect(contentAfterNewline).toContain("[THINKING]");
      expect(contentAfterNewline).toContain("Line 1");
      
      cleanup();
    });

    it("flushes buffer on thinking_end event", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);
      
      // Add some content to buffer
      session._fireThinkingDelta("Partial thought");
      
      // Buffer should not be flushed yet (15 chars < 100)
      const contentBefore = readFileSync(path, "utf-8");
      expect(contentBefore).not.toContain("Partial thought");
      
      // Fire thinking_end event
      session._fireThinkingEnd("Complete thought");
      
      // Buffer should be flushed
      const contentAfter = readFileSync(path, "utf-8");
      expect(contentAfter).toContain("[THINKING]");
      expect(contentAfter).toContain("Complete thought");
      
      cleanup();
    });

    it("flushes buffer on turn_end event", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);
      
      // Add some content to buffer
      session._fireThinkingDelta("Some thinking");
      
      // Fire turn_end event
      session._fireTurnEnd();
      
      // Buffer should be flushed
      const contentAfter = readFileSync(path, "utf-8");
      expect(contentAfter).toContain("[THINKING]");
      expect(contentAfter).toContain("Some thinking");
      
      cleanup();
    });

    it("does not duplicate thinking content at turn_end", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "Full thinking" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 10);
      
      // Fire thinking_delta that reaches buffer limit
      session._fireThinkingDelta("Full thinki");  // 10 chars, should flush
      
      // Fire thinking_end with full content
      session._fireThinkingEnd("Full thinking");
      
      // Fire turn_end
      session._fireTurnEnd();
      
      // Count occurrences of thinking content
      const content = readFileSync(path, "utf-8");
      const matches = content.match(/\[THINKING\] Full think/g);
      expect(matches?.length).toBe(1);  // Should appear only once
      
      cleanup();
    });

    it("handles multiple thinking blocks", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { 
          role: "assistant", 
          content: [
            { type: "thinking", thinking: "First block" },
            { type: "text", text: "Response" },
            { type: "thinking", thinking: "Second block" }
          ]
        },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);
      
      // Fire turn_end to flush all
      session._fireTurnEnd();
      
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[THINKING] First block");
      expect(content).toContain("[THINKING] Second block");
      expect(content).toContain("[ASSISTANT] Response");
      
      cleanup();
    });
  });
});
