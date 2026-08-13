/**
 * config-io-project-file.test.ts — Project-level config: `.pi/subagents-lite.json`.
 *
 * When a valid project file exists it is used as the ENTIRE config; the global
 * file is not read. When it is absent or malformed, the global file is used
 * exactly as today. One file wins, wholly: no merging, no diffs, no tombstones
 * (project-level-config v2).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Spy on the file actually read, to pin "the global file is not read" (AC).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

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
  vi.mocked(readFileSync).mockClear();
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

describe("createConfigIO load — project file wins wholesale", () => {
  it("uses the project file as the entire config; global values do not leak", () => {
    writeGlobal({
      agent: { graceTurns: 5, showCost: true },
      concurrency: { providers: { llamacpp: 2 } },
    });
    writeProject({ agent: { graceTurns: 9 } });

    const config = createConfigIO(projectDir).load();

    expect(config.agent.graceTurns).toBe(9);
    // Default, not the global file's value: the project file replaces it entirely.
    expect(config.agent.showCost).toBe(false);
    expect(config.concurrency).toEqual({ default: 4 });
  });

  it("does not read the global file when a valid project file exists", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { graceTurns: 9 } });

    const config = createConfigIO(projectDir).load();

    expect(config.agent.graceTurns).toBe(9);
    const readPaths = vi.mocked(readFileSync).mock.calls.map((c) => c[0]);
    expect(readPaths).toEqual([join(projectDir, "subagents-lite.json")]);
  });

  it("an empty project file is valid and means defaults only", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({});

    const config = createConfigIO(projectDir).load();

    expect(config.agent.graceTurns).toBe(6);
    expect(config.agent.showCost).toBe(false);
    expect(config.concurrency.default).toBe(4);
  });

  it("applies legacy-key normalization to the loaded file", () => {
    writeGlobal({ agent: { finishedRetentionMinutes: 3 } });
    writeProject({ agent: { finishedEvictTurns: 7 } });

    const config = createConfigIO(projectDir).load();

    expect("finishedEvictTurns" in config.agent).toBe(false);
    // Built-in default, not the global file's value.
    expect(config.agent.finishedRetentionMinutes).toBe(1);
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

  it("matches the global-only load byte-for-byte when no project file exists", () => {
    writeGlobal({ agent: { graceTurns: 5 }, concurrency: { default: 2 } });

    expect(createConfigIO(projectDir).load()).toEqual(loadConfig());
    expect(createConfigIO().load()).toEqual(loadConfig());
  });
});

describe("createConfigIO save — full config to the file in use", () => {
  it("persists the full effective config to the project file when it exists", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 12;
    io.save(config);

    const saved = readProjectFile() as { agent: { graceTurns: number } };
    expect(saved.agent.graceTurns).toBe(12);
    expect(saved).toEqual(config);
    // The global file is untouched.
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual({
      agent: { graceTurns: 5, showCost: true },
    });
  });

  it("with no project file, saves the full config to the global file as today", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    const io = createConfigIO(projectDir);
    const config = io.load();
    config.agent.graceTurns = 9;
    io.save(config);

    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"))).toEqual(config);
    expect(existsSync(join(projectDir, "subagents-lite.json"))).toBe(false);
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
});

describe("ConfigStore with project IO", () => {
  it("reads project values and persists menu changes to the project file only", () => {
    writeGlobal({ agent: { graceTurns: 5, showCost: true } });
    writeProject({ agent: { graceTurns: 9 } });
    const store = new ConfigStore(createConfigIO(projectDir));

    expect(store.agent.graceTurns).toBe(9);
    expect(store.agent.showCost).toBe(false);

    store.mutate.agent.setGraceTurns(12);

    expect((readProjectFile() as { agent: { graceTurns: number } }).agent.graceTurns).toBe(12);
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).agent.graceTurns).toBe(5);
    store.reload();
    expect(store.agent.graceTurns).toBe(12);
  });

  it("a saved project file contains the full effective config", () => {
    writeProject({ agent: { graceTurns: 9 } });
    const store = new ConfigStore(createConfigIO(projectDir));

    store.mutate.agent.setGraceTurns(12);

    const saved = readProjectFile() as {
      agent: { graceTurns: number; widgetMaxLines: number };
      concurrency: { default: number };
    };
    expect(saved.agent.graceTurns).toBe(12);
    expect(saved.agent.widgetMaxLines).toBe(12); // built-in default baked in
    expect(saved.concurrency.default).toBe(4);
  });

  it("applies clamping to the loaded file", () => {
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
    expect((readProjectFile() as { agent: { graceTurns: number } }).agent.graceTurns).toBe(11);
  });

  it("persists removing a provider across reload", () => {
    writeGlobal({ concurrency: { providers: { llamacpp: 1, openai: 2 } } });
    writeProject({ concurrency: { providers: { llamacpp: 1 } } });
    const store = new ConfigStore(createConfigIO(projectDir));
    expect(store.concurrency.providers).toEqual({ llamacpp: 1 });

    store.mutate.concurrency.removeProvider("llamacpp");

    expect((readProjectFile() as { concurrency: { providers: object } }).concurrency.providers).toEqual({});
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).concurrency.providers).toEqual({
      llamacpp: 1,
      openai: 2,
    });
    store.reload();
    expect(store.concurrency.providers).toEqual({});
  });

  it("persists resetting concurrency across reload", () => {
    writeGlobal({ concurrency: { default: 2, providers: { llamacpp: 1 } } });
    writeProject({ concurrency: { default: 8, providers: { llamacpp: 3 } } });
    const store = new ConfigStore(createConfigIO(projectDir));
    expect(store.concurrency.default).toBe(8);

    store.mutate.concurrency.reset();

    const saved = readProjectFile() as { concurrency: { default: number; providers?: object } };
    expect(saved.concurrency.default).toBe(4);
    expect(saved.concurrency.providers).toBeUndefined();
    expect(JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).concurrency.default).toBe(2);
    store.reload();
    expect(store.concurrency.default).toBe(4);
    expect(store.concurrency.providers).toEqual({});
  });

  it("persists clearing a per-type model override across reload; the global file never reapplies", () => {
    writeGlobal({ agent: { Explore: "g/explore", general: "g/general" } });
    writeProject({ agent: { Explore: "p/explore" } });
    const store = new ConfigStore(createConfigIO(projectDir));
    expect(store.agentConfigSnapshot().Explore).toBe("p/explore");

    store.mutate.agent.clearModelOverride("Explore");

    const saved = readProjectFile() as { agent: { Explore?: string; general?: string } };
    expect(saved.agent.Explore).toBeUndefined();
    // The project file is the entire config: the global file's overrides do not return.
    expect(saved.agent.general).toBeUndefined();
    store.reload();
    expect(store.agentConfigSnapshot().Explore).toBeUndefined();
    expect(store.agentConfigSnapshot().general).toBeUndefined();
  });
});
