import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isUnsafeName, isSymlink, safeReadFile } from "../src/utils.ts";
import { tempDirFixture } from "./fixtures";

/* ------------------------------------------------------------------ */
/*  isUnsafeName                                                      */
/* ------------------------------------------------------------------ */

describe("isUnsafeName", () => {
  it("allows simple alphanumeric names", () => {
    expect(isUnsafeName("general-purpose")).toBe(false);
    expect(isUnsafeName("Explore")).toBe(false);
    expect(isUnsafeName("myAgent42")).toBe(false);
  });

  it("allows names with dots, hyphens, underscores", () => {
    expect(isUnsafeName("my.agent")).toBe(false);
    expect(isUnsafeName("code_review-v2")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(isUnsafeName(".hidden")).toBe(true);
  });

  it("rejects path traversal (../)", () => {
    expect(isUnsafeName("../etc")).toBe(true);
  });

  it("rejects path traversal (..\\\\)", () => {
    expect(isUnsafeName("..\\etc")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isUnsafeName("")).toBe(true);
  });

  it("rejects names longer than 128 characters", () => {
    expect(isUnsafeName("a".repeat(129))).toBe(true);
  });

  it("allows exactly 128 characters", () => {
    expect(isUnsafeName("a".repeat(128))).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isUnsafeName("my agent")).toBe(true);
  });

  it("rejects names with slashes", () => {
    expect(isUnsafeName("a/b")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  isSymlink                                                         */
/* ------------------------------------------------------------------ */

describe("isSymlink", () => {
  const { setup, getDir, teardown } = tempDirFixture("isSymlink-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("returns false for a regular file", () => {
    const file = join(getDir(), "regular.txt");
    writeFileSync(file, "hello", "utf-8");
    expect(isSymlink(file)).toBe(false);
  });

  it("returns true for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "target content", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it("returns false for a non-existent file", () => {
    expect(isSymlink(join(getDir(), "nonexistent.txt"))).toBe(false);
  });

  it("returns false for a directory", () => {
    expect(isSymlink(getDir())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  safeReadFile                                                      */
/* ------------------------------------------------------------------ */

describe("safeReadFile", () => {
  const { setup, getDir, teardown } = tempDirFixture("safeReadFile-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("reads a normal file", () => {
    const file = join(getDir(), "normal.txt");
    writeFileSync(file, "file content", "utf-8");
    expect(safeReadFile(file)).toBe("file content");
  });

  it("returns undefined for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "secret", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(safeReadFile(link)).toBeUndefined();
  });

  it("returns undefined for a missing file", () => {
    expect(safeReadFile(join(getDir(), "missing.txt"))).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    expect(safeReadFile(getDir())).toBeUndefined();
  });
});
