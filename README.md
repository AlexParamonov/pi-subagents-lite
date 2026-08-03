# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Sub-agents for [pi](https://pi.dev). Schema-first, minimal token overhead.

Spawn specialized agents with isolated sessions, custom tools, and per-type models. Three tools, no bloated descriptions, no prompt snippets, no usage guidelines. Names like `Agent`, `run_in_background`, and `worktree_path` are the schema.

Foreground and background agents, custom agent types, per-model concurrency, steering, cost tracking, and a live status widget.

## Install

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite   # project-local
pi -e npm:pi-subagents-lite           # try without installing
```

## Quick start

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats. Background agents acknowledge immediately and auto-deliver on completion.

```
◈ Agents
├─ ⠙ Agent  Write model precedence unit tests  6🛠︎ ·3⟳ ·↑6.8k↓1.3k 6%·12s
│  │ tail -f /tmp/pi-agent-outputs/bb3382a9-1f7e-474.log
│  └ The file already exists but is ~175 lines. The user wants a …
└─ ⠙ Explore  Explore codebase architecture  13🛠︎ ·4⟳ ·↑16.1k↓2.9k 15%·12s
   └ ## Architecture Summary: pi-subagents-lite
```

Manage everything from `/agents`: running agents (view, steer, stop), manual spawn without an LLM round-trip, model settings, concurrency, widget layout.

## Tools

- **`Agent`** — spawn a sub-agent. `prompt` is required; `agent` selects a type, `run_in_background` for fire-and-forget, `worktree_path` to run in any git repository on disk (a worktree of the parent's repo, its main checkout, or a different repo entirely). `model`, `thinking`, `max_turns`, and `max_tokens` are injected from config and frontmatter, never passed by the LLM.
- **`StopAgent`** — stop a running agent by ID. IDs come from the spawn result, the stop error, or `/agents`.
- **`AgentStatus`** — list all agents with type, short ID, and status.

## Custom agent types

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared), or `~/.pi/agent/agents/` (global). Frontmatter configures the agent, the body is its system prompt. The name auto-populates the `agent` parameter's enum, no registration needed. Built-ins `general-purpose` and `Explore` are always available; on name clash, project > shared > user > built-in.

```markdown
---
name: security-review
description: Review code for security issues
tools: [read, bash, grep]
extensions: false
skills: false
model: zai/glm-5.2
thinking: high
max_turns: 80
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

A minimal agent with just `name` and `description` gets everything, same as `general-purpose`. Set restrictions only when you want them.

### Frontmatter reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | filename | Agent type name. Must be unique. |
| `display_name` | string | `name` | Label in the UI. |
| `description` | string | `""` | One-sentence description. |
| `tools` | `true` \| `string[]` \| `false` | `true` | Tool whitelist. Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | Tool blacklist. Mutually exclusive with `tools`. |
| `extensions` | `true` \| `string[]` \| `false` | `true` | Which extensions load (hooks and commands). Does not control tool visibility. |
| `exclude_extensions` | `string[]` | none | Extension blacklist. |
| `skills` | `true` \| `string[]` \| `false` | `true` | Skill whitelist (metadata-only in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | Dump full SKILL.md content into the system prompt. Expensive. |
| `model` | string | inherit parent | `"provider/model-id"`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | unlimited | Soft turn limit, then grace turns before hard abort. |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. |
| `hidden` | boolean | `false` | Hide from the enum. Still callable by name. |

Tool and extension lists accept built-in names (`read`, `bash`, `edit`, `write`, `grep`), extension tool names (`web_search`), and `ext/*` globs (`tavily/*`). `exclude_tools: [tavily/*]` hides the tools but the extension still loads; use `exclude_extensions: [tavily]` to prevent loading.

`loadSkillsImplicitly` and `loadExtensionsImplicitly` (config, default ON) decide what an agent gets when frontmatter omits `skills` or `extensions`. Turn them OFF to default new agents to nothing and opt in explicitly.

## Model resolution

Precedence, highest first:

1. Session per-type override (`/agents` > Model settings)
2. Session global default
3. Config per-type override (`~/.pi/agent/subagents-lite.json`)
4. Config global default
5. Agent frontmatter `model`
6. Parent model

The LLM never passes `model`. Set it once in config or frontmatter and forget.

## Worktree paths and trust

`worktree_path` accepts a path inside **any git repository on disk** — a linked worktree of the parent's repo, its main checkout, or a different repo entirely. The subagent runs with that directory as its working directory. A path outside any git repo is rejected.

Cross-repo targets are gated by pi's existing trust framework: the target's saved trust decision (nearest ancestor wins) applies, and an undecided target falls back to the global `defaultProjectTrust` setting — anything other than "always" means untrusted. An untrusted target still spawns, but its project resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, its `.pi/agents` types are not discovered, and a warning is surfaced. Same-repo paths are never gated. The `/agents` spawn wizard still lists same-repo worktrees only.

## System prompt mode

`systemPromptMode` (default `replace`):

- **`replace`**: minimal generic prompt plus the agent's instructions. Lowest cost, most isolated.
- **`inherit`**: parent's system prompt plus the agent's instructions.
- **`custom`**: `~/.pi/agent/subagents-lite-prompt.md` plus the agent's instructions.

When `includeContextFiles` is `true` (default), AGENTS.md files load as shared context before agent instructions, which improves KV cache prefix hits.

## Configuration

`~/.pi/agent/subagents-lite.json`, managed via `/agents` or edited directly. Per-type model overrides are dynamic keys alongside the special fields.

```json
{
  "agent": {
    "default": "zai/glm-5.2",
    "forceBackground": true,
    "graceTurns": 6,
    "showCost": true,
    "showTools": false,
    "showTurns": true,
    "showInput": true,
    "showOutput": true,
    "showContext": true,
    "showTime": true,
    "widgetMaxLines": 12,
    "widgetMaxLinesCompact": 6,
    "widgetDescLengthFull": 50,
    "widgetCompact": true,
    "hideBackgroundCompletionsWhenCompact": false,
    "widgetShortcut": false,
    "systemPromptMode": "inherit",
    "includeContextFiles": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "disableDefaultAgents": false,
    "Explore": "xiaomi/mimo-v2.5",
    "builder": "xiaomi/mimo-v2-pro",
    "architecture-reviewer": "zai/glm-5.2",
    "planner": "zai/glm-5.2"
  },
  "concurrency": {
    "default": 4,
    "providers": {
      "llamacpp": 1,
      "ai.lan": 2
    },
    "models": {}
  }
}
```

Widget, stats visibility, and spawn defaults are all under `/agents` > Settings. When `hideBackgroundCompletionsWhenCompact` is enabled under Widget settings → Behavior, background-agent completion cards are hidden whenever tool output is collapsed. Their results remain available to the model and through Running agents.

Output logs land in `/tmp/pi-agent-outputs/<agentId>.log`, append-only and `tail -f` friendly. Logs and completed results survive on disk even if a session reload (`/reload`, extension reload) kills running agents.

## Requirements

- Node.js >= 18
- pi >= 0.82.0

## License

MIT
