/**
 * endpoints.test.ts — Which Workflow endpoint a run goes to, and what a bad answer costs (US-34).
 *
 * A file's `endpoint` key wins, otherwise the configured default; every failure names the offender
 * and lists the configured keys. Nothing here falls back quietly to another endpoint, because the
 * cost of a silent fallback is a run on the wrong server.
 */

import { describe, expect, it } from "vite-plus/test";
import { displayUrl, resolveWorkflowEndpoint } from "../../src/workflows/endpoints.js";
import type { ValidatedBase } from "../../src/workflows/endpoints.js";
import type { SubagentsConfig } from "../../src/models/model-precedence.js";

function settings(
  endpoints: SubagentsConfig["workflows"]["endpoints"],
  defaultEndpoint: SubagentsConfig["workflows"]["defaultEndpoint"],
) {
  return { endpoints, defaultEndpoint };
}

const CONFIGURED = settings(
  {
    local: { url: "http://localhost:4001" },
    release: { url: "https://anagen-x.internal:4001", apiKey: "release-key" },
  },
  "local",
);

/** The refusal one configured url earns, naming the `broken` endpoint it belongs to. */
function refusal(url: string): string {
  const resolution = resolveWorkflowEndpoint(settings({ broken: { url } }, "broken"), "broken");
  expect(resolution.ok, `${JSON.stringify(url)} must be refused`).toBe(false);
  return (resolution as { error: string }).error;
}

