import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  errorMessage,
  findModelInRegistry,
  isUnsafeName,
  isSymlink,
  parseModelKey,
  parseThinkingLevel,
  safeReadFile,
  summarizeToolArgs,
} from "../src/utils.ts";
import { tempDirFixture } from "./fixtures";
import type { Model } from "@earendil-works/pi-ai";

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

/* ------------------------------------------------------------------ */
/*  errorMessage                                                      */
/* ------------------------------------------------------------------ */

describe("errorMessage", () => {
  it("extracts message from an Error instance", () => {
    expect(errorMessage(new Error("something failed"))).toBe("something failed");
  });

  it("converts non-Error values to string", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });

  it("replaces newlines with spaces so multi-line errors do not break TUI layout", () => {
    const err = new Error("first line\nsecond line\nthird line");
    expect(errorMessage(err)).toBe("first line second line third line");
  });

  it("replaces carriage returns", () => {
    const err = new Error("line1\r\nline2");
    expect(errorMessage(err)).toBe("line1 line2");
  });

  it("collapses consecutive newlines into a single space", () => {
    const err = new Error("a\n\n\nb");
    expect(errorMessage(err)).toBe("a b");
  });

  it("trims leading and trailing whitespace", () => {
    const err = new Error("  leading and trailing  ");
    expect(errorMessage(err)).toBe("leading and trailing");
  });
});
describe("parseThinkingLevel", () => {
  it("narrows a valid level string", () => {
    expect(parseThinkingLevel("high")).toBe("high");
  });

  it("returns undefined for an invalid level or undefined input", () => {
    expect(parseThinkingLevel("ultra")).toBeUndefined();
    expect(parseThinkingLevel(undefined)).toBeUndefined();
  });
});

describe("parseModelKey", () => {
  it("splits provider/model-id", () => {
    expect(parseModelKey("anthropic/claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("returns null without a slash or with an empty provider", () => {
    expect(parseModelKey("no-slash")).toBeNull();
    expect(parseModelKey("/leading-slash")).toBeNull();
  });
});

describe("findModelInRegistry", () => {
  function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
    return {
      id: "claude",
      name: "Claude",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
      ...overrides,
    };
  }

  const registryModel = makeModel();
  const registry = {
    find: (provider: string, modelId: string) =>
      provider === "anthropic" && modelId === "claude" ? registryModel : undefined,
  };
  const fallback = makeModel({ id: "model", name: "Fallback", provider: "fallback" });

  it("returns the registry model when found", () => {
    expect(findModelInRegistry("anthropic/claude", registry, fallback)).toBe(registryModel);
  });

  it("falls back for unknown, unparseable, or missing model strings", () => {
    expect(findModelInRegistry("openai/gpt", registry, fallback)).toBe(fallback);
    expect(findModelInRegistry("nope", registry, fallback)).toBe(fallback);
    expect(findModelInRegistry(undefined, registry, fallback)).toBe(fallback);
  });
});

describe("summarizeToolArgs", () => {
  it("returns empty string for no or empty args", () => {
    expect(summarizeToolArgs("read", undefined)).toBe("");
    expect(summarizeToolArgs("read", {})).toBe("");
  });

  it("summarizes read as the path", () => {
    expect(summarizeToolArgs("read", { path: "/a/b.txt" })).toBe('("/a/b.txt")');
  });

  it("summarizes write as path and content size", () => {
    expect(summarizeToolArgs("write", { path: "/a/b.txt", content: "hello" })).toBe('("/a/b.txt", 5 chars)');
  });

  it("summarizes edit as path and edit count", () => {
    expect(summarizeToolArgs("edit", { path: "/a/b.txt", edits: [{}, {}] })).toBe('("/a/b.txt", 2 edits)');
  });

  it("strips heredocs from bash commands", () => {
    expect(summarizeToolArgs("bash", { command: "cat <<EOF\nline\nEOF" })).toBe('("cat")');
  });

  it("truncates long bash commands to 350 chars plus ellipsis", () => {
    const command = "echo " + "x".repeat(400);
    expect(summarizeToolArgs("bash", { command })).toBe('("echo ' + "x".repeat(345) + '…")');
  });

  it("summarizes grep and rg as pattern and path", () => {
    expect(summarizeToolArgs("grep", { pattern: "foo", path: "/a" })).toBe('("foo", "/a")');
    expect(summarizeToolArgs("rg", { pattern: "foo", path: "/a" })).toBe('("foo", "/a")');
  });

  it("renders a single default arg as a shorthand", () => {
    expect(summarizeToolArgs("custom", { query: "x" })).toBe('("x")');
  });

  it("JSON-dumps multi-arg tools", () => {
    expect(summarizeToolArgs("custom", { a: 1, b: "x" })).toBe(' {"a":1,"b":"x"}');
  });

  it("truncates a long single default string arg with the ellipsis character", () => {
    const val = "y".repeat(500);
    expect(summarizeToolArgs("custom", { note: val })).toBe("(" + JSON.stringify("y".repeat(350) + "…") + ")");
  });
});
