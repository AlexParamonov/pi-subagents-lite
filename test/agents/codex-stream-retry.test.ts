/**
 * codex-stream-retry.test.ts — Tests for enabling Codex stream error retry.
 *
 * Verifies that enableCodexStreamErrorRetry:
 *   - marks transient stream errors as retryable
 *   - preserves non-retryable errors
 *   - is a no-op when _isRetryableError is absent
 */

import { describe, it, expect, vi } from "vitest";
import { enableCodexStreamErrorRetry } from "../../src/agents/codex-stream-retry.js";

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

describe("enableCodexStreamErrorRetry", () => {
  // ── Transient stream errors become retryable ──

  it("marks 'stream disconnected before completion' as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "stream disconnected before completion" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks 'stream closed before response.completed' as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "stream closed before response.completed" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  it("marks 'invalid SSE data JSON' as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "invalid SSE data JSON" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  // ── Case insensitivity ──

  it("matches error messages case-insensitively", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "Stream DISCONNECTED Before Completion" });
    expect(session._isRetryableError(m)).toBe(true);
  });

  // ── Non-retryable errors pass through unchanged ──

  it("does not mark auth failure as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "authentication failed" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark model not found as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "model not found" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark non-error stop reasons as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "end", errorMessage: "stream disconnected before completion" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  it("does not mark messages without errorMessage as retryable", () => {
    const session = makeMockSession(() => false);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error" });
    expect(session._isRetryableError(m)).toBe(false);
  });

  // ── Chains with original classifier ──

  it("preserves original classifier's retryable errors", () => {
    // Simulate upstream already marking rate-limit as retryable
    const original = vi.fn((m: any) => m.errorMessage === "rate limit exceeded");
    const session = makeMockSession(original);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "rate limit exceeded" });
    expect(session._isRetryableError(m)).toBe(true);
    expect(original).toHaveBeenCalledWith(m);
  });

  it("calls original classifier before checking stream patterns", () => {
    const original = vi.fn(() => false);
    const session = makeMockSession(original);
    enableCodexStreamErrorRetry(session);

    const m = msg({ stopReason: "error", errorMessage: "stream disconnected before completion" });
    session._isRetryableError(m);
    expect(original).toHaveBeenCalledWith(m);
  });

  // ── Defensive: no _isRetryableError ──

  it("is a no-op when _isRetryableError is absent", () => {
    const session = {} as any;
    // Should not throw
    enableCodexStreamErrorRetry(session);
    // Session unchanged
    expect(session._isRetryableError).toBeUndefined();
  });

  it("is a no-op when _isRetryableError is not a function", () => {
    const session = { _isRetryableError: "not a function" } as any;
    enableCodexStreamErrorRetry(session);
    // Unchanged
    expect(session._isRetryableError).toBe("not a function");
  });

  it("is a no-op when _isRetryableError is null", () => {
    const session = { _isRetryableError: null } as any;
    enableCodexStreamErrorRetry(session);
    expect(session._isRetryableError).toBeNull();
  });
});
