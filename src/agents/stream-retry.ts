/**
 * Patch the session's retry classifier with custom patterns.
 *
 * Overrides the session's `_isRetryableError` method (duck-typed) so certain
 * error patterns trigger a retry instead of hard failure. Checks our patterns
 * FIRST, then falls back to upstream. This is necessary because upstream marks
 * `insufficient_quota` as non-retryable, but some providers return transient
 * quota errors that should be retried.
 *
 * Patterns:
 * - Transient transport errors: stream/socket/network/transport read/write/connect/
 *   disconnect/close/reset/lost/timeout failures, bare EOF/ECONNRESET/ETIMEDOUT/EPIPE
 *   codes, SSE parse errors
 * - Quota errors: "Allocated quota exceeded" (may be transient false positive)
 *
 * If upstream removes or renames `_isRetryableError`, this is a no-op.
 */

// Connection-level failures are safe to retry: the request may never have reached
// the provider, so replaying it cannot double-execute work.
const TRANSIENT_TRANSPORT_ERROR_PATTERN =
  /\b(?:stream|socket|network|transport)(?:[_\s-]+(?:read|write|connect(?:ion)?|disconnect(?:ed|ion)?|closed?|reset|lost|timeout))(?:[_\s-]+error)?\b|\b(?:EOF|ECONNRESET|ETIMEDOUT|EPIPE)\b|invalid SSE data JSON/i;

// Quota errors that may be transient. "Allocated quota exceeded" can be a false
// positive when the quota check is eventually consistent. Other providers may
// use similar wording for transient rate limits.
const QUOTA_ERROR_PATTERN = /allocated quota exceeded/i;

/**
 * Message shape passed to the upstream retry classifier.
 * Not part of the public API — use `as unknown as` cast.
 */
interface RetryClassifierMessage {
  stopReason: string;
  errorMessage?: string;
}

/**
 * Patch the session's retry classifier to include our custom patterns.
 *
 * Defensive: if `_isRetryableError` is absent or not a function, returns early
 * without modifying the session. Safe if upstream changes the internal API.
 */
export function patchRetryClassifier(session: unknown): void {
  const retrySession = session as unknown as {
    _isRetryableError?: (message: RetryClassifierMessage) => boolean;
  };
  const original = retrySession._isRetryableError;
  if (typeof original !== "function") return;

  retrySession._isRetryableError = (message) => {
    if (message.stopReason === "error" && typeof message.errorMessage === "string") {
      if (QUOTA_ERROR_PATTERN.test(message.errorMessage)) return true;
      if (TRANSIENT_TRANSPORT_ERROR_PATTERN.test(message.errorMessage)) return true;
    }
    return original.call(retrySession, message);
  };
}
