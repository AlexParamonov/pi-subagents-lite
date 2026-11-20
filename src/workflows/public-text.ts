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

export interface PublicText {
  /** Endpoint text for a surface that shows all of it. */
  shown(text: string): string;
  /** Endpoint text for a surface that bounds it, cut once the key is already gone. */
  bounded(text: string): string;
}

export function createPublicText(apiKey?: string): PublicText {
  // Both sides are sanitized before the comparison, so a key that itself carries a control
  // character is still found in text that lost it.
  const needle = apiKey === undefined ? undefined : plainText(apiKey);
  const sanitized = (text: string): string => {
    const stripped = plainText(text);
    return needle ? stripped.split(needle).join(REDACTED) : stripped;
  };
  return {
    shown: sanitized,
    bounded: (text) => truncateWithEllipsis(sanitized(text), MAX_REPORTED_CHARS),
  };
}
