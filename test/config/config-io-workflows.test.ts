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
import type { ConfigIO, RawConfig } from "../../src/config/config-io.js";

const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

const { createConfigIO, mergeLayers, mergeDefaults } = await import("../../src/config/config-io.js");
const { validateRawLayer, validateProjectLayer } = await import("../../src/config/config-validation.js");
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

/** Load one config, keeping what it warned about and the layer the store would run on. */
function warnedLoad(io: ConfigIO): { warnings: string; merged: RawConfig } {
  let layers: ReturnType<ConfigIO["load"]> | undefined;
  const warnings = warned(() => {
    layers = io.load();
  });
  return { warnings, merged: mergeLayers(layers!.global, layers!.project) };
}

function warned(action: () => unknown): string {
  return warningsOf(action).join("\n");
}

/** Every console.warn message the action printed, in order. */
function warningsOf(action: () => unknown): string[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    action();
    return warn.mock.calls.map((call) => String(call[0]));
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
    // The global layer names the target, so it owes the run the refusal it is heading into.
    expect(warnings).toContain("another endpoint");
  });

  it("drops an endpoint that is not an object at all, keeping its name refused", () => {
    const warnings = warned(() => validateRawLayer({ workflows: { endpoints: { odd: "http://h:1" } } }, "/g.json"));

    expect(validateRawLayer({ workflows: { endpoints: { odd: "http://h:1" } } }, "/g.json").workflows).toEqual({
      endpoints: { odd: {} },
    });
    expect(warnings).toContain("workflows.endpoints.odd");
    expect(warnings).toContain("another endpoint");
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
    for (const name of [4001, "", null]) {
      const warnings = warned(() => validateRawLayer({ workflows: { defaultEndpoint: name } }, "/g.json"));

      expect(validateRawLayer({ workflows: { defaultEndpoint: name } }, "/g.json").workflows).toEqual({
        defaultEndpoint: name,
      });
      // The global layer is the one that names the target, so it is the one that owes the refusal.
      expect(warnings).toContain("workflows.defaultEndpoint");
      expect(warnings).toContain("another endpoint");
    }
  });
});

