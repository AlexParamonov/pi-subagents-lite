/**
 * endpoints.ts — Which Workflow endpoint a run is sent to (US-6, US-7, US-34).
 *
 * The Workflow file's own `endpoint` key wins, otherwise the configured default. An unknown name, an
 * entry that declares no usable URL and a URL that is not http(s) each refuse the call and name the
 * offender: the config layers keep what was written, and only here is usability decided, so a
 * configured target is never answered by another endpoint. A name is looked up by own key only, so a
 * name `Object.prototype` carries (`constructor`, `__proto__`) is an unconfigured name, not an entry.
 */

import type { SubagentsConfig } from "../models/model-precedence.ts";

/** A Workflow endpoint as the caller needs it to make one request. */
export interface WorkflowEndpoint {
  name: string;
  url: string;
  apiKey?: string;
}

export type ResolvedEndpoint = { ok: true; endpoint: WorkflowEndpoint } | { ok: false; error: string };

export function resolveWorkflowEndpoint(
  workflows: SubagentsConfig["workflows"],
  fileEndpoint?: unknown,
): ResolvedEndpoint {
  const configured = Object.keys(workflows.endpoints);
  const defaulted = fileEndpoint === undefined || fileEndpoint === null;
  const requested = defaulted ? workflows.defaultEndpoint : fileEndpoint;
  if (typeof requested !== "string") return refused(`${shown(requested)} is not an endpoint name`, configured);

  const entry = Object.hasOwn(workflows.endpoints, requested) ? workflows.endpoints[requested] : undefined;
  if (!entry) {
    return refused(
      `${shown(requested)} ${defaulted ? "is the configured default but is not configured" : "is not configured"}`,
      configured,
    );
  }
  if (typeof entry.url !== "string") {
    return refused(`${shown(requested)} declares no usable URL`, configured);
  }
  if (!isHttpUrl(entry.url)) return refused(`${shown(requested)} has an unusable URL ${shown(entry.url)}`, configured);
  return { ok: true, endpoint: { name: requested, url: entry.url, ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) } };
}

function refused(detail: string, configured: string[]): ResolvedEndpoint {
  return { ok: false, error: `Workflow endpoint ${detail}. Configured endpoints: ${configured.join(", ")}.` };
}

function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
