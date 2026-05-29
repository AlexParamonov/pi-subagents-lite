/**
 * skill-loader.test.ts — Tests for skill loading and prompt integration.
 *
 * Covers:
 *   - preloadSkills: loads full SKILL.md content
 *   - loadSkillMeta: loads metadata only (name, description, location)
 *   - buildAgentPrompt: correct format for whitelist vs preload
 *   - Integration proof with secret token verification
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preloadSkills, loadSkillMeta } from "../src/skill-loader.ts";
import { buildAgentPrompt } from "../src/prompts.ts";
import type { AgentConfig, EnvInfo } from "../src/types.ts";
import { createSkillDir, createFlatSkill } from "./fixtures";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/* ------------------------------------------------------------------ */
/*  Unit: preloadSkills                                               */
/* ------------------------------------------------------------------ */

describe("preloadSkills", () => {
  it("loads full content from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");

    const result = preloadSkills(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].content).toContain("## TDD Steps");
    expect(result[0].content).toContain("1. Red");
  });

  it("loads full content from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");

    const result = preloadSkills(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].content).toContain("## Debug Steps");
  });

  it("returns error message for missing skill", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: loadSkillMeta                                               */
/* ------------------------------------------------------------------ */

describe("loadSkillMeta", () => {
  it("returns metadata only from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");

    const result = loadSkillMeta(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].location).toContain("SKILL.md");
    expect(result[0].location).not.toContain("TDD Steps");
  });

  it("returns metadata from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");

    const result = loadSkillMeta(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].location).toContain("debug.md");
  });

  it("returns not-found description for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].description).toContain("not found");
    expect(result[0].location).toBe("");
  });

  it("loads multiple skills metadata", () => {
    createSkillDir(tmpDir, "tdd", "TDD workflow", "body1");
    createSkillDir(tmpDir, "debug", "Debug workflow", "body2");

    const result = loadSkillMeta(["tdd", "debug"], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("TDD workflow");
    expect(result[1].name).toBe("debug");
    expect(result[1].description).toBe("Debug workflow");
  });
});

/* ------------------------------------------------------------------ */
/*  Integration: prompt building with secret token proof              */
/* ------------------------------------------------------------------ */

const SECRET_TOKEN = "PROOF_TOKEN_ALPHA_7X9K2M";
const BODY_MARKER = "This line proves full content was loaded";

const baseConfig: AgentConfig = {
  name: "test-agent",
  description: "Test agent",
  extensions: true,
  skills: true,
  systemPrompt: "You are a test agent.",
};

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "linux",
};

function createProofSkill() {
  createSkillDir(tmpDir, "proof-skill", "Skill with secret token",
    `## Secret Token\n${SECRET_TOKEN}\n\n${BODY_MARKER}`);
}

describe("Prompt integration: whitelist excludes body", () => {
  it("available_skills has metadata but NOT secret token", () => {
    createProofSkill();
    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).toContain("Use the read tool to load a skill's file");

    expect(prompt).not.toContain(SECRET_TOKEN);
    expect(prompt).not.toContain(BODY_MARKER);
  });
});

describe("Prompt integration: preload includes body", () => {
  it("Preloaded Skill section has full content WITH secret token", () => {
    createProofSkill();
    const blocks = preloadSkills(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillBlocks: blocks });

    expect(prompt).toContain("# Preloaded Skill: proof-skill");
    expect(prompt).toContain(SECRET_TOKEN);
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).not.toContain("<available_skills>");
  });
});

describe("Prompt integration: both together", () => {
  it("metadata skill has no secret, preloaded skill has secret", () => {
    createProofSkill();
    createSkillDir(tmpDir, "other-skill", "Another skill", "OTHER_SECRET_123");

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const blocks = preloadSkills(["other-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas, skillBlocks: blocks });

    // proof-skill: metadata only
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).not.toContain(SECRET_TOKEN);

    // other-skill: preloaded
    expect(prompt).toContain("# Preloaded Skill: other-skill");
    expect(prompt).toContain("OTHER_SECRET_123");
  });
});
