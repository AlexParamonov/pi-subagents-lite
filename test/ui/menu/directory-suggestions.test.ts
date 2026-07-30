/**
 * directory-suggestions.test.ts — Tests for createDirectorySuggestions.
 *
 * Tests the autocomplete callback that finds matching directories
 * under a base directory using readdirSync.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDir(prefix = "dir-sugg-test"): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

describe("createDirectorySuggestions", () => {
  let tmpDir: string;
  let cleanupFn: () => void;

  beforeEach(() => {
    const tmp = makeTempDir();
    tmpDir = tmp.dir;
    cleanupFn = tmp.cleanup;

    // Create test directory structure
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "src", "agents"), { recursive: true });
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "README.md"), "content");
  });

  afterEach(() => {
    cleanupFn();
  });

  it("lists top-level directories for empty query", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("");
    const labels = results.map((r: any) => r.label);
    expect(labels).toContain("./src/");
    expect(labels).toContain("./test/");
    // Should not include files
    expect(labels).not.toContain("README.md");
  });

  it("filters directories by prefix", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("src");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("./src/");
  });

  it("navigates into subdirectories when query ends with /", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("src/");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("./src/agents/");
  });

  it("filters within subdirectories", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("src/ag");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("./src/agents/");
  });

  it("returns empty array for non-existent directory", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("nonexistent");
    expect(results).toEqual([]);
  });

  it("returns empty array when navigating into a file", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("README.md/");
    expect(results).toEqual([]);
  });

  it("directory suggestions have 'dir' provider", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("src");
    expect(results[0].provider).toBe("dir");
  });

  it("directory suggestions have absolute path as value", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("src");
    expect(results[0].value).toContain("/src");
    expect(results[0].value.startsWith(tmpDir)).toBe(true);
  });

  it("lists top-level directories for ./ prefix query", async () => {
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("./");
    const labels = results.map((r: any) => r.label);
    expect(labels).toContain("./src/");
    expect(labels).toContain("./test/");
  });

  it("includes symlinked directories", async () => {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(tmpDir, "src"), join(tmpDir, "src-link"));
    const { createDirectorySuggestions } = await import("../../../src/ui/menu/menu-spawn-wizard.js");
    const suggestions = createDirectorySuggestions(tmpDir);
    const results = suggestions("");
    const labels = results.map((r: any) => r.label);
    expect(labels).toContain("./src-link/");
  });

});
