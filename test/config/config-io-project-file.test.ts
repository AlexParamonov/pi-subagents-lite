/**
 * config-io-project-file.test.ts — Project-level config: `.pi/subagents-lite.json`
 * merges over the global `~/.pi/agent/subagents-lite.json` per field, with
 * validation/normalization applied to the merged result (project-level-config).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Per-run temp dirs: must never read a real user config file.
const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

// Import after mock is set up
const { createConfigIO, loadConfig } = await import("../../src/config/config-io.js");
const { ConfigStore } = await import("../../src/config/config-store.js");

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
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "subagents-lite.json"), JSON.stringify(config));
}

/** Write raw text (e.g. malformed JSON) to the project file. */
function writeProjectRaw(text: string): void {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "subagents-lite.json"), text);
}

function readProjectFile(): unknown {
  return JSON.parse(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8"));
}

describe("createConfigIO load — project over global per field", () => {
  it("lets the project file override the global file per field", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });

    const config = createConfigIO(projectDir).load();

    expect(config.agent.graceTurns).toBe(9);
    expect(config.agent.showCost).toBe(true);
  });

  it("keeps fields present only in the global file", () => {
    writeGlobal({ agent: { showCost: true }, concurrency: { providers: { llamacpp: 2 } } });
    writeProject({ agent: { graceTurns: 9 } });

    const config = createConfigIO(projectDir).load();

    expect(config.agent.showCost).toBe(true);
    expect(config.concurrency.providers).toEqual({ llamacpp: 2 });
  });

  it("merges concurrency per key at both nesting levels", () => {
    writeGlobal({ concurrency: { default: 4, providers: { a: 1, b: 2 }, models: { m1: 3 } } });
    writeProject({ concurrency: { default: 8, providers: { b: 5 } } });

    const config = createConfigIO(projectDir).load();

    expect(config.concurrency.default).toBe(8);
    expect(config.concurrency.providers).toEqual({ a: 1, b: 5 });
    expect(config.concurrency.models).toEqual({ m1: 3 });
  });

  it("merges per-type model overrides per type", () => {
    writeGlobal({ agent: { Explore: "g/explore", general: "g/general" } });
    writeProject({ agent: { Explore: "p/explore" } });

    const config = createConfigIO(projectDir).load();

    expect(config.agent.Explore).toBe("p/explore");
    expect(config.agent.general).toBe("g/general");
  });

  it("applies legacy-key normalization to the merged result", () => {
    writeGlobal({ agent: { finishedEvictTurns: 7, finishedRetentionMinutes: 3 } });
    writeProject({ agent: { graceTurns: 9 } });

    const config = createConfigIO(projectDir).load();

    expect("finishedEvictTurns" in config.agent).toBe(false);
    expect(config.agent.finishedRetentionMinutes).toBe(3);
  });

  it("matches the global-only load byte-for-byte when no project file exists", () => {
    writeGlobal({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });

    expect(createConfigIO(projectDir).load()).toEqual(loadConfig());
    expect(createConfigIO().load()).toEqual(loadConfig());
  });

  it("ignores a malformed project file with a warning and still loads the global file", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProjectRaw("{ not json !!");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = createConfigIO(projectDir).load();
      expect(config.agent.graceTurns).toBe(5);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createConfigIO save — project write-back", () => {
  it("persists menu changes to the project file only when it exists", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 12;
    io.save(config);

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 12 } });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { graceTurns: 5, showCost: true },
    });
  });

  it("does not copy global-only or default values into the project file", () => {
    writeGlobal({ agent: { showCost: true } });
    writeProject({});
    const io = createConfigIO(projectDir);
    io.save(io.load());

    expect(readProjectFile()).toEqual({});
  });

  it("writes a key changed away from the global value into the project file", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({});
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 7;
    io.save(config);

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 7 } });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).agent.graceTurns).toBe(5);
  });

  it("drops a project key reset back to the global value", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 5;
    io.save(config);

    expect(readProjectFile()).toEqual({});
  });

  it("drops a deleted per-type model override so it cannot resurrect from the project file", () => {
    writeGlobal({ agent: { Explore: "g/explore" } });
    writeProject({ agent: { Explore: "p/explore", graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    delete config.agent.Explore;
    io.save(config);

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 9 } });
  });

  it("drops a deleted concurrency provider so it cannot resurrect from the project file", () => {
    writeGlobal({});
    writeProject({ concurrency: { providers: { llamacpp: 2 } } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    delete config.concurrency.providers!.llamacpp;
    io.save(config);

    expect(readProjectFile()).toEqual({});
  });

  it("merges concurrency diffs per key at both nesting levels", () => {
    writeGlobal({ concurrency: { default: 4, providers: { a: 1, b: 2 }, models: { m1: 3 } } });
    writeProject({ concurrency: { default: 4, providers: { b: 5 } } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.concurrency.providers!.b = 9;
    config.concurrency.models = { m1: 3, m2: 1 };
    io.save(config);

    expect(readProjectFile()).toEqual({
      concurrency: { providers: { b: 9 }, models: { m2: 1 } },
    });
  });

  it("with a malformed project file, saves go to the global file and the malformed file is untouched", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProjectRaw("{ not json !!");
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 7;
    io.save(config);

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).agent.graceTurns).toBe(7);
    expect(readFileSync(join(projectDir, "subagents-lite.json"), "utf-8")).toBe("{ not json !!");
  });

  it("with no project file, saves the full config to the global file as today", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 9;
    io.save(config);

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).agent.graceTurns).toBe(9);
  });
});

describe("ConfigStore with project IO", () => {
  it("reads merged values and persists menu changes to the project file only", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const store = new ConfigStore(createConfigIO(projectDir));

    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.showCost).toBe(true);

    store.mutate.agent.setGraceTurns(12);

    expect(readProjectFile()).toEqual({ agent: { graceTurns: 12 } });
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).agent.graceTurns).toBe(5);
  });

  it("applies clamping to the merged values, not per file", () => {
    writeGlobal({ agent: { finishedRetentionMinutes: 3 } });
    writeProject({ agent: { finishedRetentionMinutes: 0 } });
    const store = new ConfigStore(createConfigIO(projectDir));

    expect(store.agent.finishedRetentionMinutes).toBeCloseTo(1 / 60, 5);
  });

  it("setProjectDir retargets persistence and reload picks up the project file", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { graceTurns: 9 } });
    const store = new ConfigStore(createConfigIO());
    expect(store.agent.graceTurns).toBe(5);

    store.setProjectDir(projectDir);
    store.reload();
    expect(store.agent.graceTurns).toBe(9);

    store.mutate.agent.setGraceTurns(11);
    expect(readProjectFile()).toEqual({ agent: { graceTurns: 11 } });
  });
});
