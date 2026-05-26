/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 *
 * Keep extractText only. buildParentContext removed (inherit_context is cut).
 */

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}
