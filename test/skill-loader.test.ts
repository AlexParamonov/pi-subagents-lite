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
import { preloadSkills, loadSkillMeta, parseFrontmatterDescription } from "../src/skill-loader.ts";
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
  it("loads full content and extracts description from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");

    const result = preloadSkills(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].content).toContain("## TDD Steps");
    expect(result[0].content).toContain("1. Red");
  });

  it("loads full content and extracts description from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");

    const result = preloadSkills(["debug"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("debug");
    expect(result[0].description).toBe("Debugging workflow");
    expect(result[0].content).toContain("## Debug Steps");
  });

  it("returns error message for missing skill", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
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

describe("Prompt integration: preload in available_skills with content tag", () => {
  it("Preloaded skill appears in available_skills with content tag", () => {
    createProofSkill();
    const blocks = preloadSkills(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillBlocks: blocks });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<skill><name>proof-skill</name><description>Skill with secret token</description><content>");
    expect(prompt).toContain(SECRET_TOKEN);
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).toContain("</content></skill>");
    // No separate markdown dump
    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

describe("Prompt integration: both together", () => {
  it("metadata skill has no secret, preloaded skill has secret in content tag", () => {
    createProofSkill();
    createSkillDir(tmpDir, "other-skill", "Another skill", "OTHER_SECRET_123");

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const blocks = preloadSkills(["other-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas, skillBlocks: blocks });

    // Single available_skills block
    const blockCount = (prompt.match(/<available_skills>/g) || []).length;
    expect(blockCount).toBe(1);

    // proof-skill: metadata only (location)
    expect(prompt).toContain("<skill><name>proof-skill</name><description>Skill with secret token</description><location>");
    expect(prompt).not.toContain(SECRET_TOKEN);

    // other-skill: preloaded (content tag)
    expect(prompt).toContain("<skill><name>other-skill</name><description>Another skill</description><content>");
    expect(prompt).toContain("OTHER_SECRET_123");

    // No separate markdown dump
    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: parseFrontmatterDescription                                 */
/* ------------------------------------------------------------------ */

describe("parseFrontmatterDescription", () => {
  it("returns description from valid frontmatter", () => {
    const content = "---\nname: test\ndescription: Test skill\n---\n\nBody";
    expect(parseFrontmatterDescription(content)).toBe("Test skill");
  });

  it("returns null when no frontmatter is present", () => {
    expect(parseFrontmatterDescription("No frontmatter here")).toBeNull();
  });

  it("returns null when frontmatter is not closed", () => {
    const content = "---\nname: test\ndescription: Test skill";
    expect(parseFrontmatterDescription(content)).toBeNull();
  });

  it("returns null when no description field", () => {
    const content = "---\nname: test\n---\n\nBody";
    expect(parseFrontmatterDescription(content)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseFrontmatterDescription("")).toBeNull();
  });

  it("truncates descriptions longer than 200 chars", () => {
    const longDesc = "A".repeat(250);
    const content = `---\nname: test\ndescription: ${longDesc}\n---\n\nBody`;
    const result = parseFrontmatterDescription(content);
    expect(result).toHaveLength(200);
    expect(result).toEndWith("...");
  });

  it("strips quotes from description value", () => {
    const content = "---\nname: test\ndescription: \"Quoted description\"\n---\n\nBody";
    expect(parseFrontmatterDescription(content)).toBe("Quoted description");
  });

  it("normalizes Windows line endings (CRLF)", () => {
    const content = "---\r\nname: test\r\ndescription: CRLF skill\r\n---\r\n\r\nBody";
    expect(parseFrontmatterDescription(content)).toBe("CRLF skill");
  });
});

describe("extractDescription uses parseFrontmatterDescription", () => {
  it("returns (no description) when helper returns null", () => {
    createFlatSkill(tmpDir, "no-desc", "", "Body without description");
    const result = loadSkillMeta(["no-desc"], tmpDir);
    expect(result[0].description).toBe("(no description)");
  });
});

describe("extractDescriptionFromContent uses parseFrontmatterDescription", () => {
  it("returns empty string when helper returns null", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].description).toBe("");
  });
});
