# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Sub-agents for [pi](https://pi.dev) — schema-first, zero-fluff.**

Spawn specialized agents with isolated sessions, custom tools, and per-type models at minimal token cost.

## Schema-First Design

Every tool the LLM sees costs tokens — in the system prompt and in every turn. Most extensions layer on descriptions, prompt snippets, and usage guidelines that compound across the session. This extension takes a **schema-first** approach: the tool name and parameter names *are* the schema. No bloated descriptions, no prose.

| Standard | Schema-first |
|---|---|
| `description: "Spawn a sub-agent"` | _(removed)_ |
| `promptSnippet` with usage examples | _(none)_ |
| `promptGuidelines` with rules | _(none)_ |
| Parameters with `.description()` | Bare `Type.String()` |

Names like `Agent`, `StopAgent`, `AgentStatus`, `run_in_background`, `worktree_path` are self-documenting. Results reinforce correct usage with clear success/error messages.

**Result:** foreground and background agents, custom agent types, per-model concurrency, cost tracking, steering, model overrides, and agent status — all with minimal token overhead.

## Features

- **Three tools** — `Agent` (spawn), `StopAgent` (stop), `AgentStatus` (list)
- **Foreground & background** — block, or fire-and-forget with auto-delivered results
- **Custom agent types** — `.md` files with YAML frontmatter (tools, model, thinking, turn/token limits)
- **Manual spawn** — from `/agents`, no LLM round-trip; full control over model, thinking, turns, tokens, background
- **Model resolution** — 6-level precedence chain; set once, forget
- **Concurrency** — per-model and per-provider slot limits with automatic queuing
- **Steering** — inject mid-execution guidance into running agents
- **Cost & usage tracking** — input/output/cache tokens and dollar cost per agent (toggle in stats)
- **Live widget** — persistent status bar with running/completed agents, full and compact modes
- **Result viewer** — fullscreen markdown with stats
- **Worktrees** — run agents in a git worktree via `worktree_path`
- **Output logs** — `tail -f` friendly, ISO-timestamped with configurable thinking buffer (OFF, 80, 200, 500, 1000 chars). Flush rounds to sentence boundaries.

## Install

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite   # project-local
pi -e npm:pi-subagents-lite           # try without installing
```

## Quick Start

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats; background agents acknowledge immediately and auto-deliver on completion.

Running agents appear in the live widget:

```
● Agents
├─ ⠙ Agent  Write model precedence unit tests  6🛠 ·3⟳ ·↑6.8k↓1.3k 6%·12s
│  │ tail -f /tmp/pi-agent-outputs/bb3382a9-1f7e-474.log
│  └ The file already exists but is ~175 lines. The user wants a …
├─ ⠙ Agent  Code review of agent-runner.ts  4🛠 ·2⟳ ·↑7.2k↓1.5k 4%·12s
│  └ Now let me check the types and related files for context on …
└─ ⠙ Explore  Explore codebase architecture  13🛠 ·4⟳ ·↑16.1k↓2.9k 15%·12s
   └ ## Architecture Summary: pi-subagents-lite
```

Background agents deliver a result notification when done:

```
 Subagent Result

 ✓ Explore (model-name)·13🛠 ·5⟳ ·↑25.9k↓4.9k 15%·21s
   Explore codebase architecture
   tail -f /tmp/pi-agent-outputs/4f6b0f08-7a9a-419.log
```

Foreground results land inline:

```
 ▸ Explore
 ✓ 31🛠 ·6⟳ ·↑48.1k↓9.2k 28%·39s
   Explore project directory structure
```

Stop a running agent from `/agents`:

```
○ Agents
└─ ■ Agent  Code review of agent-runner.ts  12🛠 ·10⟳ ·↑32.8k↓6.2k 8%·52s stopped
    tail -f /tmp/pi-agent-outputs/23689696-3cd3-400.log
