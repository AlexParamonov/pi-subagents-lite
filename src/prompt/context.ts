/** context.ts — Message content extraction. */

function isTextBlock(c: unknown): c is { type: "text"; text: string } {
  return typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text";
}

export function extractText(content: unknown[]): string {
  return content
    .filter(isTextBlock)
    .map((c) => c.text)
    .join("\n");
}