describe("resolveWorkflowEndpoint", () => {
  it("takes the endpoint the Workflow file names", () => {
    expect(resolveWorkflowEndpoint(CONFIGURED, "release")).toEqual({
      ok: true,
      endpoint: { name: "release", url: "https://anagen-x.internal:4001", apiKey: "release-key" },
    });
  });

  it("takes the configured default when the file names none", () => {
    expect(resolveWorkflowEndpoint(CONFIGURED, undefined)).toEqual({
      ok: true,
      endpoint: { name: "local", url: "http://localhost:4001" },
    });
  });

  // `endpoint: null` is a value the file declares, so it names no endpoint at all: defaulting it
  // would run the workflow against a server the file never chose (US-34).
  it("refuses a workflow file whose endpoint key is null, naming the file's key", () => {
    const resolution = resolveWorkflowEndpoint(CONFIGURED, null);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toMatch(/workflow file.*\bendpoint\b.*null/i);
  });

  // The one base a run is sent to: a path prefix is part of the target, and the trailing slashes a
  // configured URL carries are not (US-6).
  for (const [configured, base] of [
    ["http://localhost:4001", "http://localhost:4001"],
    ["http://localhost:4001/", "http://localhost:4001"],
    ["http://localhost:4001/gateway/v1", "http://localhost:4001/gateway/v1"],
    ["http://localhost:4001/gateway/v1/", "http://localhost:4001/gateway/v1"],
    ["http://localhost:4001/gateway/v1//", "http://localhost:4001/gateway/v1"],
  ] as const) {
    it(`resolves the configured ${configured} to the one request base ${base}`, () => {
      expect(resolveWorkflowEndpoint(settings({ local: { url: configured } }, "local"), "local")).toEqual({
        ok: true,
        endpoint: { name: "local", url: base },
      });
    });
  }

  it("names an endpoint key the file carries that is not configured, and lists the ones that are", () => {
    const resolution = resolveWorkflowEndpoint(CONFIGURED, "missing-target");

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("missing-target");
    expect((resolution as { error: string }).error).toContain("local");
    expect((resolution as { error: string }).error).toContain("release");
  });

  // An endpoint name is data. `Object.prototype` carries `constructor`, `__proto__` and `toString`, so
  // reading the table by name alone finds an entry for a name no file ever configured (US-34: the name
  // the operator is told about must be the one that is really configured).
  for (const name of ["constructor", "__proto__", "toString"]) {
    it(`refuses the name ${name} that only Object.prototype carries, as not configured`, () => {
      const resolution = resolveWorkflowEndpoint(CONFIGURED, name);

      expect(resolution.ok).toBe(false);
      expect((resolution as { error: string }).error).toContain(`"${name}" is not configured`);
      expect((resolution as { error: string }).error).not.toContain("declares no usable URL");
    });
  }

  it("resolves an endpoint whose own name is __proto__", () => {
    const table = { endpoints: {}, defaultEndpoint: "__proto__" } as SubagentsConfig["workflows"];
    Object.defineProperty(table.endpoints, "__proto__", {
      value: { url: "http://proto.invalid:4001" },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    expect(resolveWorkflowEndpoint(table)).toEqual({
      ok: true,
      endpoint: { name: "__proto__", url: "http://proto.invalid:4001" },
    });
  });

  it("names an endpoint key that is not a name at all", () => {
    const resolution = resolveWorkflowEndpoint(CONFIGURED, 42);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("42");
  });

  it("names a configured default that is not one of the endpoints", () => {
    const resolution = resolveWorkflowEndpoint(settings({ local: { url: "http://localhost:4001" } }, "no-such"));

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("no-such");
  });

  // A configured base is a request target, not a URL trimmed into one. What cannot serve as a base
  // refuses the run, names the offending setting (US-34) and quotes no URL value: a path prefix can
  // carry the configured key, and the resolver has no publisher to redact it with.
  for (const [url, problem] of [
    ["http://release.invalid:4001/graph?", /query/i],
    ["http://release.invalid:4001/graph?token=secretvalue", /query/i],
    ["http://release.invalid:4001/graph#", /fragment/i],
    ["http://release.invalid:4001/graph#section", /fragment/i],
    ["ftp://release.invalid:4001/graph", /http|scheme/i],
    ["not a valid URL", /parse|usable|invalid/i],
    ["", /parse|usable|invalid/i],
    ["localhost:4001", /http|scheme/i],
  ] as const) {
    it(`refuses the url ${JSON.stringify(url)} naming its setting and its problem`, () => {
      const error = refusal(url);

      expect(error).toContain("workflows.endpoints[broken].url");
      expect(error).toMatch(problem);
      for (const part of ["release.invalid", "4001", "/graph", "secretvalue", "section", "ftp"]) {
        expect(error).not.toContain(part);
      }
    });
  }

  // A credential pair inside the configured URL is a secret, and a refusal is a published surface.
  // The parser deletes an empty userinfo marker before anything can read it back (`http://@h` parses
  // to a clean base), so presence is decided on the input's authority as written.
  for (const url of [
    "http://@release.invalid:4001/graph",
    "http:/@release.invalid:4001/graph",
    "http:///@release.invalid:4001/graph",
    "http:////@release.invalid:4001/graph",
    "http:/\\@release.invalid:4001/graph",
    "  HTTP://@release.invalid:4001/graph",
    "http://\t/@release.invalid:4001/graph",
    "http://\r/@release.invalid:4001/graph",
    "http://\n/@release.invalid:4001/graph",
    "http://fixture-user:fixture-password@release.invalid:4001/graph",
  ]) {
    it(`refuses the embedded credential the url ${JSON.stringify(url)} carries`, () => {
      const error = refusal(url);

      expect(error).toMatch(/user.?info|embedded credential/i);
      for (const part of ["release.invalid", "4001", "/graph", "fixture-user", "fixture-password"]) {
        expect(error).not.toContain(part);
      }
    });
  }

  // An `@` is ordinary path data: only the authority's `@` names a credential.
  for (const url of [
    "http://release.invalid:4001/team@release/v1",
    "http://release.invalid:4001/p@th",
    "http://release.invalid:4001/@node",
  ]) {
    it(`keeps the base whose path carries an at-sign: ${url}`, () => {
      expect(resolveWorkflowEndpoint(settings({ local: { url } }, "local"), "local")).toEqual({
        ok: true,
        endpoint: { name: "local", url },
      });
    });
  }

  // A configured target with nothing usable to send to: another endpoint answering instead is a
  // run on the wrong server (US-34), so the unusable entry has to survive to here.
  for (const url of [undefined, null, 4001, { href: "http://h:1" }]) {
    it(`refuses the endpoint whose url is ${JSON.stringify(url)} rather than picking another target`, () => {
      const resolution = resolveWorkflowEndpoint(settings({ broken: { url } }, "broken"), "broken");

      expect(resolution.ok).toBe(false);
      expect((resolution as { error: string }).error).toContain("broken");
    });
  }

  // A default that names no usable target: falling back to the built-in target would run the workflow
  // against a server nobody chose (US-34). null is a configured value, not absence.
  for (const name of [4001, "", ["local"], null]) {
    it(`refuses the configured default ${JSON.stringify(name)} rather than picking another target`, () => {
      const resolution = resolveWorkflowEndpoint(
        settings({ "anagen-x.local": { url: "http://localhost:4001" } }, name),
      );

      expect(resolution.ok).toBe(false);
      expect((resolution as { error: string }).error).toContain(String(name));
    });
  }

  it("refuses a default that would become a configured name only by coercion", () => {
    const resolution = resolveWorkflowEndpoint(settings({ "4001": { url: "http://localhost:4001" } }, 4001));

    expect(resolution.ok).toBe(false);
  });
});

// The validated base is transport-only: what a surface shows is this value, and a needle matched
// literally cannot catch a key the canonical path percent-escaped (US-35).
describe("displayUrl", () => {
  for (const [configured, shown] of [
    ["http://release.invalid:4001", "http://release.invalid:4001"],
    ["http://release.invalid:4001/gateway/v1", "http://release.invalid:4001/gateway/v1"],
    ["http://release.invalid:4001/team@release/v1", "http://release.invalid:4001/team@release/v1"],
    ["http://release.invalid:4001/k%3C7%3E/v1", "http://release.invalid:4001"],
  ] as const) {
    it(`shows ${shown} for the base ${configured}`, () => {
      expect(displayUrl(mint(configured))).toBe(shown);
    });
  }
});

/** A base only resolution may mint, for the tests that need one as input. */
function mint(url: string): ValidatedBase {
  const resolution = resolveWorkflowEndpoint(settings({ local: { url } }, "local"), "local");
  if (!resolution.ok) throw new Error(`${JSON.stringify(url)} must resolve: ${resolution.error}`);
  return resolution.endpoint.url;
}
