/**
 * public-text.ts — The one rule for text a Workflow endpoint supplied (US-35).
 *
 * Sanitize, then redact the endpoint's configured key, then bound the text - that order, so neither
 * an escape sequence inside the key nor the bound cutting through it can leave a fragment behind.
 * Every surface that publishes endpoint text (errors, progress, results, diagnostics) goes through
 * an instance built from the key of the endpoint that supplied it; `ui/sanitize.ts` owns the
 * control-character step this applies.
 */

import { truncateWithEllipsis } from "../utils.ts";
import { plainText } from "../ui/sanitize.ts";

/** Longest endpoint text a caller is shown; a proxy's HTML page is not a diagnosis. */
const MAX_REPORTED_CHARS = 300;

/** What the endpoint's key becomes wherever it appears. */
const REDACTED = "[redacted]";

/** Below this length an extra spelling would redact ordinary text that merely contains it. */
const MIN_SPELLING_CHARS = 4;

export interface PublicText {
  /** Endpoint text for a surface that shows all of it. */
  shown(text: string): string;
  /** Endpoint text for a surface that bounds it, cut once the key is already gone. */
  bounded(text: string): string;
}

/**
 * `spellings` are the other forms the key reaches the wire in - a path segment the transport
 * percent-encoded, for instance - which a server can reflect back where the key itself is not a
 * substring of what it answers. They are redacted by the same rule as the key, longest first so a
 * shorter one cannot break a longer one's literal.
 */
export function createPublicText(apiKey?: string, spellings: readonly string[] = []): PublicText {
  // Both sides are sanitized before the comparison, so a key that itself carries a control
  // character is still found in text that lost it.
  const needles = [
    ...(apiKey === undefined ? [] : [plainText(apiKey)]),
    ...new Set(spellings.map(plainText).filter((spelling) => spelling.length >= MIN_SPELLING_CHARS)),
  ].sort((first, second) => second.length - first.length);
  const sanitized = (text: string): string => {
    const stripped = plainText(text);
    return needles.reduce((safe, needle) => safe.split(needle).join(REDACTED), stripped);
  };
  return {
    shown: sanitized,
    bounded: (text) => truncateWithEllipsis(sanitized(text), MAX_REPORTED_CHARS),
  };
}
