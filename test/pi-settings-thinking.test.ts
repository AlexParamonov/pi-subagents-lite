/**
 * pi-settings-thinking.test.ts — getPiDefaultThinkingLevel and readDefaultTools
 * against pi's real SettingsManager (integration: real temp files, no fs mocks).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiDefaultThinkingLevel, readDefaultTools } from "../src/pi-settings.js";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

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

describe("readDefaultTools against pi's real SettingsManager", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-tools-"));
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

  // The installed pi dist predates the getDefaultTools accessor, so this
  // exercises the merged-settings degrade path against pi's real storage.
  it("returns undefined when no settings file sets defaultTools", () => {
    writeGlobal({ theme: "dark" });
    const manager = SettingsManager.create(cwd, agentDir);
    expect(readDefaultTools(manager)).toBeUndefined();
  });

  it("returns the global defaultTools", () => {
    writeGlobal({ defaultTools: ["read", "bash", "grep"] });
    const manager = SettingsManager.create(cwd, agentDir);
    expect(readDefaultTools(manager)).toEqual(["read", "bash", "grep"]);
  });

  it("returns the project defaultTools over the global one", () => {
    writeGlobal({ defaultTools: ["read", "bash"] });
    writeProject({ defaultTools: ["read", "bash", "grep"] });
    const manager = SettingsManager.create(cwd, agentDir);
    expect(readDefaultTools(manager)).toEqual(["read", "bash", "grep"]);
  });

  it("keeps an explicitly empty defaultTools distinct from unconfigured", () => {
    writeGlobal({ defaultTools: [] });
    const manager = SettingsManager.create(cwd, agentDir);
    expect(readDefaultTools(manager)).toEqual([]);
  });
});
