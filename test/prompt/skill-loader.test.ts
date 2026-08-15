/**
 * skill-loader.test.ts — Tests for skill loading and prompt integration.
 *
 * Pi's loadSkills/loadSkillsFromDir are mocked to isolate from system skills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preloadSkills, loadSkillMeta, loadAllSkills } from "../../src/prompt/skill-loader.ts";
import { buildAgentPrompt } from "../../src/prompt/prompts.ts";
import type { AgentConfig, EnvInfo } from "../../src/types.ts";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSkillDir, createFlatSkill } from "../fixtures.ts";

const { mockLoadSkills, mockLoadSkillsFromDir, mockFormatSkillsForPrompt } = vi.hoisted(() => ({
  mockLoadSkills: vi.fn(),
  mockLoadSkillsFromDir: vi.fn(),
  mockFormatSkillsForPrompt: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  loadSkills: mockLoadSkills,
  loadSkillsFromDir: mockLoadSkillsFromDir,
  formatSkillsForPrompt: mockFormatSkillsForPrompt,
  getAgentDir: vi.fn(() => "/fake/.pi/agent"),
}));

let tmpDir: string;

/**
 * Scratch root for skill fixtures. Project-local (not os.tmpdir): loadAllSkills
 * walks ancestors via readdirSync looking for .git, and a busy system tmp dir
 * makes that walk cost ~250ms per call. Under node_modules it stays out of
 * the git tree and prettier's path set.
 */
const SCRATCH_ROOT = join(fileURLToPath(new URL("..", import.meta.url)), ".tmp", "skill-test");

/** Build a minimal Skill object for mocking. */
function makeSkill(
  name: string,
  description: string,
  filePath: string,
  opts: { disableModelInvocation?: boolean } = {},
): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as any,
    disableModelInvocation: opts.disableModelInvocation ?? false,
  };
}

