/**
 * config-io-workflows.test.ts — The `workflows` config section (US-6, US-35).
 *
 * Named endpoints with a default, load-time validation of every key the section can carry, and
 * the project layer's narrowed power: a trusted project may override the URL of a globally named
 * endpoint and nothing else — keys, names and the default stay global (ADR-0008 as amended).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vite-plus/test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

const { createConfigIO, mergeLayers, mergeDefaults } = await import("../../src/config/config-io.js");
const { validateRawLayer } = await import("../../src/config/config-validation.js");
const { ConfigStore } = await import("../../src/config/config-store.js");
const { resolveWorkflowEndpoint } = await import("../../src/workflows/endpoints.js");
const { memIO } = await import("./config-store-helpers.js");

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-subagents-project-"));
  rmSync(GLOBAL_CONFIG_PATH, { force: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(MOCK_AGENT_DIR, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config));
}

function writeProject(config: unknown): void {
  writeFileSync(join(projectDir, "subagents-lite.json"), JSON.stringify(config));
}

function warned(action: () => unknown): string {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    action();
    return warn.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    warn.mockRestore();
  }
}

const ENDPOINTS = {
  workflows: {
    endpoints: { "anagen-x.local": { url: "http://localhost:4001", apiKey: "global-key" } },
    defaultEndpoint: "anagen-x.local",
  },
};

describe("validateRawLayer — workflows", () => {
  it("keeps a named endpoint, its key and the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(validateRawLayer(ENDPOINTS, "/g.json").workflows).toEqual(ENDPOINTS.workflows);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a named endpoint whose url is unusable, and names it", () => {
    const warnings = warned(() =>
      validateRawLayer(
        {
          workflows: {
            endpoints: { good: { url: "http://h:1" }, keyless: {}, blank: { url: "" }, numeric: { url: 4001 } },
          },
        },
        "/g.json",
      ),
    );

    // US-34: dropping the entry would hand the name to another target, so only the value is
    // refused - later, by the run that names it - and the entry itself stays.
    expect(
      validateRawLayer(
        { workflows: { endpoints: { keyless: {}, blank: { url: "" }, numeric: { url: 4001 } } } },
        "/g.json",
      ).workflows,
    ).toEqual({
      endpoints: { keyless: {}, blank: { url: "" }, numeric: { url: 4001 } },
    });
    expect(warnings).toContain("workflows.endpoints.keyless");
    expect(warnings).toContain("workflows.endpoints.numeric");
    expect(warnings).toContain("workflows.endpoints.blank");
  });

  it("drops an endpoint that is not an object at all, keeping its name refused", () => {
    const warnings = warned(() => validateRawLayer({ workflows: { endpoints: { odd: "http://h:1" } } }, "/g.json"));

    expect(validateRawLayer({ workflows: { endpoints: { odd: "http://h:1" } } }, "/g.json").workflows).toEqual({
      endpoints: { odd: {} },
    });
    expect(warnings).toContain("workflows.endpoints.odd");
  });

  it("keeps an endpoint whose key is the wrong shape and drops just the key", () => {
    const warnings = warned(() =>
      validateRawLayer({ workflows: { endpoints: { odd: { url: "http://h:1", apiKey: 7 } } } }, "/g.json"),
    );

    expect(warnings).toContain("workflows.endpoints.odd.apiKey");
  });

  it("drops malformed sections and values instead of crashing", () => {
    const cases: unknown[] = [
      { workflows: "nope" },
      { workflows: { endpoints: "nope" } },
      { workflows: { endpoints: [1] } },
    ];
    for (const bad of cases) {
      expect(validateRawLayer(bad, "/g.json").workflows).toBeUndefined();
    }
  });

  it("keeps a defaultEndpoint that is not a name, so the run is refused rather than defaulted", () => {
    for (const name of [4001, ""]) {
      const warnings = warned(() => validateRawLayer({ workflows: { defaultEndpoint: name } }, "/g.json"));

      expect(validateRawLayer({ workflows: { defaultEndpoint: name } }, "/g.json").workflows).toEqual({
        defaultEndpoint: name,
      });
      expect(warnings).toContain("workflows.defaultEndpoint");
    }
  });
});

describe("mergeLayers — a project layer may override a url only", () => {
  it("takes the project url for a globally named endpoint and keeps its key", () => {
    const merged = mergeLayers(ENDPOINTS, {
      workflows: { endpoints: { "anagen-x.local": { url: "http://anagen-x.internal:4001", apiKey: "project-key" } } },
    });

    expect(merged.workflows).toEqual({
      endpoints: { "anagen-x.local": { url: "http://anagen-x.internal:4001", apiKey: "global-key" } },
      defaultEndpoint: "anagen-x.local",
    });
  });

  it("ignores a project-only endpoint name and a project default", () => {
    const merged = mergeLayers(ENDPOINTS, {
      workflows: { endpoints: { other: { url: "http://elsewhere:1" } }, defaultEndpoint: "other" },
    });

    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
  });

  it("lets an unusable project url override the global one instead of inheriting it", () => {
    const merged = mergeLayers(ENDPOINTS, { workflows: { endpoints: { "anagen-x.local": { url: "" } } } });

    expect(merged.workflows?.endpoints?.["anagen-x.local"]).toEqual({ url: "", apiKey: "global-key" });
  });

  it("with no project section the global one passes through", () => {
    expect(mergeLayers(ENDPOINTS, null).workflows).toEqual(ENDPOINTS.workflows);
    expect(mergeLayers({}, {}).workflows).toBeUndefined();
  });
});

describe("mergeDefaults — the built-in local endpoint", () => {
  it("bakes the built-in endpoint and default when nothing is configured", () => {
    expect(mergeDefaults({}).workflows).toEqual({
      endpoints: { "anagen-x.local": { url: "http://localhost:4001" } },
      defaultEndpoint: "anagen-x.local",
    });
  });

  it("takes a configured entry and default over the built-ins", () => {
    const config = mergeDefaults({
      workflows: { endpoints: { "anagen-x.local": { url: "http://localhost:5000" } }, defaultEndpoint: "other" },
    });

    expect(config.workflows).toEqual({
      endpoints: { "anagen-x.local": { url: "http://localhost:5000" } },
      defaultEndpoint: "other",
    });
  });

  it("bakes a built-in target only under a name nothing configured", () => {
    const configured = mergeDefaults({ workflows: { endpoints: { "anagen-x.local": { url: "" } } } });

    expect(configured.workflows).toEqual({
      endpoints: { "anagen-x.local": { url: "" } },
      defaultEndpoint: "anagen-x.local",
    });
    expect(mergeDefaults({ workflows: { defaultEndpoint: "" } }).workflows?.defaultEndpoint).toBe("");
  });
});

describe("a configured target that cannot be used", () => {
  it("is refused through the whole load path instead of falling back to the built-in target", () => {
    // The probe from the review: configuring the built-in name with an empty URL used to answer with
    // success against http://localhost:4001 (US-34's no-fallback rule).
    const validated = validateRawLayer({ workflows: { endpoints: { "anagen-x.local": { url: "" } } } }, "/g.json");

    const resolution = resolveWorkflowEndpoint(mergeDefaults(mergeLayers(validated, null)).workflows);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("anagen-x.local");
  });

  it("stays refused when a trusted project's override is the broken one", () => {
    const global = validateRawLayer(ENDPOINTS, "/g.json");
    const project = validateRawLayer(
      { workflows: { endpoints: { "anagen-x.local": { url: "not a url" } } } },
      "/p.json",
    );

    const resolution = resolveWorkflowEndpoint(mergeDefaults(mergeLayers(global, project)).workflows);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("not a url");
  });
});

describe("createConfigIO — the workflows section on disk", () => {
  it("loads both layers in a trusted project", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { "anagen-x.local": { url: "http://internal:4001" } } } });

    const loaded = createConfigIO(projectDir).load();

    expect(loaded.global.workflows).toEqual(ENDPOINTS.workflows);
    expect(mergeLayers(loaded.global, loaded.project).workflows?.endpoints?.["anagen-x.local"]).toEqual({
      url: "http://internal:4001",
      apiKey: "global-key",
    });
  });

  it("never reads a project layer without a project dir", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { "anagen-x.local": { url: "http://internal:4001" } } } });

    expect(createConfigIO().load().project).toBeNull();
  });

  it("treats a project file whose workflows section is not an object as malformed", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: "nope" });
    const warnings = warned(() => createConfigIO(projectDir).load());

    expect(warnings).toContain("workflows");
    expect(createConfigIO(projectDir).load().project).toBeNull();
  });

  it("leaves the section untouched while saving an unrelated key", () => {
    writeGlobal({ ...ENDPOINTS, agent: { graceTurns: 5 } });
    const io = createConfigIO(projectDir);
    io.load();

    io.saveGlobal({ ...ENDPOINTS, agent: { graceTurns: 9 } });

    expect((JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")) as { workflows?: unknown }).workflows).toEqual(
      ENDPOINTS.workflows,
    );
  });
});

describe("ConfigStore — the effective workflows section", () => {
  it("reports the merged endpoints and default", () => {
    const { io } = memIO({
      global: { workflows: { endpoints: { local: { url: "http://g:1", apiKey: "k" } }, defaultEndpoint: "local" } },
      project: { workflows: { endpoints: { local: { url: "http://p:2" } } } },
      projectStatus: "loaded",
    });
    const store = new ConfigStore(io);

    expect(store.workflows.endpoints.local).toEqual({ url: "http://p:2", apiKey: "k" });
    expect(store.workflows.defaultEndpoint).toBe("local");
  });

  it("reports an unusable configured target, not the built-in one", () => {
    const { io } = memIO({
      global: { workflows: { endpoints: { "anagen-x.local": { url: "" } } } },
      project: null,
      projectStatus: "absent",
    });

    expect(new ConfigStore(io).workflows).toEqual({
      endpoints: { "anagen-x.local": { url: "" } },
      defaultEndpoint: "anagen-x.local",
    });
  });

  for (const target of ["global", "project", "all"] as const) {
    it(`keeps the workflows section through clearAllModelOverrides at ${target}`, () => {
      const { io, global: savedGlobal } = memIO({
        global: {
          agent: { default: "g", Explore: "g/x", graceTurns: 5 },
          workflows: { endpoints: { local: { url: "http://g:1" } }, defaultEndpoint: "local" },
        },
        project: { agent: { default: "p" }, workflows: { endpoints: { local: { url: "http://p:2" } } } },
        projectStatus: "loaded",
      });
      const store = new ConfigStore(io);

      store.mutate.agent.clearAllModelOverrides(target);

      expect(store.workflows.endpoints.local).toEqual({ url: "http://p:2" });
      expect(store.workflows.defaultEndpoint).toBe("local");
      expect(savedGlobal().workflows).toEqual({
        endpoints: { local: { url: "http://g:1" } },
        defaultEndpoint: "local",
      });
    });
  }
});