// A project layer decides one thing: the URL of an endpoint the global file names. So the promise a
// warning makes has to match the layer - a value the project declares is the target a run is refused
// against, a value it cannot set is ignored (ADR-0008).
describe("validateProjectLayer — what a project layer may decide", () => {
  it("says nothing about an entry that declares no url, because the global url is inherited", () => {
    const project = { workflows: { endpoints: { release: {} } } };

    expect(validateProjectLayer(project, "/p.json").workflows).toEqual({ endpoints: { release: {} } });
    expect(warned(() => validateProjectLayer(project, "/p.json"))).toBe("");
  });

  it("keeps the refusal warning for a url the project itself declares", () => {
    const warnings = warned(() =>
      validateProjectLayer({ workflows: { endpoints: { release: { url: "" } } } }, "/p.json"),
    );

    expect(warnings).toContain("workflows.endpoints.release.url");
    expect(warnings).toContain("another endpoint");
  });

  it("warns that an entry which is not an object is dropped instead of refused", () => {
    const project = { workflows: { endpoints: { release: "http://typoed-out:4001" } } } as unknown as RawConfig;

    expect(validateProjectLayer(project, "/p.json").workflows).toEqual({ endpoints: { release: {} } });
    const warnings = warned(() => validateProjectLayer(project, "/p.json"));
    expect(warnings).toContain("workflows.endpoints.release");
    expect(warnings).not.toContain("another endpoint");
  });

  it("warns that a default the project sets is not what the run uses", () => {
    const warnings = warned(() => validateProjectLayer({ workflows: { defaultEndpoint: 4001 } }, "/p.json"));

    expect(warnings).toContain("workflows.defaultEndpoint");
    expect(warnings).not.toContain("another endpoint");
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

  // A project entry decides the target only by declaring a url. Declaring one - usable or not - wins;
  // declaring none inherits (ADR-0008: inheritance is absence, and an unsupported key is ignored).
  it("inherits the global url when the project entry declares no url key", () => {
    const merged = mergeLayers(ENDPOINTS, { workflows: { endpoints: { "anagen-x.local": {} } } });

    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
  });

  it("ignores a project entry's unsupported apiKey and inherits the global url and key", () => {
    const merged = mergeLayers(ENDPOINTS, {
      workflows: { endpoints: { "anagen-x.local": { apiKey: "project-key" } } },
    });

    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
  });

  it("inherits the global url when the project entry is not an object at all", () => {
    const project = {
      workflows: { endpoints: { "anagen-x.local": "http://typoed-out:4001" } },
    } as unknown as RawConfig;

    expect(mergeLayers(ENDPOINTS, project).workflows).toEqual(ENDPOINTS.workflows);
  });

  // Present but unusable: the project named the target it wants, so that name must not quietly be
  // answered by the global target - it is the target the run is refused against (US-34).
  it("lets an unusable project url override the global one instead of inheriting it", () => {
    const merged = mergeLayers(ENDPOINTS, { workflows: { endpoints: { "anagen-x.local": { url: "" } } } });

    expect(merged.workflows?.endpoints?.["anagen-x.local"]).toEqual({ url: "", apiKey: "global-key" });
  });

  it("lets a project url the layer carries as null override the global one", () => {
    const merged = mergeLayers(ENDPOINTS, { workflows: { endpoints: { "anagen-x.local": { url: null } } } });

    expect(merged.workflows?.endpoints?.["anagen-x.local"]).toEqual({ url: null, apiKey: "global-key" });
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

  it("keeps a defaultEndpoint the file set to null, so no built-in target answers for it", () => {
    // US-34: an explicitly null default is a configured value that cannot be used, not absence.
    const config = mergeDefaults({
      workflows: { endpoints: { release: { url: "https://release.invalid:4001" } }, defaultEndpoint: null },
    });

    expect(config.workflows.defaultEndpoint).toBeNull();
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
    const project = validateProjectLayer(
      { workflows: { endpoints: { "anagen-x.local": { url: "not a url" } } } },
      "/p.json",
    );

    const resolution = resolveWorkflowEndpoint(mergeDefaults(mergeLayers(global, project)).workflows);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("not a url");
  });

  // The other probe from the review: a null default is a configured value, so the usable named
  // endpoint beside it must not be reached and neither must the built-in target (US-34).
  it("refuses a null default instead of answering with another target", () => {
    const validated = validateRawLayer(
      { workflows: { endpoints: { release: { url: "https://release.invalid:4001" } }, defaultEndpoint: null } },
      "/g.json",
    );

    const resolution = resolveWorkflowEndpoint(mergeDefaults(mergeLayers(validated, null)).workflows);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("null");
  });

  it("names an endpoint that declares no URL at all as the offender", () => {
    // The other half of the wording a reader acts on: nothing anywhere declared a URL for this name, so
    // the file that names the endpoint is the file to fix - not the one that sets the default.
    const validated = validateRawLayer({ workflows: { endpoints: { "anagen-x.local": {} } } }, "/g.json");

    const resolution = resolveWorkflowEndpoint(mergeDefaults(mergeLayers(validated, null)).workflows);

    expect(resolution.ok).toBe(false);
    expect((resolution as { error: string }).error).toContain("declares no usable URL");
  });

  it("reaches the global target a trusted project's entry leaves undeclared", () => {
    const global = validateRawLayer(
      {
        workflows: {
          endpoints: { release: { url: "https://release.invalid:4001", apiKey: "global-key" } },
          defaultEndpoint: "release",
        },
      },
      "/g.json",
    );
    const project = validateProjectLayer({ workflows: { endpoints: { release: {} } } }, "/p.json");

    expect(resolveWorkflowEndpoint(mergeDefaults(mergeLayers(global, project)).workflows)).toEqual({
      ok: true,
      endpoint: { name: "release", url: "https://release.invalid:4001", apiKey: "global-key" },
    });
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

  it("reads a project entry that declares no url as the endpoint the global file named", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { "anagen-x.local": { apiKey: "project-key" } } } });

    const { warnings, merged } = warnedLoad(createConfigIO(projectDir));

    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
    expect(warnings).toContain("workflows.endpoints.anagen-x.local.apiKey");
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

// ADR-0008: a project layer may set model keys, concurrency keys and one endpoint's url. Every other
// setting it carries has no effect, and "no effect" is only honest when the load says so - the same
// warning an ignored agent key already gets.
describe("createConfigIO — warning about a Workflow setting the project layer cannot set", () => {
  it("warns that a project-only endpoint name is ignored", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { staging: { url: "https://staging.invalid:4001" } } } });

    const { warnings, merged } = warnedLoad(createConfigIO(projectDir));

    expect(warnings).toContain("workflows.endpoints.staging");
    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
  });

  it("warns that a defaultEndpoint the project sets is ignored", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { defaultEndpoint: "staging" } });

    const { warnings, merged } = warnedLoad(createConfigIO(projectDir));

    expect(warnings).toContain("workflows.defaultEndpoint");
    expect(merged.workflows).toEqual(ENDPOINTS.workflows);
  });

  // The probe from the review: a key, a name and a default, all supplied by the project, all inert.
  it("names all three ignored Workflow settings in one warning", () => {
    writeGlobal({ workflows: { endpoints: { release: { url: "https://release.invalid:4001" } } } });
    writeProject({
      workflows: {
        endpoints: { release: { apiKey: "project-key" }, staging: { url: "https://staging.invalid:4001" } },
        defaultEndpoint: "staging",
      },
    });

    const warnings = warningsOf(() => createConfigIO(projectDir).load());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("workflows.endpoints.release.apiKey");
    expect(warnings[0]).toContain("workflows.endpoints.staging");
    expect(warnings[0]).toContain("workflows.defaultEndpoint");
    expect(warnings[0]).toContain("only the url of an endpoint");
    // A setting is named; its value is not, so no credential reaches the log.
    expect(warnings[0]).not.toContain("project-key");
  });

  it("says nothing about a url the project is allowed to override", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { "anagen-x.local": { url: "http://internal:4001" } } } });

    const { warnings, merged } = warnedLoad(createConfigIO(projectDir));

    expect(warnings).toBe("");
    expect(merged.workflows?.endpoints?.["anagen-x.local"].url).toBe("http://internal:4001");
  });

  it("names only the apiKey of an entry whose url it applies", () => {
    writeGlobal(ENDPOINTS);
    writeProject({
      workflows: { endpoints: { "anagen-x.local": { url: "http://internal:4001", apiKey: "project-key" } } },
    });

    const { warnings, merged } = warnedLoad(createConfigIO(projectDir));

    expect(warnings).toContain("workflows.endpoints.anagen-x.local.apiKey");
    expect(warnings).not.toContain("workflows.endpoints.anagen-x.local.url");
    expect(merged.workflows?.endpoints?.["anagen-x.local"].url).toBe("http://internal:4001");
  });

  it("does not repeat an ignored-key warning for a value the loader already refused", () => {
    const carried: unknown[] = [
      { workflows: { endpoints: { "anagen-x.local": { apiKey: 7 } } } },
      { workflows: { endpoints: { "anagen-x.local": "http://typoed-out:4001" } } },
      { workflows: { defaultEndpoint: 4001 } },
    ];
    for (const project of carried) {
      writeGlobal(ENDPOINTS);
      writeProject(project);

      const warnings = warningsOf(() => createConfigIO(projectDir).load());

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Incompatible value");
    }
  });

  it("warns once per load even where the store merges the layers again", () => {
    writeGlobal(ENDPOINTS);
    writeProject({ workflows: { endpoints: { staging: { url: "https://staging.invalid:4001" } } } });
    const io = createConfigIO(projectDir);

    const warnings = warningsOf(() => {
      const store = new ConfigStore(io);
      store.mutate.agent.clearAllModelOverrides("project");
      store.reload();
    });

    expect(warnings.filter((message) => message.includes("Ignoring unknown keys"))).toHaveLength(1);
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

  it("keeps a defaultEndpoint the file set to null instead of the built-in name", () => {
    const { io } = memIO({
      global: {
        workflows: { endpoints: { release: { url: "https://release.invalid:4001" } }, defaultEndpoint: null },
      },
      project: null,
      projectStatus: "absent",
    });

    expect(new ConfigStore(io).workflows).toEqual({
      endpoints: {
        release: { url: "https://release.invalid:4001" },
        "anagen-x.local": { url: "http://localhost:4001" },
      },
      defaultEndpoint: null,
    });
  });

  it("inherits the endpoint a project entry leaves undeclared", () => {
    const { io } = memIO({
      global: { workflows: { endpoints: { local: { url: "http://g:1", apiKey: "k" } }, defaultEndpoint: "local" } },
      project: { workflows: { endpoints: { local: { apiKey: "project-key" } } } },
      projectStatus: "loaded",
    });

    expect(new ConfigStore(io).workflows.endpoints.local).toEqual({ url: "http://g:1", apiKey: "k" });
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