```

## Tools

### `Agent`

Spawn a sub-agent.

| Parameter | Required | Description |
|---|---|---|
| `prompt` | ✅ | The task for the sub-agent |
| `description` | | Brief description for the caller (optional — derived from `prompt` if omitted) |
| `agent` | | Type name — `general-purpose`, `Explore`, or any custom type. **Auto-populated** from `.md` files in your agent directories; drop a file, it appears in the enum. `hidden: true` hides a type from the list (still callable by name). |
| `run_in_background` | | Fire-and-forget; result delivered automatically when done |
| `worktree_path` | | Absolute path to a git worktree. Agent runs in that worktree's context, discovers agents from its `.pi/agents/`, and shows a worktree label in the UI. Validated against the parent repo's git common dir. |

> `model`, `max_turns`, `max_tokens`, and `thinking` are **not visible to the LLM** — injected at call time from agent config and frontmatter. See [Custom Agent Types](#custom-agent-types).

### `StopAgent`

Stop a running agent by ID.

| Parameter | Required | Description |
|---|---|---|
| `agent_id` | ✅ | The agent ID returned by `Agent` at spawn |

IDs come from the `Agent` result, the `StopAgent` error (lists all running IDs), or `/agents` → **Running agents**. Display format is `id (type)` (e.g. `a1b2c3 (Explore)`).

### `AgentStatus`

List all agents with type, short ID, and status. Output: `type·short_id·status, ...` (e.g. `general-purpose·a1b2c3·running, Explore·d4e5f6·completed`).

The result nudges the LLM to wait for automatic notifications instead of polling — preventing wasteful repeated calls while still letting it discover agents when needed.

## Custom Agent Types

Drop a `.md` file into `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Frontmatter configures the agent; the body is its system prompt. The `name` field (or filename) becomes the agent type and **auto-populates the `agent` parameter's enum** — no registration. Files added mid-session are picked up on the next call that references them.

Built-ins `general-purpose` and `Explore` are always available. **Project agents override user agents, which override built-ins.**

