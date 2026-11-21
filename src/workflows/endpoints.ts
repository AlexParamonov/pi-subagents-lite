/**
 * endpoints.ts — Which Workflow endpoint a run is sent to, and the one base every route is built
 * against (US-6, US-7, US-21, US-34, US-35).
 *
 * The file's own `endpoint` key wins, otherwise the configured default; the config layers keep what
 * was written and only here is usability decided - the request base and the effective credential are
 * both derived here. Lookup uses own keys. Refusals explain the invalid selection or setting and
 * list the configured keys without quoting the configured URL. `validatedBase` is the only mint for
 * `ValidatedBase`; tasks/workflows/waves/1r-shared-boundaries/plan.md holds the measurements.
 */

import type { SubagentsConfig } from "../models/model-precedence.ts";

declare const validatedBaseBrand: unique symbol;

/** One run's request base: an http(s) `origin + pathname` with trailing slashes normalized. */
export type ValidatedBase = string & { readonly [validatedBaseBrand]: true };

/** The resolved endpoint for every request in one Workflow run. */
export interface WorkflowEndpoint {
  name: string;
  url: ValidatedBase;
  /** The effective credential: the exact bytes of the `Bearer` value and the exact redaction needle. */
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
  if (typeof entry.url !== "string") return refused(about(requested, "url", "declares no usable URL"), configured);
  const base = validatedBase(entry.url);
  if (!base.ok) return refused(about(requested, "url", base.problem), configured);
  const key = effectiveCredential(entry.apiKey);
  if (!key.ok) return refused(about(requested, "apiKey", "declares an unusable credential"), configured);
  return {
    ok: true,
    endpoint: { name: requested, url: base.url, ...(key.apiKey === undefined ? {} : { apiKey: key.apiKey }) },
  };
}

/** The credential one run authenticates with and redacts with, or the reason it cannot be either. */
type Credential = { ok: true; apiKey?: string } | { ok: false };

/** Printable ASCII except `"` and `\`: every other byte is one a transport, a display or a JSON body rewrites. */
const USABLE_CREDENTIAL = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * One value for both sides of the boundary: outer SP/TAB is normalized because the wire strips it
 * from a header value, and anything the transport, a display layer or a JSON body would rewrite
 * before the redaction needle can match it is refused rather than sent. Only absence is keyless.
 */
function effectiveCredential(declared: unknown): Credential {
  if (declared === undefined) return { ok: true };
  if (typeof declared !== "string") return { ok: false };
  const effective = declared.replace(/^[ \t]+|[ \t]+$/g, "");
  return USABLE_CREDENTIAL.test(effective) ? { ok: true, apiKey: effective } : { ok: false };
}

/**
 * The URL a published surface may show: the base itself, or its origin alone once the path carries a
 * percent escape the credential redactor cannot match against the value it holds. A base's `%` is always
 * path data (a host carrying `%` fails to parse) and a base is already `origin + pathname`.
 */
export function displayUrl(base: ValidatedBase): string {
  return base.includes("%") ? new URL(base).origin : base;
}

/**
 * Every form `apiKey` can reach published text in for this base: the key, the form Fetch encodes it
 * in, and each span of the base's own path that decodes to the key. A server that answers with the
 * request target it received reflects those, and the configured text is not a substring of any of
 * them. A path that carries no credential contributes nothing, so ordinary path data stays readable.
 */
export function transportSpellings(base: ValidatedBase, apiKey: string): string[] {
  const forms = new Set<string>([apiKey, encodeURIComponent(apiKey)]);
  for (const span of new URL(base).pathname.matchAll(pathForm(apiKey))) forms.add(span[0]);
  return [...forms];
}

/** The credential as a request path carries it: each character literal or percent-escaped. */
function pathForm(credential: string): RegExp {
  return new RegExp(credential.replace(/./gu, characterForm), "g");
}

/**
 * One character of it, as written or as its whole `%XX` escape in either hex case, so a match is
 * always bytes the transport sent and never half an escape.
 */
function characterForm(character: string): string {
  const escaped = [...Buffer.from(character, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("")
    .replace(/[A-Za-z]/g, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`);
  return `(?:${escapeRegExp(character)}|${escaped})`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
function about(endpoint: string, setting: "url" | "apiKey", problem: string): string {
  return `${shown(endpoint)} (workflows.endpoints[${endpoint}].${setting}) ${problem}`;
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
