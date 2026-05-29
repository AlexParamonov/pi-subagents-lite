/**
 * prompts.test.ts — Tests for system prompt building with skills.
 *
 * Covers:
 *   - buildAgentPrompt with skillMetas (whitelist format)
 *   - buildAgentPrompt with skillBlocks (preload format)
 *   - buildAgentPrompt with both
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
  it("includes available_skills XML when skillMetas provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "tdd", description: "TDD workflow", location: "/skills/tdd/SKILL.md" },
        { name: "debug", description: "Debugging workflow", location: "/skills/debug/SKILL.md" },
      ],
    });

    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>tdd</name>");
    expect(result).toContain("<description>TDD workflow</description>");
    expect(result).toContain("<location>/skills/tdd/SKILL.md</location>");
    expect(result).toContain("<name>debug</name>");
    expect(result).toContain("</available_skills>");
    // Should include instruction to use read tool
    expect(result).toContain("Use the read tool to load a skill's file");
  });

  it("includes preloaded skill content when skillBlocks provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillBlocks: [
        { name: "tdd", content: "## TDD Steps\n1. Red\n2. Green\n3. Refactor" },
      ],
    });

    expect(result).toContain("# Preloaded Skill: tdd");
    expect(result).toContain("## TDD Steps");
    expect(result).toContain("1. Red");
    // Should NOT have available_skills
    expect(result).not.toContain("<available_skills>");
  });

  it("includes both when both provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "debug", description: "Debug workflow", location: "/skills/debug/SKILL.md" },
      ],
      skillBlocks: [
        { name: "tdd", content: "Full TDD content here" },
      ],
    });

    // Metadata for debug
    expect(result).toContain("<name>debug</name>");
    expect(result).toContain("<description>Debug workflow</description>");
    // Preloaded content for tdd
    expect(result).toContain("# Preloaded Skill: tdd");
    expect(result).toContain("Full TDD content here");
  });

  it("escapes XML special characters in skill metadata", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      skillMetas: [
        { name: "test", description: "Use <code> & \"quotes\"", location: "/path/to/skill" },
      ],
    });

    expect(result).toContain("&lt;code&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;quotes&quot;");
  });

  it("returns no skill sections when no extras provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {});

    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("Preloaded Skill");
  });
});