```markdown
---
name: security-review
display_name: Security Review
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

A minimal agent — just `name` and `description` — gets everything: all tools, extensions, and skills, same as `general-purpose`. Set restrictions only when you want them.

### Frontmatter reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | filename | Agent type name (the `agent` enum value). Must be unique. |
| `display_name` | string | `name` | Label in the widget, `/agents` menu, and result viewer. |
| `description` | string | `""` | One-sentence description in the `/agents` list and tool rendering. |
| `tools` | `true` \| `string[]` \| `false` | `true` | **Tool whitelist** — which tool schemas the LLM sees. Accepts built-in names and extension tool references (see below). Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | **Tool blacklist** — all tools except these are visible. Supports `ext/*` syntax. Mutually exclusive with `tools` (when `tools` is `string[]`). |
| `extensions` | `true` \| `string[]` \| `false` | `true` | **Extension loader** — which extensions load (hooks + commands fire). Does NOT control tool visibility. Mutually exclusive with `exclude_extensions`. |
| `exclude_extensions` | `string[]` | none | **Extension blacklist** — all extensions except these load. Mutually exclusive with `extensions` (when `extensions` is `string[]`). |
| `skills` | `true` \| `string[]` \| `false` | `true` | **Skill whitelist** — which skills are available (metadata in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | **Full skill injection** — dump complete SKILL.md content into the system prompt instead of metadata-only. |
| `model` | string | inherit parent | Default model as `"provider/model-id"`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | unlimited | Soft turn limit. Agent gets a steer at the limit, then `max_turns + graceTurns` before hard abort. |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. Injected into provider request payloads. |
| `hidden` | `true` \| `false` | `false` | `true` hides the type from the enum (LLM can't see or invoke it). Still callable by name. |

### Tool control (`tools` / `exclude_tools`)

Use a whitelist (`tools`) when an agent needs few tools, or a blacklist (`exclude_tools`) when it needs most. You can use **either**, not both; if both are set, the whitelist wins.

Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`.

| Value | Meaning |
|---|---|
| `true` / omitted | All tools visible |
| `false` | No tools visible |
| `[read, bash]` | Only listed built-in tools |
| `[web_search]` | Extension tool by name |
| `[tavily/*]` | All tools from an extension |
| `[tavily/web_search]` | Specific tool from an extension |

```yaml
# Read-only via whitelist
tools: [read, bash, grep]
extensions: false

# Same result via blacklist (easier to maintain as the toolset grows)
exclude_tools: [edit, write]
```

> `exclude_tools: [tavily/*]` hides tavily's tools but the extension still loads (hooks fire). Use `exclude_extensions: [tavily]` to prevent loading entirely.

### Extensions & skills

**What they are:**
- **Tools** are callable functions — `read`, `bash`, `edit`, `write`, `grep` (built-in), or `web_search` / `tavily/*` (from extensions). The `tools` whitelist controls which tool schemas the LLM sees.
- **Skills** are reusable instruction files (`SKILL.md`) that teach an agent how to do a task — e.g. `debug`, `tdd`. By default the agent sees only skill metadata (name, description, path) in its system prompt and reads the full content on-demand via `read`.
- **Extensions** are pi plugins (e.g. `tavily`, `pi-tokf`) that register tools and hooks. Loading one makes its hooks fire and its tools *available* — but those tools still need to pass the `tools` whitelist to be visible.

`extensions` controls which extensions **load** (hooks + tool registration), not tool visibility. `skills` and `preload_skills` control skill availability. Same whitelist/blacklist rules and `ext/*` syntax as `tools`.

| `extensions` value | Meaning |
|---|---|
| `true` / omitted | Load all extensions |
| `false` | Load none |
| `[tavily, pi-tokf]` | Load only listed extensions |

| Skill field | Value | Effect |
|---|---|---|
| `skills` | `true` / `[debug, tdd]` / `false` | All / listed / no skills (metadata-only in system prompt) |
| `preload_skills` | `[debug]` / `false` | Dump full SKILL.md content / none (default) |

**Implicit loading.** `loadSkillsImplicitly` and `loadExtensionsImplicitly` are config globals that decide what an agent gets when its frontmatter **omits** `skills` / `extensions`. They default ON, so an agent that says nothing about either gets everything. Turn them OFF (in config, or `/agents` → System prompt) to default every new agent to nothing — isolated sessions and minimal token cost, with agents opting in explicitly via `skills: [debug]` / `extensions: [tavily]`. A concrete frontmatter value always overrides the global.

**Token cost ranking** (highest → lowest): `preload_skills` ≫ `tools`/`exclude_tools` (each tool schema every turn) > `extensions` (hooks fire every turn) > `skills` (metadata-only, agent reads full content on-demand) > `skills: false` (zero). Prefer metadata skills over preloading; whitelist tools aggressively for narrow agents.

## Model Resolution

The extension picks the right model automatically. Precedence (highest first):

1. **Session per-type override** — `/agents` → Model settings, lasts the session
2. **Session global default** — temporary
3. **Config per-type override** — `~/.pi/agent/subagents-lite.json`
4. **Config global default**
5. **Agent frontmatter** — `model` in `.md`
6. **Parent model** — inherit from the calling agent

The LLM never passes `model` — it's injected at call time. Set it once in config or frontmatter and forget.

## System Prompt Mode

Control how the subagent system prompt is built via `systemPromptMode` (default: `replace`):

- **`replace`** — minimal generic prompt plus the agent's own `<agent_instructions>`. Lowest token cost, most isolated.
- **`inherit`** — parent's system prompt (scaffolding stripped to avoid duplication) plus `<agent_instructions>`. Best when agents need parent context and guidelines.
- **`custom`** — content of `~/.pi/agent/subagents-lite-prompt.md` plus `<agent_instructions>`. Full control.

When `includeContextFiles` is `true` (default), AGENTS.md files from the project root and `~/.pi/agent/` load as `<project_context>` before agent-specific instructions — shared static context improves KV cache prefix hit rates. Toggle off to cut token cost.

## Commands

### `/agents`

Management menu with four sections:

- **Running agents** — status and description; per-agent actions (view snapshot, result, error; steer; stop) and bulk stop
- **Spawn agent** — manually spawn without the LLM. Pick a type (with search), enter a prompt, tune options (model, thinking, max turns, max tokens, grace turns, background), then spawn. Options pre-fill from agent config.
- **Settings**
  - **Model settings** — global default, per-type overrides, session overrides, clear all
  - **Spawn options** — force background, grace turns, default max turns, default thinking, disable default agents
  - **System prompt** — mode, custom prompt file, include AGENTS.md, load skills/extensions implicitly
  - **Concurrency** — default limit, per-provider and per-model slots (with search), reset to defaults
  - **Widget settings** — force compact, max lines, description length, thinking buffer size, ctrl+o shortcut, usage stats (toggle tools, turns, input/output tokens, context %, cost, time)

## Interface

### Live widget

Persistent bar above the editor showing running and completed agents, updating live. Running agents show a spinner, current tool activity, turn count, token usage (with optional context-fill %), and elapsed time. Completed agents show a check mark with final stats. Click the `tail -f` path to follow output logs.

**Full mode** (tree, header + `tail -f` path + activity):
```
├─ ⠙ Explore  description  3🛠 ·5≤30⟳ ·↑10.2k↓1.8k 45%·1h 2m 3s
│  │ tail -f /tmp/pi-agent-outputs/...
│  └ thinking…
```

**Compact mode** (single line, description truncated, activity inline):
```
├─ ⠙ Explore  description trunc…  3🛠 ·5≤30⟳ ·↑10.2k↓1.8k 45%·1h 2m 3s  thinking…
```

Turn format uses `≤` and `⟳` (`5≤30⟳` = 5 of 30 turns). Turn count is colored by usage: normal < 80%, warning 80–99%, error at 100%. The max is hidden when well below the limit. Token glyphs (`↑` input, `↓` output) are self-explanatory — no "tokens" label.

Compact mode is active when **Force compact** is ON, or **ctrl+o shortcut** is ON and the user has collapsed tool expansion. Force compact always wins.

### Result viewer

Fullscreen markdown viewer for completed agent results — opens automatically from `/agents`. Keys: `↑↓` / `PgUp/PgDn` navigate · `g`/`G` top/bottom · `f` fullscreen · `r` refresh · `q`/`Esc` close. Stats line: `↑12.0k · ↓8.0k · W3.0k · $0.024 · 15 turns · 47s`.

With **Cost display** ON, stats show dollar cost (`✓ Builder·2🛠 ·5⟳ ·↑10.2k↓1.8k $0.008·10s`) and the status bar totals it (`agents: $0.008`). Toggle as a session override from Model settings.

## Configuration

`~/.pi/agent/subagents-lite.json` — managed via `/agents`, or edit directly. Per-type model overrides (e.g. `"Explore"`) are dynamic keys alongside the special fields.

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

### Widget settings

| Field | Default | Description |
|---|---|---|
| `widgetMaxLines` | `12` | Max body lines in full mode (excluding heading). |
| `widgetMaxLinesCompact` | half of `widgetMaxLines` | Max body lines in compact mode. |
| `widgetDescLengthFull` | `50` | Max description length in full mode. |
| `widgetDescLengthCompact` | `30` | Max description length in compact mode. |
| `widgetCompact` | `false` | Force compact mode regardless of ctrl+o state. |
| `widgetShortcut` | `false` | When ON, ctrl+o (tool expansion toggle) syncs with widget compact mode. When OFF, compact is manual via `widgetCompact`. |
| `outputThinkingBufferSize` | `200` | Thinking buffer ring size in chars. `0` = OFF. Flushes to output log at sentence boundaries. |

### Stats visibility

| Field | Default | Description |
|---|---|---|
| `showTools` | `true` | Tool count (🛠). |
| `showTurns` | `true` | Turn count (⟳). |
| `showInput` | `true` | Input tokens (↑). |
| `showOutput` | `true` | Output tokens (↓). |
| `showContext` | `true` | Context-fill percent (%). |
| `showCost` | `false` | Dollar cost ($). |
| `showTime` | `true` | Elapsed time. |

> **Reload safety:** if a session reload (`/reload`, extension reload) kills running agents, the UI reports the count lost. Output logs and completed results are preserved on disk.

## Output Logs

`/tmp/pi-agent-outputs/<agentId>.log` — append-only, human-readable, `tail -f` friendly. Every line is ISO-8601 timestamped:

```
2026-05-27T12:00:00.000Z [USER] Find all authentication files
2026-05-27T12:00:02.000Z [TOOL] read("src/auth/index.ts")
2026-05-27T12:00:02.000Z [TOOL_RESULT] read: 234 chars
2026-05-27T12:00:15.000Z [ASSISTANT] I found the authentication module...
2026-05-27T12:00:45.000Z [DONE] 5 turns, 12 tool uses, 12.3k tokens, $0.024
```

## Requirements

- Node.js >= 18
- pi >= 0.74.0

## License

MIT
