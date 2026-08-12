/**
 * stream-retry.test.ts — Tests for patching the retry classifier.
 *
 * Verifies that patchRetryClassifier:
 *   - marks transient transport errors as retryable
 *   - marks quota errors as retryable
 *   - preserves non-retryable errors
 *   - is a no-op when _isRetryableError is absent
 */

import { describe, it, expect, vi } from "vitest";
import { patchRetryClassifier } from "../../src/agents/stream-retry.js";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Build a mock session with a controllable _isRetryableError. */
function makeMockSession(originalRetryable: (msg: any) => boolean = () => false) {
  const session = {
    _isRetryableError: originalRetryable,
  } as any;
  return session;
}

/** Build a classifier message. */
function msg(opts: { stopReason?: string; errorMessage?: string } = {}): any {
  return {
    stopReason: opts.stopReason ?? "end",
    errorMessage: opts.errorMessage,
  };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("patchRetryClassifier", () => {
  // ── Transient transport errors become retryable ──

  it("marks 'stream disconnected before completion' as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "stream disconnected before completion" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks 'stream closed before response.completed' as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "stream closed before response.completed" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks 'invalid SSE data JSON' as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "invalid SSE data JSON" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks 'stream_read_error: upstream closed the response' as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "stream_read_error: upstream closed the response" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks Codex EOF transport errors as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({
      stopReason: "error",
      errorMessage: 'Codex error: Post "https://chatgpt.com/backend-api/codex/responses": EOF',
    });
    expect(session._isRetryableError(m)).toBe(true);
  });

  // ── Case insensitivity ──

  it("matches error messages case-insensitively", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "Stream DISCONNECTED Before Completion" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  // ── Quota errors become retryable ──

  it("marks 'Allocated quota exceeded' as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({
      stopReason: "error",
      errorMessage:
        '429: {"message":"Allocated quota exceeded, please increase your quota limit.","code":"insufficient_quota"}',
    });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks the exact Qwen error from production logs as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    // Exact error from pi sessions
    const m = msg({
      stopReason: "error",
      errorMessage:
        '429: {"message":"Allocated quota exceeded, please increase your quota limit. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit","id":"54a4a035-ded0-4eb0-97f8-02394003fa49","type":"insufficient_quota","code":"insufficient_quota"}',
    });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("does not mark 'quota will reset at' as retryable (falls through to upstream)", () => {
    const original = vi.fn(() => false);
    const session = makeMockSession(original);
    patchRetryClassifier(session);

    const m = msg({
      stopReason: "error",
      errorMessage:
        '429: {"message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 07-28 11:17:00 UTC."}',
    });
    expect(session._isRetryableError(m)).toBe(false);
  });

  // ── Non-retryable errors pass through unchanged ──

  it("does not mark auth failure as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "authentication failed" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark model not found as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "model not found" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark 'upstream closed the response' as retryable (no transport prefix)", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "upstream closed the response" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark non-error stop reasons as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "end", errorMessage: "stream disconnected before completion" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark messages without errorMessage as retryable", () => {
    const session = makeMockSession(() => false);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  // ── Chains with original classifier ──

  it("preserves original classifier's retryable errors", () => {
    const original = vi.fn((m: any) => m.errorMessage === "rate limit exceeded");
    const session = makeMockSession(original);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "rate limit exceeded" });
    expect(session._isRetryableError(m)).toBe(true);
    expect(original).toHaveBeenCalledWith(m);
  });

  it("handles stream-pattern messages without calling original", () => {
    const original = vi.fn(() => false);
    const session = makeMockSession(original);
    patchRetryClassifier(session);

    const m = msg({ stopReason: "error", errorMessage: "stream disconnected before completion" });
    expect(session._isRetryableError(m)).toBe(true);
    expect(original).not.toHaveBeenCalled();
  });

  it("delegates non-matching messages to original", () => {
    const original = vi.fn(() => false);
    const session = makeMockSession(original);
    patchRetryClassifier(session);

    const m = msg({
      stopReason: "error",
      errorMessage: '429: {"message":"Something else","code":"other_error"}',
    });
    session._isRetryableError(m);
    expect(original).toHaveBeenCalledWith(m);
  });

  // ── Defensive: no _isRetryableError ──

  it("is a no-op when _isRetryableError is absent", () => {
    const session = {} as any;
    patchRetryClassifier(session);
    expect(session._isRetryableError).toBeUndefined();
  });

  it("is a no-op when _isRetryableError is not a function", () => {
    const session = { _isRetryableError: "not a function" } as any;
    patchRetryClassifier(session);
    expect(session._isRetryableError).toBe("not a function");
  });

  it("is a no-op when _isRetryableError is null", () => {
    const session = { _isRetryableError: null } as any;
    patchRetryClassifier(session);
    expect(session._isRetryableError).toBeNull();
  });
});
