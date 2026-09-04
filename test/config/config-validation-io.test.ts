/**
 * config-validation-io.test.ts — Load-time validation through the real
 * file read path: bad values warn once per key, drop from the effective
 * config, keep valid keys, and leave file bytes unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const MOCK_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-validate-global-"));
const GLOBAL_CONFIG_PATH = join(MOCK_AGENT_DIR, "subagents-lite.json");

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => MOCK_AGENT_DIR,
}));

const { createConfigIO, loadConfig, mergeDefaults, mergeLayers } = await import("../../src/config/config-io.js");
const { ConfigStore } = await import("../../src/config/config-store.js");

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pi-subagents-validate-project-"));
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

describe("load-time validation — global layer", () => {
  it("warns on an object-shaped model override, drops it, keeps valid keys", () => {
    writeGlobal({ agent: { default: { model: "x" }, graceTurns: 5 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent).toEqual({ graceTurns: 5 });
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain(GLOBAL_CONFIG_PATH);
      expect(msg).toContain("agent.default");
      expect(msg).toContain("object");
      expect(msg).toContain("string or null");
      expect(msg).toContain("/agents");
      expect(msg).toContain("edit or delete");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on a mistyped non-model key and keeps valid keys", () => {
    writeGlobal({ agent: { graceTurns: "many", showCost: true } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent).toEqual({ showCost: true });
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("agent.graceTurns");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves file bytes unchanged after load with bad values", () => {
    const raw = { agent: { default: { model: "x" }, graceTurns: 5 } };
    writeGlobal(raw);
    const before = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO().load();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(GLOBAL_CONFIG_PATH, "utf-8")).toBe(before);
  });

  it("effective config falls back to defaults for dropped keys", () => {
    writeGlobal({ agent: { default: { model: "x" }, graceTurns: 5 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig();
      expect(config.agent.default).toBeNull();
      expect(config.agent.graceTurns).toBe(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("never migrates fork shapes: the object is dropped, not converted", () => {
    writeGlobal({ agent: { default: { model: "openai/gpt", thinking: "high" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      expect(loaded.global.agent ?? {}).toEqual({});
      expect(mergeDefaults(loaded.global).agent.default).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("load-time validation — project layer", () => {
  it("warns on an object-shaped project model override and stays loaded", () => {
    writeGlobal({ agent: { graceTurns: 5 } });
    writeProject({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      expect(loaded.projectStatus).toBe("loaded");
      expect(loaded.project?.agent ?? {}).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
      const msg = warn.mock.calls[0][0] as string;
      expect(msg).toContain(join(projectDir, "subagents-lite.json"));
      expect(msg).toContain("agent.default");
    } finally {
      warn.mockRestore();
    }
  });

  it("project file bytes stay unchanged after load with bad values", () => {
    writeProject({ agent: { default: { model: "x" } } });
    const projectPath = join(projectDir, "subagents-lite.json");
    const before = readFileSync(projectPath, "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createConfigIO(projectDir).load();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(projectPath, "utf-8")).toBe(before);
  });

  it("merged layers fall back to global when the project key is dropped", () => {
    writeGlobal({ agent: { default: "g/default" } });
    writeProject({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO(projectDir).load();
      const merged = mergeLayers(loaded.global, loaded.project);
      expect(mergeDefaults(merged).agent.default).toBe("g/default");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("load-time validation — runs and menus", () => {
  it("agent runs resolve models with fallback and without throw", () => {
    writeGlobal({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      const store = new ConfigStore({
        load: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        saveGlobal: () => {},
        saveProject: () => {},
      });
      expect(store.modelFor("Explore", "parent/model")).toBe("parent/model");
    } finally {
      warn.mockRestore();
    }
  });

  it("dropped keys read as absent for provenance", () => {
    writeGlobal({ agent: { default: { model: "x" } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const loaded = createConfigIO().load();
      const store = new ConfigStore({
        load: () => ({ global: loaded.global, project: null, projectStatus: "untrusted" }),
        saveGlobal: () => {},
        saveProject: () => {},
      });
      expect(store.hasGlobalModelKey("default")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
