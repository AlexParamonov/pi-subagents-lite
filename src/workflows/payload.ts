/**
 * payload.ts — reading an object this extension did not author: a Workflow endpoint's JSON body, a
 * parsed Workflow file.
 *
 * A body that is not an object is `null` and a field that is not a usable string is `undefined`:
 * neither shape is ever a throw, so a caller never has to guard the wire.
 */

export function parseRecord(body: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

/** The value under a JSON object shape, or `null` when it is an array, a scalar or absent. */
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string field: ids, statuses, event names and text all arrive this way. */
export function field(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
