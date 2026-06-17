/**
 * prompts.test.ts — Tests for system prompt building with skills.
 *
 * Covers:
 *   - buildAgentPrompt with skillMetas (compact one-line format)
 *   - buildAgentPrompt with skillBlocks (preloaded in available_skills with content tag)
 *   - buildAgentPrompt with both (merged into single available_skills block)
 *   - XML escaping of special characters
 */

import { describe, it, expect } from "vitest";
import { buildAgentPrompt } from "../src/prompts.ts";
import type { AgentConfig, EnvInfo } from "../src/types.ts";

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

describe("buildAgentPrompt", () => {
  it("renders compact one-line skill elements for whitelist", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "tdd", description: "TDD workflow", location: "/skills/tdd/SKILL.md" },
        { name: "debug", description: "Debugging workflow", location: "/skills/debug/SKILL.md" },
      ],
    });

    expect(result).toContain("<available_skills>");
    expect(result).toContain("<skill><name>tdd</name><description>TDD workflow</description><location>/skills/tdd/SKILL.md</location></skill>");
    expect(result).toContain("<skill><name>debug</name><description>Debugging workflow</description><location>/skills/debug/SKILL.md</location></skill>");
    expect(result).toContain("</available_skills>");
    // Should include instruction to use read tool
    expect(result).toContain("Use the read tool to load a skill's file");
  });

  it("renders preloaded skills in available_skills with content tag", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillBlocks: [
        { name: "tdd", description: "TDD workflow", content: "## TDD Steps\n1. Red\n2. Green\n3. Refactor" },
      ],
    });

    // Should be in available_skills block
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<skill><name>tdd</name><description>TDD workflow</description><content>");
    expect(result).toContain("## TDD Steps");
    expect(result).toContain("</content></skill>");
    // Should NOT have separate markdown dump
    expect(result).not.toContain("# Preloaded Skill:");
  });

  it("merges both into single available_skills block", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "debug", description: "Debug workflow", location: "/skills/debug/SKILL.md" },
      ],
      skillBlocks: [
        { name: "tdd", description: "TDD workflow", content: "Full TDD content here" },
      ],
    });

    // Both in available_skills
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<skill><name>debug</name><description>Debug workflow</description><location>/skills/debug/SKILL.md</location></skill>");
    expect(result).toContain("<skill><name>tdd</name><description>TDD workflow</description><content>Full TDD content here</content></skill>");
    // Single block
    const blockCount = (result.match(/<available_skills>/g) || []).length;
    expect(blockCount).toBe(1);
    // No separate markdown dump
    expect(result).not.toContain("# Preloaded Skill:");
  });

  it("escapes < and > in skill metadata", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "test", description: "Use <code> & \"quotes\"", location: "/path/to/skill" },
      ],
    });

    expect(result).toContain("&lt;code&gt;");
    // & and quotes are NOT escaped (readable for LLMs)
    expect(result).toContain("&");
    expect(result).toContain("\"quotes\"");
  });

  it("returns no skill sections when no extras provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {});

    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("Preloaded Skill");
  });
});
