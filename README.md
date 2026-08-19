# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Sub-agents for [pi](https://pi.dev). Schema-first, minimal token overhead.

Spawn custom agents in isolated session with own tools, extensions and model. Three tools, no descriptions, minimal token overhead. Names like `Agent`, `run_in_background`, and `worktree_path` are the schema.

Foreground and background agents with detailed model configuration, concurrency, custom agent types, steering and continuation, cross-repo worktree support, configurable system prompt modes, a live widget and conversation viewer with cost tracking, and a watchdog for stuck agents.

## Install

Requires Node.js >= 18 and pi >= 0.82.0.

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite   # project-local
pi -e npm:pi-subagents-lite           # try without installing
```

## Usage

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats. Background agents acknowledge immediately and auto-deliver on completion.

```
◈ Agents
  ⠧ builder  Bump all gpu_inference_proxy deps to latest  6⟳ ·↑7k↓2k 2%·$0.00·54s
  │ MiMo V2.5 • high
  └ running command…
  ⠧ scout  Explore keepalive events config  25⟳ ·↑79k↓5k 8%·$0.01·2m 39s
  │ MiMo V2.5 • high
  └ Now I have enough information to provide a comprehensive answer.
```

The widget shows running and recently finished agents above the editor. `↓`/`↑` highlights an agent, `Enter` opens the conversation viewer, `Esc` closes navigation. The viewer streams the live transcript: thinking blocks, tool calls, compaction summaries, and results.

The `/agents` menu covers running agents (view, steer, continue settled agents, stop, clear), manual spawns without an LLM round-trip, model settings, concurrency, and widget layout.

### Agent tools

- `Agent` spawns a sub-agent (see [Agent options](#agent-options) for parameters).
- `StopAgent` stops a running or queued agent by ID. IDs come from the spawn result, the stop error, or `/agents`.
- `AgentStatus` lists all agents with type, short ID, and status.

Foreground agents dont lock the session and can be stopped by parent's interrupt. Background agents are fully autonomous.

### Steering and continuation

Steer a running agent mid-task to redirect it: `Enter` in the conversation viewer, or `Steer` in the `/agents` menu. Settled agents (completed, errored, stopped, turn-limited) can be continued manually from the conversation viewer.

## Built-in agents

- `general-purpose` does general task execution using the configured session tools.
- `Explore` does read-only codebase exploration.

Built-ins can be overridden by custom agents or disabled from `/agents`. Disabling takes effect immediately for future `Agent` calls. Running and queued agents continue with the policy captured at spawn.

## Custom agents

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared), or `~/.pi/agent/agents/` (global). Frontmatter configures the agent, the body is its system prompt. The name auto-populates the `agent` parameter's enum, so nothing needs registering. On name clash, project > shared > user > built-in. Type names resolve case-insensitively.

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
| `color` | string | none | Agent color for icon tinting. Named colors: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. Palette aliases: `amber`, `teal`, `indigo`, `gold`, `violet`, `rose`, `lime`, `gray`, `slate`, `navy`, etc. Also accepts `#RRGGBB` hex. |
| `description` | string | `""` | One-sentence description. |
| `tools` | `true` \| `string[]` \| `false` | `true` | Tool whitelist. Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | Tool blacklist. Mutually exclusive with `tools`. |
| `extensions` | `true` \| `string[]` \| `false` | `true` | Which extensions load (hooks and commands). Does not control tool visibility. |
| `exclude_extensions` | `string[]` | none | Extension blacklist. |
| `skills` | `true` \| `string[]` \| `false` | `true` | Skill whitelist (metadata-only in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | Dump full SKILL.md content into the system prompt. Expensive. |
| `model` | string | inherit parent | `"provider/model-id"`. See [Model resolution](#model-resolution). |
| `thinking` | string | inherit parent | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | number | unlimited | Soft turn limit, then grace turns before hard abort. |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. |
| `hidden` | boolean | `false` | Hide from the enum. Still callable by name. |
| `output_transcript` | boolean | inherit global | Write streaming transcript to `/tmp/pi-agent-outputs/<agentId>.log` (frontmatter overrides). |
| `include_context_files` | boolean | inherit global | Include AGENTS.md files as `<project_context>` in the system prompt. `true` = load, `false` = none, unset = global "Include AGENTS.md" setting. |
| `include_system_prompt` | boolean | inherit global | Include the parent's system prompt for this agent. `true` = inherit parent, `false` = replace mode, unset = global mode. When the global mode is `custom`, the custom prompt wins over `true`. |

Tool and extension lists accept built-in names (`read`, `bash`, `edit`, `write`, `grep`), extension tool names (`web_search`), and `ext/*` globs (`tavily/*`). `exclude_tools: [tavily/*]` hides the tools but the extension still loads. Use `exclude_extensions: [tavily]` to prevent loading.

`loadSkillsImplicitly` and `loadExtensionsImplicitly` (config, default ON) decide what an agent gets when frontmatter omits `skills` or `extensions`. Turn them OFF to default new agents to nothing and opt in explicitly.

## Agent options

`Agent` accepts:

- `prompt` (required) is the task text.
- `description` is a short label for the widget; defaults to the first line of the prompt.
- `agent` is the agent type; defaults to `general-purpose`.
- `run_in_background` makes the agent return immediately and notify the parent when complete.
- `worktree_path` is any git repository on disk: a worktree of the parent's repo, its main checkout, or a different repo entirely. See [Worktree paths and trust](#worktree-paths-and-trust).

`model`, `thinking`, `max_turns`, and `max_tokens` are injected from config and frontmatter, never passed by the LLM. Set them once and forget.

Subagents cannot spawn further subagents.

### Worktree paths and trust

`worktree_path` accepts a path inside any git repository on disk: a linked worktree of the parent's repo, its main checkout, or a different repo entirely. The subagent runs with that directory as its working directory. A path outside any git repo is rejected.

Cross-repo targets are gated by pi's existing trust framework. The target's saved trust decision (nearest ancestor wins) applies, and an undecided target falls back to the global `defaultProjectTrust` setting. Anything other than "always" means untrusted. An untrusted target still spawns, but its project resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, its `.pi/agents` types are not discovered, the extension's project config (`.pi/subagents-lite.json`) is not loaded, and pi surfaces a warning. Same-repo paths are never gated. The `/agents` spawn wizard still lists same-repo worktrees only.

## Model resolution

Precedence, highest first:

1. Session per-type override (`/agents` > Model settings)
2. Session global default
3. Config per-type override (`~/.pi/agent/subagents-lite.json`)
4. Config global default
5. Agent frontmatter `model`
6. Parent model

## Concurrency

`concurrency` caps parallel agents. A per-model limit overrides a per-provider limit, which overrides the `default` per-model limit. Excess spawns queue until a slot frees.

## Settings

Global settings live in `~/.pi/agent/subagents-lite.json`, managed via `/agents` or edited directly. 

`/agents` covers model settings per-type overrides, concurrency, widget, spawn defaults (thinking, max turns, force-background), system prompt mode, watchdog timeouts.

```
Settings

→ Model settings                  Set global default and per-type model overrides
  Concurrency settings            Set per-model slot limits
  Spawn options                   Default thinking, max turns, background, grace turns
  System prompt                   Prompt mode, custom prompt file, AGENTS.md
  Widget settings                 Configure widget display options
```

Widget is higly customizable as the rest of the extension

### Project-level config

A project can commit its own defaults as `.pi/subagents-lite.json` (same file name as the global one). This is an override layer, not a full config. It may contain only model and concurrency settings (`agent.default`, per-type model overrides, `concurrency`), and each key it sets overrides the global file's value. Every other setting (widget, watchdog, spawn defaults) always comes from the global file. The effective value of each key resolves as: session override > project file > global file > built-in default.

### System prompt mode

`systemPromptMode` (default `replace`):

- `replace` uses a minimal generic prompt plus the agent's instructions. Lowest cost and most isolated.
- `inherit` uses the parent's system prompt plus the agent's instructions.
- `custom` uses `~/.pi/agent/subagents-lite-prompt.md` plus the agent's instructions.

When `includeContextFiles` is `true` (default), AGENTS.md files load as shared context before agent instructions, which improves KV cache prefix hits.

### Watchdog

The watchdog stops agents that hang. Two independent checks, both default 45 minutes, `0` disables:

- `toolTimeoutMinutes`: a single tool call running longer than this stops the agent.
- `idleTimeoutMinutes`: no activity (tool events or streamed response text) for this long stops the agent.

The watchdog notifies the main session on a kill so it can act accordingly.

### Output transcripts

Output transcripts are disabled by default. Enable them globally via the `outputTranscript` config option or per-agent via the `output_transcript` frontmatter field. When enabled, the transcript streams to `/tmp/pi-agent-outputs/<agentId>.log` (append-only, `tail -f` friendly) and the widget shows the `tail -f` line. Logs and completed results survive on disk even if a session reload (`/reload`, extension reload) kills running agents.

## License

MIT
