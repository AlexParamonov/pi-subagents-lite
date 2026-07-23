/**
 * package-name-matching.test.ts — Extension matching by package name from package.json.
 *
 * Uses real temp directories (no fs mocking) with exported buildExtOverride.
 * Tests the override function directly with real package.json files.
 *
 * Port from pi-subagents #143.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildExtOverride, resetPackageNameCache } from "../../src/agents/agent-runner.js";

/**
 * Create a temp directory with a package.json that declares an extension entry.
 * Returns { dir, extPath } where extPath is the full path to the extension file.
 */
function createPkgDir(pkgName: string, entry: string, piExtensions: string[]): { dir: string; extPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pkg-name-test-"));
  const manifest: Record<string, unknown> = { name: pkgName, pi: { extensions: piExtensions } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const dirPart = entry.includes("/") ? entry.replace(/\/[^/]+$/, "") : "";
  if (dirPart) mkdirSync(join(dir, dirPart), { recursive: true });
  writeFileSync(join(dir, entry), "export default () => {};" );
  return { dir, extPath: join(dir, entry) };
}

/* ------------------------------------------------------------------ */
/*  Package name matching — whitelist (extensions array)               */
/* ------------------------------------------------------------------ */

describe("extension matching by package name — whitelist", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    resetPackageNameCache();
  });

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("matches extension by package name when directory name differs", () => {
    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(["pi-subagents"], undefined, undefined);
    expect(override).toBeDefined();
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
        { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toBe(extPath);
  });

  it("path-derived name still works when no package.json", () => {
    const override = buildExtOverride(["tavily"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
        { path: "/home/test/.pi/agent/extensions/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });

  it("case-insensitive matching for package name", () => {
    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(["Pi-Subagents"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });

  it("npm scoped package: matches by unscoped short name", () => {
    const { dir, extPath } = createPkgDir("@scope/pi-subagents", "dist/index.js", ["./dist/index.js"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(["pi-subagents"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });

  it("does not match when pi.extensions does not declare the entry", () => {
    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./lib/index.ts"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(["pi-subagents"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(0);
  });

  it("matches extension at package root (no subdirectory)", () => {
    const { dir, extPath } = createPkgDir("my-pkg", "index.ts", ["./index.ts"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(["my-pkg"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Package name matching — blacklist (exclude_extensions)             */
/* ------------------------------------------------------------------ */

describe("extension matching by package name — blacklist", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    resetPackageNameCache();
  });

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("excludes extension by package name when directory name differs", () => {
    const { dir, extPath } = createPkgDir("pi-subagents", "src/index.ts", ["./src/index.ts"]);
    tmpDirs.push(dir);

    const override = buildExtOverride(true, ["pi-subagents"], undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
        { path: "/home/test/.pi/agent/extensions/tavily/index.ts", tools: new Map([["web_search", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].path).toContain("tavily");
  });
});

/* ------------------------------------------------------------------ */
/*  Extensions without package.json are unaffected                     */
/* ------------------------------------------------------------------ */

describe("extensions without package.json are unaffected", () => {
  beforeEach(() => {
    resetPackageNameCache();
  });

  it("falls back to path-derived name when no package.json", () => {
    const override = buildExtOverride(["my-extension"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: "/home/test/.pi/agent/extensions/my-extension/index.ts", tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    expect(result.extensions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Warnings for unmatched extension names                             */
/* ------------------------------------------------------------------ */

describe("warnings for unmatched extension names", () => {
  beforeEach(() => {
    resetPackageNameCache();
  });

  it("warns when whitelist name doesn't match any loaded extension", () => {
    const warnings: string[] = [];
    const override = buildExtOverride(["nonexistent"], undefined, (msg) => warnings.push(msg));
    override!({
      extensions: [
        { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nonexistent");
  });

  it("warns when blacklist name doesn't match any loaded extension", () => {
    const warnings: string[] = [];
    const override = buildExtOverride(true, ["nonexistent"], (msg) => warnings.push(msg));
    override!({
      extensions: [
        { path: "/some/other/index.ts", tools: new Map([["other_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nonexistent");
  });
});

/* ------------------------------------------------------------------ */
/*  Malformed package.json                                             */
/* ------------------------------------------------------------------ */

describe("malformed package.json", () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    resetPackageNameCache();
  });

  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("falls back to path-derived name when package.json is invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkg-name-test-"));
    writeFileSync(join(dir, "package.json"), "not valid json {{{");
    mkdirSync(join(dir, "my-extension"), { recursive: true });
    writeFileSync(join(dir, "my-extension", "index.ts"), "export default () => {};" );
    tmpDirs.push(dir);

    const extPath = join(dir, "my-extension", "index.ts");
    const override = buildExtOverride(["my-extension"], undefined, undefined);
    const result = override!({
      extensions: [
        { path: extPath, tools: new Map([["my_tool", {}]]) },
      ],
      errors: [],
      runtime: {},
    });
    // Should not crash, and should match by path-derived name
    expect(result.extensions).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  buildExtOverride — return value for non-filtering configs          */
/* ------------------------------------------------------------------ */

describe("buildExtOverride return value", () => {
  it("returns undefined when extensions is true and no excludeExtensions", () => {
    expect(buildExtOverride(true, undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when extensions is false", () => {
    expect(buildExtOverride(false, undefined, undefined)).toBeUndefined();
  });
});
