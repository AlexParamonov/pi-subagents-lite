/**
 * Enable retry for transient Codex stream errors.
 *
 * Wraps the session's _isRetryableError classifier (duck-typed, not replacing)
 * so three transient patterns trigger an upstream retry instead of hard failure.
 * If the upstream removes or renames _isRetryableError, this is a no-op.
 */

const CODEX_RETRYABLE_STREAM_ERROR_PATTERN =
  /stream disconnected before completion|stream closed before response\.completed|invalid SSE data JSON/i;

/**
 * Message shape passed to the upstream retry classifier.
 * Not part of the public API — use `as unknown as` cast.
 */
interface RetryClassifierMessage {
  stopReason: string;
  errorMessage?: string;
}

/**
 * Extend the session's retry classifier to include transient Codex stream errors.
 *
 * Defensive: if _isRetryableError is absent or not a function, returns early
 * without modifying the session.
 */
export function enableCodexStreamErrorRetry(session: unknown): void {
  const retrySession = session as unknown as {
    _isRetryableError?: (message: RetryClassifierMessage) => boolean;
  };
  const original = retrySession._isRetryableError;
  if (typeof original !== "function") return;

  retrySession._isRetryableError = (message) =>
    original.call(retrySession, message) ||
    (message.stopReason === "error" &&
      typeof message.errorMessage === "string" &&
      CODEX_RETRYABLE_STREAM_ERROR_PATTERN.test(message.errorMessage));
}