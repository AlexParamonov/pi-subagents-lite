# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Sub-agents for [pi](https://pi.dev). Schema-first, minimal token overhead.

Spawn specialized agents with isolated sessions, custom tools, and per-type models. Three tools, no bloated descriptions, no prompt snippets, no usage guidelines. Names like `Agent`, `run_in_background`, and `worktree_path` are the schema.

Foreground and background agents with parent interrupt binding, custom agent types, per-type models, steering and continuation, cross-repo worktree support, configurable system prompt modes, a live widget and conversation viewer with cost tracking, a watchdog for stuck agents, and per-model concurrency limits.

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

The `/agents` menu covers running agents (view, steer, continue settled agents, stop, clear), manual spawns without an LLM round-trip, model settings, concurrency, and widget layout.

## Tools

- **`Agent`**: spawn a sub-agent:
  - `prompt` is a required task text.
  - `agent` is an agent type; defaults to `general-purpose`.
  - `run_in_background` is a boolean toggle for fire-and-forget. Agent will return immediately and notify the parent on completion.
  - `worktree_path` can be any git repository on disk: a worktree of the parent's repo, its main checkout, or a different repo entirely. See [Worktree paths and trust](#worktree-paths-and-trust).
  `model`, `thinking`, `max_turns`, and `max_tokens` are injected from config and frontmatter, never passed by the LLM. Foreground agents are bound to the parent's interrupt: stopping the parent stops them (partial output preserved); background agents are not affected.
- **`StopAgent`**: stop a running or queued agent by ID. IDs come from the spawn result, the stop error, or `/agents`.
- **`AgentStatus`**: list all agents with type, short ID, and status.

## Custom agent types

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared), or `~/.pi/agent/agents/` (global). Frontmatter configures the agent, the body is its system prompt. The name auto-populates the `agent` parameter's enum, so nothing needs registering. Built-ins `general-purpose` and `Explore` are always available; on name clash, project > shared > user > built-in. Type names resolve case-insensitively.

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
| `name` | string | — | Agent type name. Must be unique; a file without it is skipped. |
| `display_name` | string | `name` | Label in the UI. |
| `description` | string | `""` | One-sentence description. |
| `tools` | `true` \| `string[]` \| `false` | `true` | Tool whitelist. Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | Tool blacklist. Mutually exclusive with `tools`. |
| `extensions` | `true` \| `string[]` \| `false` | `true` | Which extensions load (hooks and commands). Does not control tool visibility. |
| `exclude_extensions` | `string[]` | none | Extension blacklist. |
| `skills` | `true` \| `string[]` \| `false` | `true` | Skill whitelist (metadata-only in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | Dump full SKILL.md content into the system prompt. Expensive. |
| `model` | string | inherit parent | `"provider/model-id"`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | number | unlimited | Soft turn limit, then grace turns before hard abort. |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. |
| `hidden` | boolean | `false` | Hide from the enum. Still callable by name. |
| `output_transcript` | boolean | inherit global | Write streaming transcript to `/tmp/pi-agent-outputs/<agentId>.log` (frontmatter overrides). |
| `include_context_files` | boolean | inherit global | Include AGENTS.md files as `<project_context>` in the system prompt. `true` = load, `false` = none, unset = global "Include AGENTS.md" setting. |
| `include_system_prompt` | boolean | inherit global | Include the parent's system prompt for this agent. `true` = inherit parent, `false` = replace mode, unset = global mode. When the global mode is `custom`, the custom prompt wins over `true`. |

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

## Steering and continuation

Steer a running agent mid-task to redirect it: `Enter` in the conversation viewer, or `Steer` in the `/agents` menu. Settled agents (completed, errored, stopped, turn-limited) can be continued manually from the conversation viewer.

## Worktree paths and trust

`worktree_path` accepts a path inside **any git repository on disk**: a linked worktree of the parent's repo, its main checkout, or a different repo entirely. The subagent runs with that directory as its working directory. A path outside any git repo is rejected.

Cross-repo targets are gated by pi's existing trust framework: the target's saved trust decision (nearest ancestor wins) applies, and an undecided target falls back to the global `defaultProjectTrust` setting: anything other than "always" means untrusted. An untrusted target still spawns, but its project resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, its `.pi/agents` types are not discovered, the extension's project config (`.pi/subagents-lite.json`) is not loaded, and pi surfaces a warning. Same-repo paths are never gated. The `/agents` spawn wizard still lists same-repo worktrees only.

## System prompt mode

`systemPromptMode` (default `replace`):

- **`replace`**: minimal generic prompt plus the agent's instructions. Lowest cost and most isolated.
- **`inherit`**: parent's system prompt plus the agent's instructions.
- **`custom`**: `~/.pi/agent/subagents-lite-prompt.md` plus the agent's instructions.

When `includeContextFiles` is `true` (default), AGENTS.md files load as shared context before agent instructions, which improves KV cache prefix hits.

## Widget

The widget keeps a live roster of agents and a status bar in pi's status area. `↑`/`↓` navigates it, `Enter` opens the conversation viewer, `Esc` closes it; `ctrl+o` toggles compact mode when the shortcut is enabled. The viewer streams the live transcript: thinking blocks, tool calls, compaction summaries, and results.

Finished agents stay in the widget for `finishedRetentionMinutes` (decimal) after settling, and in the Running Agents menu for the rest of the session. `Clear` removes one agent, `Clear done` all completed, `Clear all` all finished.

Most of the widget is configurable: per-stat visibility, model and thinking display, widget sizing, etc.

## Watchdog

The watchdog stops agents that hang. Two independent checks, both default 45 minutes, `0` disables:

- `toolTimeoutMinutes`: a single tool call running longer than this stops the agent.
- `idleTimeoutMinutes`: no activity (tool events or streamed response text) for this long stops the agent.

The watchdog notifies the main session on a kill so it can act accordingly.

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
    "widgetCompact": true,
    "showCompletionCards": true,
    "widgetShortcut": false,
    "finishedRetentionMinutes": 1,
    "modelDisplayStyle": "name",
    "modelThinkingPlacement": "metadata",
    "statusBarFormat": "full",
    "agentToolStrictMode": false,
    "toolTimeoutMinutes": 45,
    "idleTimeoutMinutes": 45,
    "systemPromptMode": "inherit",
    "includeContextFiles": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "disableDefaultAgents": false,
    "outputTranscript": true,
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

Widget, stats visibility, and spawn defaults are all under `/agents` > Settings.

`concurrency` caps parallel agents: a per-model limit overrides a per-provider limit, which overrides the `default` per-model limit; excess spawns queue until a slot frees. `agentToolStrictMode` makes Agent-tool sampling use strict json_schema, which produces fewer malformed calls at a higher token cost.

### Project-level config

A project can commit its own defaults as `.pi/subagents-lite.json` (same file name as the global one). It is an **override layer**, not a full config: it may contain only model and concurrency settings (`agent.default`, per-type model overrides, `concurrency`), and each key it sets overrides the global file's value. Every other setting — widget, watchdog, spawn defaults — always comes from the global file. The effective value of each key resolves as: session override > project file > global file > built-in default.

Output transcripts are disabled by default; enable them globally via the `outputTranscript` config option or per-agent via the `output_transcript` frontmatter field. When enabled, the transcript streams to `/tmp/pi-agent-outputs/<agentId>.log` (append-only, `tail -f` friendly) and the widget shows the `tail -f` line. Logs and completed results survive on disk even if a session reload (`/reload`, extension reload) kills running agents.

## Requirements

- Node.js >= 18
- pi >= 0.82.0

## License

MIT
