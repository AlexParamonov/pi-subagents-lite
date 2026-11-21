/**
 * endpoints.ts — Which Workflow endpoint a run is sent to, and the one base every route is built
 * against (US-6, US-7, US-21, US-34, US-35).
 *
 * The file's own `endpoint` key wins, otherwise the configured default; the config layers keep what
 * was written and only here is usability decided. Lookup uses own keys, and every refusal names the
 * endpoint, its setting and the configured keys while quoting no URL value. `validatedBase` is the
 * only mint for `ValidatedBase`; tasks/workflows/waves/1r-shared-boundaries/plan.md holds the
 * measurement behind each rule.
 */

import type { SubagentsConfig } from "../models/model-precedence.ts";

declare const validatedBaseBrand: unique symbol;

/** One run's request base: an http(s) `origin + pathname` with trailing slashes normalized. */
export type ValidatedBase = string & { readonly [validatedBaseBrand]: true };

/** A Workflow endpoint as the caller needs it to make one request. */
export interface WorkflowEndpoint {
  name: string;
  url: ValidatedBase;
  apiKey?: string;
}

export type ResolvedEndpoint = { ok: true; endpoint: WorkflowEndpoint } | { ok: false; error: string };

export function resolveWorkflowEndpoint(
  workflows: SubagentsConfig["workflows"],
  fileEndpoint?: unknown,
): ResolvedEndpoint {
  const configured = Object.keys(workflows.endpoints);
  const defaulted = fileEndpoint === undefined;
  // A Workflow file's `endpoint: null` is a configured-but-unusable selection, not an absent one.
  if (fileEndpoint === null)
    return refused("selection is unusable: the workflow file names its endpoint as null", configured);
  const requested = defaulted ? workflows.defaultEndpoint : fileEndpoint;
  if (typeof requested !== "string") return refused(`${shown(requested)} is not an endpoint name`, configured);

  const entry = Object.hasOwn(workflows.endpoints, requested) ? workflows.endpoints[requested] : undefined;
  if (!entry) {
    return refused(
      `${shown(requested)} ${defaulted ? "is the configured default but is not configured" : "is not configured"}`,
      configured,
    );
  }
  if (typeof entry.url !== "string") return refused(about(requested, "declares no usable URL"), configured);
  const base = validatedBase(entry.url);
  if (!base.ok) return refused(about(requested, base.problem), configured);
  return {
    ok: true,
    endpoint: { name: requested, url: base.url, ...(entry.apiKey ? { apiKey: entry.apiKey } : {}) },
  };
}

/**
 * The URL a published surface may show: origin plus path, dropping a path whose percent escapes the
 * credential redactor cannot match against the value it holds.
 */
export function displayUrl(base: ValidatedBase): string {
  const { origin, pathname } = new URL(base);
  return origin + (pathname.includes("%") ? "" : pathname.replace(/\/+$/, ""));
}

type Minted = { ok: true; url: ValidatedBase } | { ok: false; problem: string };

/** The one mint: what cannot serve as a request base is refused here, never repaired. */
function validatedBase(value: string): Minted {
  const written = value.replace(/[\t\r\n]/g, "").replace(/^[\0-\x20]+|[\0-\x20]+$/g, "");
  let parsed: URL;
  try {
    // The parser deletes those controls and trims C0-or-space itself, so this written form - not the
    // raw value - is what every check below has to agree with.
    parsed = new URL(written);
  } catch {
    return { ok: false, problem: "is not a usable URL: it cannot be parsed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, problem: "is not an http or https URL" };
  }
  if (carriesUserinfo(written)) return { ok: false, problem: "carries embedded credentials in its userinfo" };
  // Presence comes from the serialized URL: `.search`/`.hash` report "" for a bare `?` or `#`.
  if (parsed.href.includes("?")) return { ok: false, problem: "carries a query" };
  if (parsed.href.includes("#")) return { ok: false, problem: "carries a fragment" };
  return { ok: true, url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") as ValidatedBase };
}

function refused(detail: string, configured: string[]): ResolvedEndpoint {
  return { ok: false, error: `Workflow endpoint ${detail}. Configured endpoints: ${configured.join(", ")}.` };
}

/** Which endpoint and which setting the problem is in, with no URL value quoted. */
function about(endpoint: string, problem: string): string {
  return `${shown(endpoint)} (workflows.endpoints[${endpoint}].url) ${problem}`;
}

/**
 * Presence of userinfo, from the authority as written: the parser deletes an empty marker, so
 * `new URL("http://@h").username` cannot answer this, and only the written form agrees with the host
 * the request goes to.
 */
function carriesUserinfo(written: string): boolean {
  const afterScheme = written.slice(written.indexOf(":") + 1).replace(/^[\\/]+/, "");
  const delimiter = afterScheme.search(/[\\/?#]/);
  return (delimiter < 0 ? afterScheme : afterScheme.slice(0, delimiter)).includes("@");
}

function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
