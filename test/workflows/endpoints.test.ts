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

function settings(endpoints: SubagentsConfig["workflows"]["endpoints"], defaultEndpoint: string) {
  return { endpoints, defaultEndpoint };
}

const CONFIGURED = settings(
  {
    local: { url: "http://localhost:4001" },
    release: { url: "https://anagen-x.internal:4001", apiKey: "release-key" },
  },
  "local",
);

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
    expect(resolveWorkflowEndpoint(CONFIGURED, null)).toEqual({
      ok: true,
      endpoint: { name: "local", url: "http://localhost:4001" },
    });
  });

  it("names an endpoint key the file carries that is not configured, and lists the ones that are", () => {
    const resolution = resolveWorkflowEndpoint(CONFIGURED, "missing-target");

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("missing-target");
    expect((resolution as { error: string }).error).toContain("local");
    expect((resolution as { error: string }).error).toContain("release");
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

  for (const url of ["not a valid URL", "", "localhost:4001", "ftp://host:4001"]) {
    it(`refuses the endpoint whose url is ${JSON.stringify(url)}`, () => {
      const resolution = resolveWorkflowEndpoint(settings({ broken: { url } }, "broken"));

      expect(resolution.ok).toBe(false);
      expect((resolution as { error: string }).error).toContain("broken");
      expect((resolution as { error: string }).error).toContain(url);
    });
  }
});
