/**
 * agent-discovery.test.ts — Tests for agent file parsing, merging, and config.
 */

import { describe, it, expect } from "vitest";
import { parseAgentFile, scanAgentFilesInDir, mergeAgents, parseExtensions } from "../../src/agents/agent-discovery.js";
import type { AgentConfigFromMd } from "../../src/agents/agent-discovery.js";
import type { AgentConfig } from "../../src/agents/types.js";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.js";

/* ------------------------------------------------------------------ */
/*  parseExtensions                                                    */
/* ------------------------------------------------------------------ */

describe("parseExtensions", () => {
  it("returns false when raw is false (boolean)", () => {
    expect(parseExtensions(false)).toBe(false);
  });

  it("returns false when raw is 'false'", () => {
    expect(parseExtensions("false")).toBe(false);
  });

  it("returns false when raw is 'none'", () => {
    expect(parseExtensions("none")).toBe(false);
  });

  it("returns true when raw is true (boolean)", () => {
    expect(parseExtensions(true)).toBe(true);
  });

  it("returns true when raw is 'true'", () => {
    expect(parseExtensions("true")).toBe(true);
  });

  it("returns true when raw is 'all'", () => {
    expect(parseExtensions("all")).toBe(true);
  });

  it("splits comma-separated string into array", () => {
    const result = parseExtensions("a, b, c");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("splits comma-separated string without spaces", () => {
    const result = parseExtensions("a,b,c");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for undefined input", () => {
    expect(parseExtensions(undefined)).toBeUndefined();
  });

  it("trims whitespace from each entry", () => {
    const result = parseExtensions("  foo , bar , baz  ");
    expect(result).toEqual(["foo", "bar", "baz"]);
  });

  it("returns single-element array for single value", () => {
    const result = parseExtensions("read");
    expect(result).toEqual(["read"]);
  });

  it("strips brackets from inline YAML array syntax", () => {
    const result = parseExtensions("[a, b, c]");
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("strips brackets from single-element inline array", () => {
    const result = parseExtensions("[read]");
    expect(result).toEqual(["read"]);
  });
});

/* ------------------------------------------------------------------ */
/*  parseAgentFile                                                     */
/* ------------------------------------------------------------------ */

describe("parseAgentFile", () => {
  it("parses all frontmatter fields into AgentConfigFromMd", () => {
    const content = `---
name: explorer
display_name: Explorer Agent
description: A fast exploration agent
color: red
model: anthropic/claude-haiku-4-5-20251001
tools: read, bash, grep
extensions: none
skills: all
thinking: high
max_turns: "50"
max_tokens: "2048"
hidden: "false"
---

This is the system prompt body.
`;
    const result = parseAgentFile(content, "user");
    expect(result.name).toBe("explorer");
    expect(result.display_name).toBe("Explorer Agent");
    expect(result.description).toBe("A fast exploration agent");
    expect(result.color).toBe("red");
    expect(result.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.tools).toEqual(["read", "bash", "grep"]);
    expect(result.extensions).toBe(false); // "none" → false
    expect(result.skills).toBe(true); // "all" → true
    expect(result.thinking).toBe("high");
    expect(result.max_turns).toBe(50);
    expect(result.max_tokens).toBe(2048);
    expect(result.hidden).toBe(false);
    expect(result.systemPrompt).toBe("This is the system prompt body.");
    expect(result.source).toBe("user");
  });

  it("parses minimal frontmatter with defaults", () => {
    const content = `---
name: minimal
---
Just a body.
`;
    const result = parseAgentFile(content, "project");
    expect(result.name).toBe("minimal");
    expect(result.display_name).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.color).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.extensions).toBeUndefined();
    expect(result.skills).toBeUndefined();
    expect(result.thinking).toBeUndefined();
    expect(result.max_turns).toBeUndefined();
    expect(result.max_tokens).toBeUndefined();
    expect(result.hidden).toBeUndefined();
    expect(result.systemPrompt).toBe("Just a body.");
    expect(result.source).toBe("project");
  });

  it("parses content with no frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    const result = parseAgentFile(content, "user");
    expect(result.name).toBeUndefined();
    expect(result.systemPrompt).toBe(content);
    expect(result.source).toBe("user");
  });

  it("parses empty content", () => {
    const result = parseAgentFile("", "user");
    expect(result.name).toBeUndefined();
    expect(result.systemPrompt).toBe("");
    expect(result.source).toBe("user");
  });

  it("handles tools as string array in yaml", () => {
    const content = `---
name: agent
tools:
  - read
  - bash
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.tools).toEqual(["read", "bash"]);
  });

  it.each([
    ["tools", "[read, write, edit, grep, bash]", ["read", "write", "edit", "grep", "bash"]],
    ["exclude_tools", "[agent]", ["agent"]],
    ["exclude_extensions", "[rpiv-todo, pi-fff]", ["rpiv-todo", "pi-fff"]],
    ["extensions", "[ext-a, ext-b]", ["ext-a", "ext-b"]],
    ["preload_skills", "[skill-a]", ["skill-a"]],
  ] as const)("parses inline YAML array for %s", (field, value, expected) => {
    const content = `---\nname: agent\n${field}: ${value}\n---\nbody\n`;
    const result = parseAgentFile(content, "user");
    expect(result[field]).toEqual(expected);
  });

  it("parses extensions as boolean true", () => {
    const content = makeAgentMd({ extensions: "true" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toBe(true);
  });

  it("parses extensions as 'all'", () => {
    const content = makeAgentMd({ extensions: "all" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toBe(true);
  });

  it("parses extensions as comma list", () => {
    const content = makeAgentMd({ extensions: "read, bash, write" });
    const result = parseAgentFile(content, "user");
    expect(result.extensions).toEqual(["read", "bash", "write"]);
  });

  it("parses hidden as boolean false from 'false' string", () => {
    const content = makeAgentMd({ hidden: "false" });
    const result = parseAgentFile(content, "user");
    expect(result.hidden).toBe(false);
  });

  it("parses output_transcript as boolean true", () => {
    const content = makeAgentMd({ output_transcript: "true" });
    const result = parseAgentFile(content, "user");
    expect(result.output_transcript).toBe(true);
  });

  it("parses output_transcript as boolean false", () => {
    const content = makeAgentMd({ output_transcript: "false" });
    const result = parseAgentFile(content, "user");
    expect(result.output_transcript).toBe(false);
  });

  it("output_transcript is undefined when not specified", () => {
    const content = makeAgentMd({});
    const result = parseAgentFile(content, "user");
    expect(result.output_transcript).toBeUndefined();
  });

  it("parses include_context_files as boolean true", () => {
    const content = makeAgentMd({ include_context_files: "true" });
    const result = parseAgentFile(content, "user");
    expect(result.include_context_files).toBe(true);
  });

  it("parses include_context_files as boolean false", () => {
    const content = makeAgentMd({ include_context_files: "false" });
    const result = parseAgentFile(content, "user");
    expect(result.include_context_files).toBe(false);
  });

  it("include_context_files is undefined when not specified", () => {
    const content = makeAgentMd({});
    const result = parseAgentFile(content, "user");
    expect(result.include_context_files).toBeUndefined();
  });

  it("parses include_system_prompt as boolean true", () => {
    const content = makeAgentMd({ include_system_prompt: "true" });
    const result = parseAgentFile(content, "user");
    expect(result.include_system_prompt).toBe(true);
  });

  it("parses include_system_prompt as boolean false", () => {
    const content = makeAgentMd({ include_system_prompt: "false" });
    const result = parseAgentFile(content, "user");
    expect(result.include_system_prompt).toBe(false);
  });

  it("include_system_prompt is undefined when not specified", () => {
    const content = makeAgentMd({});
    const result = parseAgentFile(content, "user");
    expect(result.include_system_prompt).toBeUndefined();
  });

  it("ignores non-boolean include_context_files and include_system_prompt without breaking parsing", () => {
    const content = `---
name: agent
include_context_files: sometimes
include_system_prompt: 42
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.name).toBe("agent");
    expect(result.include_context_files).toBeUndefined();
    expect(result.include_system_prompt).toBeUndefined();
  });

  it("parses max_turns as number", () => {
    const content = makeAgentMd({ max_turns: "10" });
    const result = parseAgentFile(content, "user");
    expect(result.max_turns).toBe(10);
  });

  it("parses max_tokens as number", () => {
    const content = makeAgentMd({ max_tokens: "1024" });
    const result = parseAgentFile(content, "user");
    expect(result.max_tokens).toBe(1024);
  });

  it("ignores unknown frontmatter fields", () => {
    const content = `---
name: agent
unknown_field: should be ignored
another_unknown: 42
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.name).toBe("agent");
  });

  it("rejects invalid thinking values", () => {
    const content = `---
name: agent
thinking: ultra
---
body
`;
    const result = parseAgentFile(content, "user");
    expect(result.thinking).toBeUndefined();
  });

  it("parses CRLF", () => {
    const result = parseAgentFile("---\r\nname: x\r\n---\r\nbody", "user");
    expect(result.name).toBe("x");
  });
});

/* ------------------------------------------------------------------ */
/*  scanAgentFilesInDir                                                */
/* ------------------------------------------------------------------ */

describe("scanAgentFilesInDir", () => {
  it("returns empty array for non-existent directory", async () => {
    const result = await scanAgentFilesInDir("/tmp/nonexistent-sdf9asdf", "user");
    expect(result).toEqual([]);
  });

  it("parses all .md files in a directory", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "alpha.md", content: makeAgentMd({ name: "alpha", model: "model/a" }) },
      { name: "beta.md", content: makeAgentMd({ name: "beta", model: "model/b" }) },
      { name: "gamma.md", content: makeAgentMd({ name: "gamma", _skip: ["model"] }) },
      { name: "readme.txt", content: "not an agent file" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toHaveLength(3);
      expect(agents.find((a) => a.name === "alpha")?.model).toBe("model/a");
      expect(agents.find((a) => a.name === "beta")?.model).toBe("model/b");
      expect(agents.find((a) => a.name === "gamma")?.model).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("returns empty array when no .md files", async () => {
    const { dir, cleanup } = tempDirWithFiles([{ name: "data.json", content: "{}" }]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("assigns source to all parsed agents", async () => {
    const { dir, cleanup } = tempDirWithFiles([{ name: "agent1.md", content: makeAgentMd({ name: "agent1" }) }]);

    try {
      const agents = await scanAgentFilesInDir(dir, "project");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.source).toBe("project");
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  mergeAgents                                                        */
/* ------------------------------------------------------------------ */

describe("mergeAgents", () => {
  it("returns empty map when no agents", () => {
    const result = mergeAgents(new Map(), [], [], []);
    expect(result instanceof Map).toBe(true);
    expect(result.size).toBe(0);
  });

  it("includes default agents when no user/project agents", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Explorer agent",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "",
        },
      ],
    ]);
    const result = mergeAgents(defaults, [], [], []);
    expect(result.size).toBe(1);
    expect(result.get("explorer")?.model).toBe("model/a");
  });

  it("user agents override defaults by name with per-field merge", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Explorer agent",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    // User agent only overrides model and description
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], []);
    const agent = result.get("explorer")!;
    expect(agent.description).toBe("User explorer");
    expect(agent.systemPrompt).toBe("user prompt");
    // Default fields preserved when user doesn't override
    expect(agent.model).toBe("model/a");
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("project agents override user and default by name", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Default explorer",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        model: "model/project",
        source: "project",
        systemPrompt: "project prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], projectAgents);
    const agent = result.get("explorer")!;
    expect(agent.model).toBe("model/project");
    expect(agent.systemPrompt).toBe("project prompt");
    // User overrides preserved where project doesn't override
    expect(agent.description).toBe("User explorer");
    // Default preserved where neither user nor project override
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("adds user-only agent types not in defaults", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "custom-agent",
        description: "A custom agent",
        source: "user",
        systemPrompt: "custom",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], []);
    expect(result.size).toBe(1);
    expect(result.get("custom-agent")?.description).toBe("A custom agent");
  });

  it("returns a Map with string keys", () => {
    const defaults = new Map([
      [
        "agent1",
        {
          name: "agent1",
          description: "Agent One",
          extensions: true,
          skills: false,
          systemPrompt: "",
          promptMode: "append" as const,
        },
      ],
    ]);
    const result = mergeAgents(defaults, [], [], []);
    expect(result.has("agent1")).toBe(true);
    expect(typeof [...result.keys()][0]).toBe("string");
  });
  it("shared agents override user and default, project overrides shared", () => {
    const defaults = new Map([
      [
        "explorer",
        {
          name: "explorer",
          description: "Default explorer",
          model: "model/a",
          extensions: true,
          skills: true,
          systemPrompt: "default prompt",
        },
      ],
    ]);
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "User explorer",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        description: "Project explorer",
        source: "project",
      },
    ];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("explorer")!;
    // Project overrides shared and user
    expect(agent.description).toBe("Project explorer");
    // Shared overrides user and default
    expect(agent.model).toBe("model/shared");
    expect(agent.systemPrompt).toBe("shared prompt"); // project didn't override this
    // Default preserved where nothing overrides
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("shared-only agents are discovered when not in defaults/user/project", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "shared-only",
        description: "Only in shared",
        source: "project",
        systemPrompt: "shared body",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    expect(result.size).toBe(1);
    expect(result.get("shared-only")?.description).toBe("Only in shared");
  });

  it("shared agents get source 'project' in merged result", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "shared-agent",
        description: "Shared",
        source: "project",
        systemPrompt: "shared",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    expect(result.get("shared-agent")?.source).toBe("project");
  });

  it("name clash between shared and project resolves in favor of project", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From shared",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From project",
        model: "model/project",
        source: "project",
        systemPrompt: "project prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("clash")!;
    // All project fields win over shared
    expect(agent.description).toBe("From project");
    expect(agent.model).toBe("model/project");
    expect(agent.systemPrompt).toBe("project prompt");
  });

  it("name clash between shared and user resolves in favor of shared", () => {
    const defaults = new Map();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From user",
        model: "model/user",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "clash",
        description: "From shared",
        model: "model/shared",
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];
    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("clash")!;
    // Shared wins over user
    expect(agent.description).toBe("From shared");
    expect(agent.model).toBe("model/shared");
    expect(agent.systemPrompt).toBe("shared prompt");
  });

  it("color threads through fromMd and survives merge", () => {
    const defaults = new Map<string, AgentConfig>();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "colored-agent",
        color: "red",
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], []);
    const agent = result.get("colored-agent")!;
    expect(agent.color).toBe("red");
  });

  it("project agent color overrides user agent color", () => {
    const defaults = new Map<string, AgentConfig>();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "agent",
        color: "red",
        source: "user",
        systemPrompt: "",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [
      {
        name: "agent",
        color: "blue",
        source: "project",
        systemPrompt: "",
      },
    ];
    const result = mergeAgents(defaults, userAgents, [], projectAgents);
    expect(result.get("agent")?.color).toBe("blue");
  });

  it("include_context_files / include_system_prompt thread through fromMd with per-layer merge", () => {
    const defaults = new Map<string, AgentConfig>();
    const userAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        include_context_files: false,
        source: "user",
        systemPrompt: "user prompt",
      },
    ];
    const sharedAgents: AgentConfigFromMd[] = [
      {
        name: "explorer",
        include_system_prompt: false,
        source: "project",
        systemPrompt: "shared prompt",
      },
    ];
    const projectAgents: AgentConfigFromMd[] = [];

    const result = mergeAgents(defaults, userAgents, sharedAgents, projectAgents);
    const agent = result.get("explorer")!;
    // Each layer's explicitly-set field survives; unset fields stay undefined (→ global).
    expect(agent.includeContextFiles).toBe(false);
    expect(agent.includeSystemPrompt).toBe(false);
  });
});
