/**
 * public-text.test.ts — The one rule that makes endpoint-supplied text safe to publish (US-35).
 *
 * The order is the behaviour: controls first, then the endpoint's key, then the bound. Any other
 * order leaves a piece of the key behind - a key the cut crosses, or one the endpoint split with an
 * escape sequence - and the whole point of the rule is that no surface gets to choose.
 */

import { describe, expect, it } from "vite-plus/test";
import { createPublicText } from "../../src/workflows/public-text.js";

const KEY = "sekrit-endpoint-value";
/** Server text long enough that a bound applied before the redaction would cut through the key. */
function textEndingInKey(filler: number): string {
  return `${"x".repeat(filler)}${KEY}`;
}

describe("public text", () => {
  it("replaces every copy of the endpoint's key", () => {
    const text = createPublicText(KEY);

    expect(text.shown(`auth ${KEY} then ${KEY}`)).toBe("auth [redacted] then [redacted]");
  });

  it("leaves text alone when the endpoint has no key", () => {
    expect(createPublicText().shown(`auth ${KEY}`)).toBe(`auth ${KEY}`);
  });

  it("redacts a key the endpoint split with a control sequence", () => {
    const text = createPublicText(KEY);

    expect(text.shown("auth sek\u001B[0mrit-endpoint-value")).toBe("auth [redacted]");
  });

  it("cuts after the key is replaced, so the bound cannot leave a fragment of it", () => {
    const text = createPublicText(KEY);

    const reported = text.bounded(textEndingInKey(295));

    expect(reported).toBe(`${"x".repeat(295)}[reda\u2026`);
    expect(reported).not.toContain("sekrit");
  });

  it("bounds long text with an ellipsis and leaves text of the bound whole", () => {
    const text = createPublicText();
    const atTheBound = textEndingInKey(300 - KEY.length);

    expect(text.bounded(atTheBound)).toBe(atTheBound);
    expect(text.bounded(`${atTheBound}x`).endsWith("\u2026")).toBe(true);
  });
});
