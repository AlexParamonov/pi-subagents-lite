/**
 * endpoints.test.ts — Which Workflow endpoint a run goes to, and what a bad answer costs (US-34).
 *
 * A file's `endpoint` key wins, otherwise the configured default; every failure names the offender
 * and lists the configured keys. Nothing here falls back quietly to another endpoint, because the
 * cost of a silent fallback is a run on the wrong server.
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveWorkflowEndpoint } from "../../src/workflows/endpoints.js";
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

function expectBrokenEndpointRefusal(entry: SubagentsConfig["workflows"]["endpoints"][string]): string {
  const resolution = resolveWorkflowEndpoint(settings({ broken: entry }, "broken"), "broken");
  if (resolution.ok !== false) throw new Error('expected endpoint "broken" to be refused');
  return resolution.error;
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
      const error = expectBrokenEndpointRefusal({ url });

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
      const error = expectBrokenEndpointRefusal({ url });

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

// One credential authenticates and redacts, so the bytes the transport puts in `Authorization: Bearer`
// and the bytes the publisher matches have to be one value: outer SP/TAB is normalized here, because
// the wire strips them anyway (US-8, US-35).
describe("the effective credential", () => {
  function expectUnusableCredential(apiKey: unknown): string {
    const error = expectBrokenEndpointRefusal({ url: "http://localhost:4001", apiKey });
    expect(error).toContain('"broken"');
    expect(error).toContain("workflows.endpoints[broken].apiKey");
    expect(error).toMatch(/unusable|not a usable credential/i);
    return error;
  }

  for (const [configured, effective] of [
    ["release-key", "release-key"],
    [" release-key", "release-key"],
    ["release-key ", "release-key"],
    ["\trelease-key\t", "release-key"],
    [" \trelease key\t ", "release key"],
  ] as const) {
    it(`resolves the configured apiKey ${JSON.stringify(configured)} to the effective ${JSON.stringify(effective)}`, () => {
      expect(
        resolveWorkflowEndpoint(
          settings({ local: { url: "http://localhost:4001", apiKey: configured } }, "local"),
          "local",
        ),
      ).toEqual({ ok: true, endpoint: { name: "local", url: "http://localhost:4001", apiKey: effective } });
    });
  }

  // Anything else a file declares as a key cannot be both sent and redacted as the same bytes - no
  // bytes at all, bytes the transport or a publisher would rewrite, bytes a loopback host refuses -
  // so it refuses the run rather than sending something no surface can redact (US-8, US-35).
  for (const key of [
    "",
    " ",
    "\t",
    " \t ",
    "\u00a0release-key",
    "release-key\u00a0",
    "release\tkey",
    'release"key',
    "release\\key",
    "releasé-key",
    "release\u0000key",
    "release\u007fkey",
  ]) {
    it(`refuses the configured apiKey ${JSON.stringify(key)} naming the setting and echoing no value`, () => {
      const error = expectUnusableCredential(key);

      const quoted = JSON.stringify(key).slice(1, -1);
      if (quoted.trim() !== "") expect(error).not.toContain(quoted);
    });
  }

  // A declared value that is not a string at all is a configured credential, not an absent one:
  // treating it as absence is a silent unauthenticated send (US-8).
  for (const key of [null, 4001, true, { token: "release-key" }, ["release-key"]]) {
    it(`refuses the declared apiKey ${JSON.stringify(key)} rather than sending without a credential`, () => {
      expectUnusableCredential(key);
    });
  }
});

// `%` and `+` are the two path characters a transport or an intermediary can turn into another spelling
// of the same bytes, so a base carrying either refuses: from a base without them every byte this client
// puts in a request target reaches the endpoint as its own bytes (US-35).
describe("a base whose path carries a percent escape or a plus", () => {
  for (const url of [
    "http://release.invalid:4001/k%3C7%3E/v1",
    "http://release.invalid:4001/gateway/double%253C7%253E",
    "http://release.invalid:4001/a%zz/v1",
    "http://release.invalid:4001/x/a+b/y",
    "http://release.invalid:4001/x/%2Bb/y",
  ]) {
    it(`refuses ${url} whatever credential it carries, naming the url and quoting no URL value`, () => {
      const error = expectBrokenEndpointRefusal({ url, apiKey: "release-key" });

      expect(error).toContain("workflows.endpoints[broken].url");
      expect(error).toMatch(/percent|plus/i);
      for (const value of ["release.invalid", "4001", "/gateway", "/x/", "release-key", "%", "+"]) {
        expect(error).not.toContain(value);
      }
    });
  }

  // The rule is on the assembled base, so a host the URL parser itself rewrites into one of these
  // characters refuses too - and an IPv6 literal, which carries neither, still resolves.
  for (const url of ["http://a+b.invalid:4001/gateway", "http://a%2Bb.invalid:4001/gateway"]) {
    it(`refuses the escape or plus in the authority of ${url}`, () => {
      const error = expectBrokenEndpointRefusal({ url, apiKey: "release-key" });

      expect(error).toContain("workflows.endpoints[broken].url");
      expect(error).toMatch(/percent|plus/i);
      for (const value of ["a+b", "a-b", "a%2db", "release.invalid", "release-key"]) expect(error).not.toContain(value);
    });
  }

  it("resolves an IPv6 literal base, whose brackets and colons carry no rewrite hazard", () => {
    expect(
      resolveWorkflowEndpoint(settings({ local: { url: "http://[::1]:4001/gateway" } }, "local"), "local"),
    ).toEqual({ ok: true, endpoint: { name: "local", url: "http://[::1]:4001/gateway" } });
  });

  // A host escape the parser decodes into a harmless byte is not a rewrite hazard: what goes on the
  // wire is the decoded host, so containment and display both see exactly that.
  it("resolves a host escape the URL parser decodes, to the host it actually sends", () => {
    expect(
      resolveWorkflowEndpoint(settings({ local: { url: "http://a%2db.invalid:4001/gateway" } }, "local"), "local"),
    ).toEqual({ ok: true, endpoint: { name: "local", url: "http://a-b.invalid:4001/gateway" } });
  });

  // The pairing `+`-as-space decoding used to leave accepted refuses on the base alone, before the
  // credential is judged at all.
  it("refuses the plus base carrying a key with a space in it, naming only the url", () => {
    const error = expectBrokenEndpointRefusal({ url: "http://release.invalid:4001/x/a+b/y", apiKey: "a b" });

    expect(error).toMatch(/percent|plus/i);
    expect(error).not.toContain("apiKey");
    for (const value of ["a b", "a+b", "release.invalid"]) expect(error).not.toContain(value);
  });
});

// A base and a credential that are each usable on their own, but whose joined request path carries the
// credential as the literal bytes the endpoint will echo. Such a pair is refused as an unusable base or
// key is, so no request carries it (US-35).
describe("a base and credential that would meet on the request path", () => {
  for (const [key, url] of [
    ["probe123", "http://release.invalid:4001/probe123/api"],
    ["release-key", "http://release.invalid:4001/customer-release-key/v1"],
  ] as const) {
    it(`refuses ${url} configured with the credential it carries`, () => {
      const resolution = resolveWorkflowEndpoint(settings({ local: { url, apiKey: key } }, "local"), "local");

      expect(resolution.ok).toBe(false);
      const error = (resolution as { ok: false; error: string }).error;
      expect(error).toMatch(/"local" \(workflows\.endpoints\[local\]\.url and workflows\.endpoints\[local\]\.apiKey\)/);
      expect(error).toMatch(/request path/i);
      expect(error).toContain("Configured endpoints: local.");
      for (const value of [key, encodeURIComponent(key)]) expect(error).not.toContain(value);
    });
  }

  for (const [key, url] of [
    ["release-key", "http://release.invalid:4001/gateway/v1"],
    ["other-key", "http://release.invalid:4001/customer-release-key/v1"],
    ["k<7>", "http://release.invalid:4001/gateway/v1"],
  ] as const) {
    it(`resolves ${url} configured with the credential ${JSON.stringify(key)}`, () => {
      const resolution = resolveWorkflowEndpoint(settings({ local: { url, apiKey: key } }, "local"), "local");

      if (!resolution.ok) throw new Error(`${url} must resolve: ${resolution.error}`);
      expect(resolution.endpoint).toEqual({ name: "local", url, apiKey: key });
    });
  }

  // The literal rule cannot tell a credential that happens to equal part of the route from one the
  // configuration put there, so a key like this refuses whatever its base. Accepted over-refusal.
  it("refuses a credential that equals part of the route every run is sent to", () => {
    const resolution = resolveWorkflowEndpoint(
      settings({ local: { url: "http://release.invalid:4001/gateway/v1", apiKey: "workflows" } }, "local"),
      "local",
    );

    expect(resolution.ok).toBe(false);
  });
});
