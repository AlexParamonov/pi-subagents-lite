/**
 * prompts.test.ts — Tests for system prompt building with skills.
 *
 * Covers:
 *   - buildAgentPrompt with skillMetas (compact one-line format)
 *   - buildAgentPrompt with skillBlocks (preloaded in available_skills with content tag)
 *   - buildAgentPrompt with both (merged into single available_skills block)
 *   - XML escaping of special characters
 *   - System prompt modes (replace, inherit, custom)
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

describe("buildAgentPrompt — system prompt modes", () => {
  it("replace mode (default): generic header + env + agent's systemPrompt in agent_instructions", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {}, "replace");

    // Should have generic header
    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).toContain("You have been invoked to handle a specific task autonomously.");

    // Should have active_agent tag
    expect(result).toContain(`<active_agent name="${baseConfig.name}"/>`);

    // Should have env block
    expect(result).toContain("# Environment");
    expect(result).toContain("Working directory: /test/cwd");
    expect(result).toContain("Git repository: yes");
    expect(result).toContain("Branch: main");
    expect(result).toContain("Platform: linux");

    // Should have agent's systemPrompt in agent_instructions tags
    expect(result).toContain("<agent_instructions>");
    expect(result).toContain(baseConfig.systemPrompt);
    expect(result).toContain("</agent_instructions>");
  });

  it("inherit mode: parent system prompt + active_agent tag + env + agent_instructions", () => {
    const parentPrompt = "You are the parent agent. You have access to all tools.";
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    // Should have parent prompt verbatim at the start
    expect(result.startsWith(parentPrompt)).toBe(true);

    // Should have active_agent tag after parent prompt
    const afterParent = result.slice(parentPrompt.length);
    expect(afterParent).toContain(`<active_agent name="${baseConfig.name}"/>`);

    // Should have env block
    expect(result).toContain("# Environment");
    expect(result).toContain("Working directory: /test/cwd");

    // Should have agent's systemPrompt in agent_instructions tags
    expect(result).toContain("<agent_instructions>");
    expect(result).toContain(baseConfig.systemPrompt);
    expect(result).toContain("</agent_instructions>");

    // Should NOT have generic header
    expect(result).not.toContain("You are a pi coding agent sub-agent.");
  });

  it("custom mode: custom prompt + active_agent tag + env + agent_instructions", () => {
    const customPrompt = "You are a specialized agent for code review tasks.";
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { customSystemPrompt: customPrompt }, "custom");

    // Should have custom prompt at the start
    expect(result.startsWith(customPrompt)).toBe(true);

    // Should have active_agent tag after custom prompt
    const afterCustom = result.slice(customPrompt.length);
    expect(afterCustom).toContain(`<active_agent name="${baseConfig.name}"/>`);

    // Should have env block
    expect(result).toContain("# Environment");
    expect(result).toContain("Working directory: /test/cwd");

    // Should have agent's systemPrompt in agent_instructions tags
    expect(result).toContain("<agent_instructions>");
    expect(result).toContain(baseConfig.systemPrompt);
    expect(result).toContain("</agent_instructions>");

    // Should NOT have generic header
    expect(result).not.toContain("You are a pi coding agent sub-agent.");
  });

  it("inherit mode falls back to replace when parentSystemPrompt is missing", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {}, "inherit");

    // Should have generic header (fallback)
    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).toContain("You have been invoked to handle a specific task autonomously.");
  });

  it("custom mode falls back to replace when customSystemPrompt is missing", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {}, "custom");

    // Should have generic header (fallback)
    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).toContain("You have been invoked to handle a specific task autonomously.");
  });

  it("agent's systemPrompt is always in agent_instructions tags regardless of mode", () => {
    const parentPrompt = "Parent prompt.";
    const customPrompt = "Custom prompt.";

    const replaceResult = buildAgentPrompt(baseConfig, "/test/cwd", env, {}, "replace");
    const inheritResult = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");
    const customResult = buildAgentPrompt(baseConfig, "/test/cwd", env, { customSystemPrompt: customPrompt }, "custom");

    for (const result of [replaceResult, inheritResult, customResult]) {
      expect(result).toContain("<agent_instructions>");
      expect(result).toContain(baseConfig.systemPrompt);
      expect(result).toContain("</agent_instructions>");
    }
  });
});

describe("buildAgentPrompt — context files (AGENTS.md)", () => {
  it("includes project_context block when contextFiles provided", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [
        { path: "/test/cwd/AGENTS.md", content: "Always use TDD." },
      ],
    });

    expect(result).toContain("<project_context>");
    expect(result).toContain("Project-specific instructions and guidelines:");
    expect(result).toContain("<project_instructions path=\"/test/cwd/AGENTS.md\">");
    expect(result).toContain("Always use TDD.");
    expect(result).toContain("</project_instructions>");
    expect(result).toContain("</project_context>");
  });

  it("includes multiple context files", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [
        { path: "/home/AGENTS.md", content: "Global guidelines." },
        { path: "/test/cwd/AGENTS.md", content: "Project guidelines." },
      ],
    });

    expect(result).toContain("<project_instructions path=\"/home/AGENTS.md\">");
    expect(result).toContain("Global guidelines.");
    expect(result).toContain("<project_instructions path=\"/test/cwd/AGENTS.md\">");
    expect(result).toContain("Project guidelines.");
  });

  it("places project_context after agent_instructions and before skill extras", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [
        { path: "/test/cwd/AGENTS.md", content: "Context content." },
      ],
      skillBlocks: [
        { name: "tdd", description: "TDD workflow", content: "TDD content." },
      ],
    });

    const agentInstructionsEnd = result.indexOf("</agent_instructions>");
    const projectContextStart = result.indexOf("<project_context>");
    const skillStart = result.indexOf("<available_skills>");

    // project_context should come after agent_instructions
    expect(projectContextStart).toBeGreaterThan(agentInstructionsEnd);
    // skill extras should come after project_context
    expect(skillStart).toBeGreaterThan(projectContextStart);
  });

  it("does not include project_context when contextFiles is empty", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [],
    });

    expect(result).not.toContain("<project_context>");
  });

  it("does not include project_context when contextFiles is undefined", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {});

    expect(result).not.toContain("<project_context>");
  });

  it("escapes XML in context file paths but not content", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      contextFiles: [
        { path: "/path/<with>/special.md", content: "Use <tag> syntax." },
      ],
    });

    // Path in attribute is escaped
    expect(result).toContain("&lt;with&gt;");
    // Content between tags is NOT escaped (readable for LLMs, consistent with skillBlocks)
    expect(result).toContain("Use <tag> syntax.");
  });
});

describe("buildAgentPrompt — inherit mode scaffolding stripping", () => {
  const parentBase = "You are a helpful AI assistant. You follow instructions carefully.";

  it("strips <project_context>...</project_context> block", () => {
    const parentPrompt = `${parentBase}

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/home/user/AGENTS.md">
Always use TDD.
</project_instructions>

</project_context>`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain(parentBase);
    expect(result).not.toContain("<project_context>");
    expect(result).not.toContain("Always use TDD.");
    expect(result).not.toContain("</project_context>");
  });

  it("strips skills block (text intro + <available_skills>)", () => {
    const parentPrompt = `${parentBase}

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
<skill><name>tdd</name><description>TDD workflow</description><location>/skills/tdd/SKILL.md</location></skill>
</available_skills>`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain(parentBase);
    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("The following skills provide");
    expect(result).not.toContain("Use the read tool to load a skill");
    expect(result).not.toContain("</available_skills>");
  });

  it("strips Current date: line", () => {
    const parentPrompt = `${parentBase}

Current date: 2026-06-17`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain(parentBase);
    expect(result).not.toContain("Current date:");
  });

  it("strips Current working directory: line", () => {
    const parentPrompt = `${parentBase}

Current working directory: /home/user/project`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain(parentBase);
    expect(result).not.toContain("Current working directory:");
  });

  it("strips all scaffolding sections together", () => {
    const parentPrompt = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

<active_agent name="parent"/>

# Environment
Working directory: /home/user/project
Git repository: yes
Branch: main
Platform: linux

<agent_instructions>
Do the thing.
</agent_instructions>

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/home/user/AGENTS.md">
Always use TDD.
</project_instructions>

</project_context>

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
<skill><name>tdd</name><description>TDD workflow</description><location>/skills/tdd/SKILL.md</location></skill>
</available_skills>

Current date: 2026-06-17
Current working directory: /home/user/project`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    // Base prompt content preserved
    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).toContain("Do the thing.");
    // Scaffolding stripped
    expect(result).not.toContain("<project_context>");
    expect(result).not.toContain("</project_context>");
    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("</available_skills>");
    expect(result).not.toContain("The following skills provide");
    expect(result).not.toContain("Current date:");
    expect(result).not.toContain("Current working directory:");
    // Subagent adds its own env block
    expect(result).toContain("Working directory: /test/cwd");
  });

  it("is idempotent — no crash when sections are absent", () => {
    const parentPrompt = `You are a helpful AI assistant.`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain("You are a helpful AI assistant.");
    expect(result).toContain("<agent_instructions>");
    expect(result).toContain(baseConfig.systemPrompt);
  });

  it("handles empty parent prompt", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: "" }, "inherit");

    // Falls back to replace mode header
    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).toContain("<agent_instructions>");
  });

  it("handles parent prompt with only scaffolding", () => {
    const parentPrompt = `<project_context>
<project_instructions path="/AGENTS.md">stuff</project_instructions>
</project_context>

<available_skills>
<skill><name>x</name><description>y</description></skill>
</available_skills>

Current date: 2026-01-01
Current working directory: /tmp`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    // All scaffolding gone — falls back to replace mode header since nothing remains
    expect(result).not.toContain("<project_context>");
    expect(result).not.toContain("<available_skills>");
    expect(result).not.toContain("Current date:");
    expect(result).not.toContain("Current working directory:");
    // Still has agent instructions
    expect(result).toContain("<agent_instructions>");
  });

  it("preserves special characters in base prompt", () => {
    const parentPrompt = `Use <code> blocks & "quotes" carefully. Here's a path: /home/user/file.ts`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { parentSystemPrompt: parentPrompt }, "inherit");

    expect(result).toContain("Use <code> blocks & \"quotes\" carefully.");
    expect(result).toContain("Here's a path: /home/user/file.ts");
  });

  it("includeContextFiles: true still injects AGENTS.md after stripping", () => {
    const parentPrompt = `${parentBase}

<project_context>
<project_instructions path="/old/AGENTS.md">Old content.</project_instructions>
</project_context>`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      parentSystemPrompt: parentPrompt,
      contextFiles: [{ path: "/new/AGENTS.md", content: "New content." }],
    }, "inherit");

    // Old context stripped
    expect(result).not.toContain("Old content.");
    // New context injected
    expect(result).toContain("New content.");
    expect(result).toContain("<project_context>");
  });

  it("per-agent skills setting still controls skill injection after stripping", () => {
    const parentPrompt = `${parentBase}

<available_skills>
<skill><name>old-skill</name><description>Old</description></skill>
</available_skills>`;

    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {
      parentSystemPrompt: parentPrompt,
      skillMetas: [{ name: "new-skill", description: "New", location: "/skills/new" }],
    }, "inherit");

    // Old skills stripped
    expect(result).not.toContain("old-skill");
    // New skills injected
    expect(result).toContain("new-skill");
    expect(result).toContain("<available_skills>");
  });

  it("replace mode is unaffected by stripping logic", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, {}, "replace");

    expect(result).toContain("You are a pi coding agent sub-agent.");
    expect(result).not.toContain("<project_context>");
  });

  it("custom mode is unaffected by stripping logic", () => {
    const result = buildAgentPrompt(baseConfig, "/test/cwd", env, { customSystemPrompt: "Custom." }, "custom");

    expect(result).toContain("Custom.");
    expect(result).not.toContain("<project_context>");
  });
});
