/**
 * config-io-project-file.test.ts — Project config as an override layer
 * (ADR-0008): the project file's model/concurrency keys merge over the global
 * file; absent keys inherit. Unknown keys are ignored with a warning, a
 * malformed file is never written, and per-layer saves touch only their layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Per-run temp dirs: must never read a real user config file.
const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { createConfigIO, loadConfig, mergeLayers, mergeDefaults } = await import("../../src/config/config-io.js");

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

/** Write raw text (e.g. malformed JSON) to the project file. */
function writeProjectRaw(text: string): void {
  writeFileSync(join(projectDir, "subagents-lite.json"), text);
}

function readProjectFile(): unknown {
  return JSON.parse(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8"));
}

describe("createConfigIO load — two-layer override model", () => {
  it("returns the raw global and project layers with status loaded", () => {
    writeGlobal({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });
    writeProject({ agent: { default: "p/default" }, concurrency: { default: 8 } });

    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("loaded");
    expect(loaded.global).toEqual({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });
    expect(loaded.project).toEqual({ agent: { default: "p/default" }, concurrency: { default: 8 } });
  });

  it("reports untrusted and no project layer when created without a project dir", () => {
    const loaded = createConfigIO().load();

    expect(loaded.projectStatus).toBe("untrusted");
    expect(loaded.project).toBeNull();
    expect(loaded.global).toEqual({});
  });

  it("reports absent when the trusted project has no config file yet", () => {
    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("absent");
    expect(loaded.project).toBeNull();
  });

  it("an empty project file is inert: loaded as an empty layer", () => {
    writeProject({});

    const loaded = createConfigIO(projectDir).load();

    expect(loaded.projectStatus).toBe("loaded");
    expect(loaded.project).toEqual({});
  });

  it("ignores a malformed JSON project file with a warning; status malformed", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProjectRaw("{ not json !!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      expect(loaded.projectStatus).toBe("malformed");
      expect(loaded.project).toBeNull();
      // The global layer still loads.
      expect(loaded.global).toEqual({ agent: { graceTurns: 5 } });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("treats structurally invalid project files as malformed", () => {
    const violations = [
      { agent: "nope" },
      { concurrency: "nope" },
      { concurrency: { providers: 5 } },
      { concurrency: { models: [] } },
      [1, 2],
      "text",
      42,
      null,
    ];
    for (const bad of violations) {
      writeProject(bad);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const loaded = createConfigIO(projectDir).load();
        expect(loaded.projectStatus).toBe("malformed");
        expect(loaded.project).toBeNull();
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("warns once about unknown project keys, per IO instance", () => {
    // graceTurns is a global-only setting: not allowed in the project file.
    writeProject({ agent: { default: "p/default", graceTurns: 9 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      io.load();
      io.load();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("graceTurns"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a project file with only model and concurrency keys", () => {
    writeProject({
      agent: { default: "p", Explore: "p/x", defaultThinking: "high", defaultMaxTurns: 3 },
      concurrency: { default: 2, providers: { a: 1 }, models: { b: 2 } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO(projectDir).load();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("strips the legacy finishedEvictTurns key from the global layer at load", () => {
    writeGlobal({ agent: { finishedEvictTurns: 7, graceTurns: 5 } });

    const loaded = createConfigIO().load();

    expect("finishedEvictTurns" in loaded.global.agent!).toBe(false);
    expect(loaded.global.agent).toEqual({ graceTurns: 5 });
  });
});

describe("mergeLayers — project over global, per key", () => {
  it("project agent keys override global; absent keys inherit", () => {
    const merged = mergeLayers({ agent: { default: "g", Explore: "g/x", graceTurns: 5 } }, { agent: { default: "p" } });

    expect(merged.agent).toEqual({ default: "p", Explore: "g/x", graceTurns: 5 });
  });

  it("drops project agent keys that are not model keys", () => {
    const merged = mergeLayers(
      { agent: { default: "g" } },
      { agent: { default: "p", graceTurns: 9, widgetMaxLines: 3 } },
    );

    expect(merged.agent).toEqual({ default: "p" });
  });

  it("keeps an explicit null project default as an override", () => {
    const merged = mergeLayers({ agent: { default: "g" } }, { agent: { default: null } });

    expect(merged.agent).toEqual({ default: null });
  });

  it("merges concurrency per entry: default wins, providers/models combine", () => {
    const merged = mergeLayers(
      { concurrency: { default: 2, providers: { llamacpp: 1, openai: 2 }, models: { a: 1 } } },
      { concurrency: { default: 8, providers: { llamacpp: 3 } } },
    );

    expect(merged.concurrency).toEqual({
      default: 8,
      providers: { llamacpp: 3, openai: 2 },
      models: { a: 1 },
    });
  });

  it("project provider/model entries fall through to global entries", () => {
    const merged = mergeLayers(
      { concurrency: { providers: { llamacpp: 1 } } },
      { concurrency: { providers: { openai: 2 } } },
    );

    expect(merged.concurrency).toEqual({ providers: { llamacpp: 1, openai: 2 } });
  });

  it("with no project layer, the global layer passes through", () => {
    expect(mergeLayers({ agent: { default: "g" }, concurrency: { default: 2 } }, null)).toEqual({
      agent: { default: "g" },
      concurrency: { default: 2 },
    });
  });

  it("empty layers merge to empty sections without explicit undefined default", () => {
    const merged = mergeLayers({}, {});

    expect(merged.agent).toEqual({});
    expect("default" in merged.concurrency!).toBe(false);
    expect(merged.concurrency).toEqual({});
  });
});

describe("mergeDefaults / loadConfig", () => {
  it("bakes built-in defaults for absent keys", () => {
    const config = mergeDefaults({ agent: { default: "x" }, concurrency: { default: 2 } });

    expect(config.agent.graceTurns).toBe(6);
    expect(config.agent.widgetMaxLines).toBe(12);
    expect(config.agent.showCost).toBe(false);
    expect(config.concurrency.providers).toBeUndefined();
  });

  it("strips the legacy finishedEvictTurns key from the effective agent", () => {
    const config = mergeDefaults({ agent: { finishedEvictTurns: 7, forceBackground: true } });

    expect("finishedEvictTurns" in config.agent).toBe(false);
    expect(config.agent.forceBackground).toBe(true);
  });

  it("loadConfig merges only the global file", () => {
    writeGlobal({ agent: { default: "g", graceTurns: 5 }, concurrency: { default: 2 } });
    writeProject({ agent: { default: "p" } });

    expect(loadConfig()).toEqual(
      mergeDefaults({ agent: { default: "g", graceTurns: 5 }, concurrency: { default: 2 } }),
    );
  });
});

describe("createConfigIO save — per-layer writes", () => {
  it("saveGlobal writes only the global file, leaving the project file untouched", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { default: "p" } });
    const io = createConfigIO(projectDir);
    io.load();

    io.saveGlobal({ agent: { graceTurns: 9 } });

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({ agent: { graceTurns: 9 } });
    expect(readProjectFile()).toEqual({ agent: { default: "p" } });
  });

  it("saveProject writes only the project file, leaving the global file untouched", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    io.load();

    io.saveProject({ agent: { graceTurns: 12 } });

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 12 } });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { graceTurns: 5, showCost: true },
    });
  });

  it("the first saveProject in a trusted project without a file creates it", () => {
    const io = createConfigIO(projectDir);
    io.load();

    io.saveProject({ agent: { default: "p" } });

    expect(readProjectFile()).toEqual({ agent: { default: "p" } });
  });

  it("saveProject refuses to write a malformed project file; bytes untouched", () => {
    writeProjectRaw("{ not json !!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const io = createConfigIO(projectDir);
      io.load();

      io.saveProject({ agent: { default: "p" } });

      expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8")).toBe("{ not json !!");
      // One warning for the malformed load, one for the refused save.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("saveProject without a trusted project dir writes nothing", () => {
    const io = createConfigIO();
    io.load();

    io.saveProject({ agent: { default: "p" } });

    expect(existsSync(join(projectDir, "subagents-lite.json"))).toBe(false);
  });
});