beforeEach(() => {
  tmpDir = join(SCRATCH_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // Default: no skills from any source
  mockLoadSkills.mockReturnValue({ skills: [], diagnostics: [] });
  mockLoadSkillsFromDir.mockReturnValue({ skills: [], diagnostics: [] });
  mockFormatSkillsForPrompt.mockReturnValue("");
});

afterEach(() => {
  try {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Unit: loadAllSkills                                               */
/* ------------------------------------------------------------------ */

describe("loadAllSkills", () => {
  it("loads from .pi/skills via loadSkills (Pi defaults)", () => {
    const tddSkill = makeSkill("tdd", "TDD workflow", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [tddSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(mockLoadSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: tmpDir,
        includeDefaults: true,
      }),
    );
  });

  it("loads ancestor .agents/skills via loadSkillsFromDir", () => {
    const agentsSkill = makeSkill(
      "agents-skill",
      "From agents",
      join(tmpDir, ".agents", "skills", "agents-skill", "SKILL.md"),
    );
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result.some((s) => s.name === "agents-skill")).toBe(true);
    expect(mockLoadSkillsFromDir).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: join(tmpDir, ".agents", "skills"),
        source: "agents",
      }),
    );
  });

  it("filters root .md files from .agents/skills directories", () => {
    const rootSkill = makeSkill("root-skill", "Root level", join(tmpDir, ".agents", "skills", "root-skill.md"));
    const dirSkill = makeSkill("dir-skill", "Dir level", join(tmpDir, ".agents", "skills", "dir-skill", "SKILL.md"));
    const agentsSkillsDir = join(tmpDir, ".agents", "skills");
    mockLoadSkillsFromDir.mockImplementation(({ dir }: { dir: string }) => {
      // Only return skills for the tmpDir's .agents/skills
      if (dir === agentsSkillsDir) return { skills: [rootSkill, dirSkill], diagnostics: [] };
      return { skills: [], diagnostics: [] };
    });

    const result = loadAllSkills(tmpDir);

    // Root .md file should be filtered out (parent === skillsRoot)
    expect(result.some((s) => s.name === "root-skill")).toBe(false);
    expect(result.some((s) => s.name === "dir-skill")).toBe(true);
  });

  it("gives ancestor .agents/skills higher precedence than defaults", () => {
    const defaultSkill = makeSkill("tdd", "Default TDD", join(tmpDir, ".pi", "skills", "tdd", "SKILL.md"));
    const agentsSkill = makeSkill("tdd", "Agents TDD", join(tmpDir, ".agents", "skills", "tdd", "SKILL.md"));
    mockLoadSkills.mockReturnValue({ skills: [defaultSkill], diagnostics: [] });
    mockLoadSkillsFromDir.mockReturnValue({ skills: [agentsSkill], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Agents TDD");
  });

  it("deduplicates by name (first match wins)", () => {
    const skill1 = makeSkill("dup", "First", join(tmpDir, ".agents", "skills", "dup", "SKILL.md"));
    const skill2 = makeSkill("dup", "Second", join(tmpDir, ".pi", "skills", "dup", "SKILL.md"));
    mockLoadSkillsFromDir.mockReturnValue({ skills: [skill1], diagnostics: [] });
    mockLoadSkills.mockReturnValue({ skills: [skill2], diagnostics: [] });

    const result = loadAllSkills(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("First");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: preloadSkills                                               */
/* ------------------------------------------------------------------ */

describe("preloadSkills", () => {
  it("loads full content and extracts description from a skill directory", () => {
    createSkillDir(tmpDir, "tdd", "Test-driven development workflow", "## TDD Steps\n1. Red\n2. Green\n3. Refactor");
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "Test-driven development workflow", tddPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].content).toContain("## TDD Steps");
    expect(result[0].content).toContain("1. Red");
  });

  it("loads full content and extracts description from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");
    const debugPath = join(tmpDir, ".pi", "skills", "debug.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("debug", "Debugging workflow", debugPath)],
      diagnostics: [],
    });

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
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "Test-driven development workflow", tddPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("Test-driven development workflow");
    expect(result[0].location).toContain("SKILL.md");
    expect(result[0].location).not.toContain("TDD Steps");
  });

  it("returns metadata from a flat skill file", () => {
    createFlatSkill(tmpDir, "debug", "Debugging workflow", "## Debug Steps\n1. Reproduce\n2. Isolate\n3. Fix");
    const debugPath = join(tmpDir, ".pi", "skills", "debug.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("debug", "Debugging workflow", debugPath)],
      diagnostics: [],
    });

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
    const tddPath = join(tmpDir, ".pi", "skills", "tdd", "SKILL.md");
    const debugPath = join(tmpDir, ".pi", "skills", "debug", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("tdd", "TDD workflow", tddPath), makeSkill("debug", "Debug workflow", debugPath)],
      diagnostics: [],
    });

    const result = loadSkillMeta(["tdd", "debug"], tmpDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tdd");
    expect(result[0].description).toBe("TDD workflow");
    expect(result[1].name).toBe("debug");
    expect(result[1].description).toBe("Debug workflow");
  });

  it("threads disableModelInvocation from loaded skill", () => {
    const skillPath = join(tmpDir, ".pi", "skills", "internal", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("internal", "Internal tool", skillPath, { disableModelInvocation: true })],
      diagnostics: [],
    });

    const result = loadSkillMeta(["internal"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(true);
  });

  it("defaults disableModelInvocation to false for missing skill", () => {
    const result = loadSkillMeta(["nonexistent"], tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0].disableModelInvocation).toBe(false);
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
  createSkillDir(
    tmpDir,
    "proof-skill",
    "Skill with secret token",
    `## Secret Token\n${SECRET_TOKEN}\n\n${BODY_MARKER}`,
  );
}

describe("Prompt integration: whitelist excludes body", () => {
  it("available_skills has metadata but NOT secret token", () => {
    createProofSkill();
    const tddPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("proof-skill", "Skill with secret token", tddPath)],
      diagnostics: [],
    });
    mockFormatSkillsForPrompt.mockReturnValue(
      `<skill><name>proof-skill</name><description>Skill with secret token</description><location>${tddPath}</location></skill>`,
    );

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
    const tddPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("proof-skill", "Skill with secret token", tddPath)],
      diagnostics: [],
    });

    const blocks = preloadSkills(["proof-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillBlocks: blocks });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain(
      "<skill><name>proof-skill</name><description>Skill with secret token</description><content>",
    );
    expect(prompt).toContain(SECRET_TOKEN);
    expect(prompt).toContain(BODY_MARKER);
    expect(prompt).toContain("</content></skill>");
    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

describe("Prompt integration: both together", () => {
  it("metadata skill has no secret, preloaded skill has secret in content tag", () => {
    createProofSkill();
    createSkillDir(tmpDir, "other-skill", "Another skill", "OTHER_SECRET_123");

    const proofPath = join(tmpDir, ".pi", "skills", "proof-skill", "SKILL.md");
    const otherPath = join(tmpDir, ".pi", "skills", "other-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [
        makeSkill("proof-skill", "Skill with secret token", proofPath),
        makeSkill("other-skill", "Another skill", otherPath),
      ],
      diagnostics: [],
    });
    mockFormatSkillsForPrompt.mockReturnValue(
      `<skill><name>proof-skill</name><description>Skill with secret token</description><location>${proofPath}</location></skill>`,
    );

    const metas = loadSkillMeta(["proof-skill"], tmpDir);
    const blocks = preloadSkills(["other-skill"], tmpDir);
    const prompt = buildAgentPrompt(baseConfig, tmpDir, env, { skillMetas: metas, skillBlocks: blocks });

    // Single available_skills block
    const blockCount = (prompt.match(/<available_skills>/g) || []).length;
    expect(blockCount).toBe(1);

    // proof-skill: metadata only (location) — from formatSkillsForPrompt
    expect(prompt).toContain("<name>proof-skill</name>");
    expect(prompt).toContain("<description>Skill with secret token</description>");
    expect(prompt).not.toContain(SECRET_TOKEN);

    // other-skill: preloaded (content tag)
    expect(prompt).toContain("<skill><name>other-skill</name><description>Another skill</description><content>");
    expect(prompt).toContain("OTHER_SECRET_123");

    expect(prompt).not.toContain("# Preloaded Skill:");
  });
});

/* ------------------------------------------------------------------ */
/*  Unit: preloadSkills — description from Skill object               */
/* ------------------------------------------------------------------ */

describe("preloadSkills — description from Skill object", () => {
  it("returns empty description when skill not found", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].description).toBe("");
  });

  it("uses description from Skill object", () => {
    createSkillDir(tmpDir, "test-skill", "My skill description", "Body text");
    const skillPath = join(tmpDir, ".pi", "skills", "test-skill", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("test-skill", "My skill description", skillPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["test-skill"], tmpDir);
    expect(result[0].description).toBe("My skill description");
  });

  it("returns empty description when Skill has no description", () => {
    const skillDir = join(tmpDir, ".pi", "skills", "plain");
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, "Just body text, no frontmatter.");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("plain", "", skillPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["plain"], tmpDir);
    expect(result[0].description).toBe("");
  });

  it("handles file read errors gracefully", () => {
    const missingPath = join(tmpDir, ".pi", "skills", "gone", "SKILL.md");
    mockLoadSkills.mockReturnValue({
      skills: [makeSkill("gone", "Was here", missingPath)],
      diagnostics: [],
    });

    const result = preloadSkills(["gone"], tmpDir);
    expect(result[0].content).toContain("not found");
    expect(result[0].description).toBe("");
  });
});
