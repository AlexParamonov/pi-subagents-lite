/**
 * pi-settings-thinking.test.ts — getPiDefaultThinkingLevel and the per-model
 * thinking reads against pi's real SettingsManager
 * (integration: real temp files, no fs mocks).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPiDefaultThinkingLevel,
  getPiModelThinkingLevel,
  getPiModelThinkingLevels,
} from "../src/pi-settings.js";

describe("getPiDefaultThinkingLevel", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-thinking-"));
    agentDir = path.join(root, "agent");
    cwd = path.join(root, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeGlobal = (settings: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  };
  const writeProject = (settings: Record<string, unknown>): void => {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
  };

  it("returns undefined when no settings file sets defaultThinkingLevel", () => {
    writeGlobal({ theme: "dark" });
    expect(getPiDefaultThinkingLevel(cwd, agentDir)).toBeUndefined();
  });

  it("returns the global defaultThinkingLevel", () => {
    writeGlobal({ defaultThinkingLevel: "high" });
    expect(getPiDefaultThinkingLevel(cwd, agentDir)).toBe("high");
  });

  it("returns the project defaultThinkingLevel over the global one", () => {
    writeGlobal({ defaultThinkingLevel: "high" });
    writeProject({ defaultThinkingLevel: "low" });
    expect(getPiDefaultThinkingLevel(cwd, agentDir)).toBe("low");
  });

  it("returns the global level when the project file has no thinking key", () => {
    writeGlobal({ defaultThinkingLevel: "high" });
    writeProject({ theme: "light" });
    expect(getPiDefaultThinkingLevel(cwd, agentDir)).toBe("high");
  });
});

describe("per-model thinking reads against pi's real SettingsManager", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-model-thinking-"));
    agentDir = path.join(root, "agent");
    cwd = path.join(root, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeGlobal = (settings: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  };
  const writeProject = (settings: Record<string, unknown>): void => {
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
  };

  it("reads a global modelThinkingLevels entry keyed by provider/modelId", () => {
    writeGlobal({ modelThinkingLevels: { "anthropic/claude-opus-4-1": "high" } });
    expect(getPiModelThinkingLevel(cwd, "anthropic", "claude-opus-4-1", agentDir)).toBe("high");
  });

  it("returns undefined for a model absent from the map", () => {
    writeGlobal({ modelThinkingLevels: { "anthropic/claude-opus-4-1": "high" } });
    expect(getPiModelThinkingLevel(cwd, "anthropic", "claude-sonnet-4", agentDir)).toBeUndefined();
    expect(getPiModelThinkingLevel(cwd, "openai", "claude-opus-4-1", agentDir)).toBeUndefined();
  });

  it("merges the project map over the global map per key", () => {
    writeGlobal({
      modelThinkingLevels: { "anthropic/claude-opus-4-1": "high", "openai/gpt-4o": "low" },
    });
    writeProject({ modelThinkingLevels: { "anthropic/claude-opus-4-1": "max" } });
    // Project layer wins for the key it sets...
    expect(getPiModelThinkingLevel(cwd, "anthropic", "claude-opus-4-1", agentDir)).toBe("max");
    // ...and the global level survives for the key it doesn't.
    expect(getPiModelThinkingLevel(cwd, "openai", "gpt-4o", agentDir)).toBe("low");
  });

  it("returns undefined when the map is empty or the key is unset everywhere", () => {
    writeGlobal({ modelThinkingLevels: {} });
    expect(getPiModelThinkingLevel(cwd, "anthropic", "claude-opus-4-1", agentDir)).toBeUndefined();
    writeGlobal({ theme: "dark" });
    expect(getPiModelThinkingLevel(cwd, "anthropic", "claude-opus-4-1", agentDir)).toBeUndefined();
  });

  it("returns a copy of the whole map via getPiModelThinkingLevels", () => {
    writeGlobal({ modelThinkingLevels: { "anthropic/claude-opus-4-1": "high" } });
    const levels = getPiModelThinkingLevels(cwd, agentDir);
    expect(levels).toEqual({ "anthropic/claude-opus-4-1": "high" });
    // A copy: mutating the return must not corrupt later reads.
    levels["anthropic/claude-opus-4-1"] = "off";
    expect(getPiModelThinkingLevels(cwd, agentDir)["anthropic/claude-opus-4-1"]).toBe("high");
  });

  it("merges the whole map project over global", () => {
    writeGlobal({ modelThinkingLevels: { "openai/gpt-4o": "low" } });
    writeProject({ modelThinkingLevels: { "anthropic/claude-opus-4-1": "max" } });
    expect(getPiModelThinkingLevels(cwd, agentDir)).toEqual({
      "anthropic/claude-opus-4-1": "max",
      "openai/gpt-4o": "low",
    });
  });
});
