/**
 * thinking-streaming.test.ts — Tests for streaming thinking blocks to output file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createMockSession, tempDirFixture } from "../fixtures.ts";
import { createOutputFilePath, writeInitialEntry, streamToOutputFile } from "../../src/agents/output-file.js";

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

      session._fireThinkingDelta("Let me think...");

      const contentBefore = readFileSync(path, "utf-8");
      expect(contentBefore).not.toContain("Let me think...");

      session._fireTurnEnd();

      // Now thinking should appear (flushed at turn_end)
      const contentAfter = readFileSync(path, "utf-8");
      expect(contentAfter).toContain("[THINKING]");
      expect(contentAfter).toContain("Let me think...");

      cleanup();
    });
    it("does not stream thinking deltas when the buffer size is omitted (default)", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "Let me think..." }] },
      ]);

      // bufferSize omitted — the default (0) must disable live thinking streaming
      const cleanup = streamToOutputFile(session, path, undefined);

      session._fireThinkingDelta("Let me think...");

      const contentBefore = readFileSync(path, "utf-8");
      expect(contentBefore).not.toContain("Let me think...");

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

      session._fireThinkingDelta("Hello ");

      // Buffer is not full yet (6 chars < 10), so nothing should be written
      const contentAfterDelta = readFileSync(path, "utf-8");
      expect(contentAfterDelta).not.toContain("Hello ");

      session._fireTurnEnd();

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

    it("does not flush on newline alone (only at buffer limit)", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);

      // Fire delta with newline — should NOT flush yet (buffer < size limit)
      session._fireThinkingDelta("Line 1\n");

      const contentAfterNewline = readFileSync(path, "utf-8");
      expect(contentAfterNewline).not.toContain("[THINKING]");
      expect(contentAfterNewline).not.toContain("Line 1");

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

      // Add content below the 100-char flush threshold so it buffers
      session._fireThinkingDelta("Partial thought");

      const contentBefore = readFileSync(path, "utf-8");
      expect(contentBefore).not.toContain("Partial thought");

      // Fire thinking_end with the full block content (matches the buffered delta)
      session._fireThinkingEnd("Partial thought");

      // Buffer should be flushed exactly once, with no duplication
      const contentAfter = readFileSync(path, "utf-8");
      const matches = contentAfter.match(/\[THINKING\] Partial thought/g);
      expect(matches?.length).toBe(1);

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

      session._fireThinkingDelta("Some thinking");

      session._fireTurnEnd();

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
      session._fireThinkingDelta("Full thinki"); // 10 chars, should flush

      session._fireThinkingEnd("Full thinking");

      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      const matches = content.match(/\[THINKING\] Full think/g);
      expect(matches?.length).toBe(1); // Should appear only once

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
            { type: "thinking", thinking: "Second block" },
          ],
        },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 100);

      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      expect(content).toContain("[THINKING] First block");
      expect(content).toContain("[THINKING] Second block");
      expect(content).toContain("[ASSISTANT] Response");

      cleanup();
    });

    it("deduplicates when thinking_end never fires before turn_end", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "Partial thinking" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 10);

      // Fire thinking_start to indicate a thinking block is in progress
      session._fireThinkingStart();

      // Fire thinking_delta that reaches buffer limit
      session._fireThinkingDelta("Partial thi"); // 10 chars, should flush

      // Fire turn_end WITHOUT thinking_end (simulating missing thinking_end)
      session._fireTurnEnd();

      const content = readFileSync(path, "utf-8");
      const thinkingLines = content.match(/\[THINKING\] Partial thi/g);
      expect(thinkingLines?.length).toBe(1); // Should appear only once, no duplicates

      cleanup();
    });
    it("flushes at sentence boundary when buffer exceeds size", () => {
      const dir = fixture.getDir();
      const path = createOutputFilePath(testAgentId, dir);
      writeInitialEntry(path, "test");

      const session = setupSession([
        { role: "user", content: "test" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
      ]);

      const cleanup = streamToOutputFile(session, path, undefined, 20);

      // Fire delta that exceeds buffer size with a sentence boundary
      session._fireThinkingDelta("First sentence. Second");

      const content = readFileSync(path, "utf-8");
      // Should flush up to the sentence boundary, not mid-sentence
      expect(content).toContain("[THINKING] First sentence.");
      expect(content).not.toContain("Second");

      cleanup();
    });
  });
});
