# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Sub-agents for [pi](https://pi.dev) — schema-first, zero-fluff.**

Spawn specialized agents with isolated sessions, custom tools, and per-type models at minimal token cost.

## Schema-First Design

Every tool the LLM sees costs tokens — in the system prompt and in every turn. Most extensions layer on descriptions, prompt snippets, and usage guidelines that compound across the session. This extension takes a **schema-first** approach: the fixed, bare tool name and parameter names *are* the schema. No bloated descriptions, no prose or runtime-generated type metadata.

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
- **Model & thinking resolution** — shared 6-level precedence chain; set once, forget
- **Concurrency** — per-model and per-provider slot limits with automatic queuing
- **Steering** — inject mid-execution guidance into running agents
- **Cost & usage tracking** — input/output/cache tokens and dollar cost per agent (toggle in stats)
- **Live widget** — persistent status bar with running/completed agents, full and compact modes
- **Conversation viewer** — fullscreen transcript with live streaming, markdown rendering, and keyboard navigation
- **Worktrees** — run agents in a git worktree via `worktree_path`
- **Output logs** — `tail -f` friendly, ISO-timestamped with configurable thinking buffer (OFF, 80, 200, 500, 1000 chars). Flush rounds to sentence boundaries.
- **Constrained tool sampling** — provider-side strict JSON schema validation reduces malformed tool calls and retry loops (graceful fallback on unsupported providers)

## Install

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite   # project-local
pi -e npm:pi-subagents-lite           # try without installing
```

## Quick Start

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats; background agents acknowledge immediately and auto-deliver on completion. On parent turns, the extension also adds a compact orchestration section generated from visible agent frontmatter, so agent definitions alone are enough for basic delegation—no separate `APPEND_SYSTEM.md` is needed. Set `agent.orchestrationPrompt` to `false` to disable it.

Agents appear in the live widget:

```
◈ Agents
  ⠙ 09:42 Agent    Write model precedence unit tests  6⚙︎  3⟳ · ↑6.8k ↓1.3k 6.0%/128k (auto) · 12s
  │ tail -f /tmp/pi-agent-outputs/bb3382a9-1f7e-474.log
  └ The file already exists but is ~175 lines. The user wants a …
  ◇ 09:41 Agent    Review agent-runner.ts
  ✓ 09:40 Explorer  Explore codebase architecture  13⚙︎  4⟳ · ↑16k ↓2.9k 15.0%/128k (auto) · 12s
```

Background agents deliver a result notification when done:

```
 Subagent Result

 ✓ Explorer (model-name) · 13⚙︎  5⟳ · ↑25.9k ↓4.9k 15% · 21s
   Explore codebase architecture
   tail -f /tmp/pi-agent-outputs/4f6b0f08-7a9a-419.log
```

Foreground results land inline:

```
 ▸ Explorer
 ✓ 31⚙︎  6⟳ · ↑48.1k ↓9.2k 28% · 39s
   Explore project directory structure
```

Stop a running agent from `/agents`:

```
○ Agents
  ■ 09:42 Agent  Code review of agent-runner.ts  12⚙︎  10⟳ · ↑32.8k ↓6.2k 8% · 52s stopped
    tail -f /tmp/pi-agent-outputs/23689696-3cd3-400.log
```

## Tools

### `Agent`

Spawn a sub-agent.

| Parameter | Required | Description |
|---|---|---|
| `prompt` | ✅ | The task for the sub-agent |
| `description` | | Brief description for the caller (optional — derived from `prompt` if omitted) |
| `agent` | ✅ | Explicit type name — one of bundled `explorer`, `scout`, `implementer`, `reviewer`, `verifier`, or a custom type. The parent orchestration catalog lists visible types when enabled. `hidden: true` removes a type from automatic catalog/menu listing (still callable by name). |
| `model` | | Optional one-spawn model override. |
| `thinking` | | Optional one-spawn thinking override. |
| `run_in_background` | | Fire-and-forget; result delivered automatically when done |
| `worktree_path` | | Absolute path to a git worktree. In a trusted project, an explicitly selected worktree can supply its `.pi/agents/` for that spawn and shows a worktree label in the UI. It is never crawled automatically. Validated against the parent repo's git common dir. |

The fixed bare schema requires `agent`; `model` and `thinking` are visible optional one-spawn overrides. `max_turns` and `max_tokens` remain agent-config-only. See [Custom Agent Types](#custom-agent-types).

### `StopAgent`

Stop a running agent by ID.

| Parameter | Required | Description |
|---|---|---|
| `agent_id` | ✅ | The agent ID returned by `Agent` at spawn |

IDs come from the `Agent` result, the `StopAgent` error (lists all running IDs), or `/agents` → **Running agents**. Display format is `id (type)` (e.g. `a1b2c3 (explorer)`).

### `AgentStatus`

List all agents with type, short ID, and status. Output: `type·short_id·status, ...` (e.g. `implementer·a1b2c3·running, explorer·d4e5f6·completed`).

The result nudges the LLM to wait for automatic notifications instead of polling — preventing wasteful repeated calls while still letting it discover agents when needed.

## Custom Agent Types

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared workspace), or `~/.pi/agent/agents/` (global). Frontmatter configures the agent; the body is its system prompt. The `name` field, or the filename without `.md`, becomes the agent type. Project files are read only after project trust.

Bundled defaults `explorer`, `scout`, `implementer`, `reviewer`, and `verifier` ship as inspectable Markdown definitions and are enabled by default. The parent refreshes global and trusted current-project files before every turn, so added, changed, hidden, and removed files are reflected without restart. A trusted worktree's `.pi/agents/` is resolved as an invocation-local overlay and never mutates the parent registry. Give visible agents concise descriptions; those descriptions are parent prompt text. The automatic parent catalog advertises only exact agent names of at most 64 UTF-8 bytes without control characters, backticks, or orchestration markers; omitted names remain callable by their exact name. **Precedence:** worktree overlay (for that invocation) > project (`.pi/agents/`) > shared (`.agents/agents/`) > user (`~/.pi/agent/agents/`) > bundled defaults. `disableDefaultAgents` applies on the next parent turn and to on-demand discovery. On name clash, higher precedence wins.

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

A minimal agent — just `name` and `description` — gets all tools, extensions, and skills (subject to the global implicit-loading settings). Set restrictions only when you want them.

### Frontmatter reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | filename | Agent type name (the `agent` tool parameter). Must be unique. |
| `display_name` | string | `name` | Label in the widget, `/agents` menu, and conversation viewer. |
| `description` | string | `""` | One-sentence description in the `/agents` list and tool rendering. |
| `tools` | `true` \| `string[]` \| `false` | `true` | **Tool whitelist** — which tool schemas the LLM sees. Accepts built-in names and extension tool references (see below). Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | **Tool blacklist** — all tools except these are visible. Supports `ext/*` syntax. Mutually exclusive with `tools` (when `tools` is `string[]`). |
| `extensions` | `true` \| `string[]` \| `false` | `true` | **Extension loader** — which extensions load (hooks + commands fire). Does NOT control tool visibility. Mutually exclusive with `exclude_extensions`. |
| `exclude_extensions` | `string[]` | none | **Extension blacklist** — all extensions except these load. Mutually exclusive with `extensions` (when `extensions` is `string[]`). |
| `skills` | `true` \| `string[]` \| `false` | `true` | **Skill whitelist** — which skills are available (metadata in system prompt). |
| `preload_skills` | `string[]` \| `false` | `false` | **Full skill injection** — dump complete SKILL.md content into the system prompt instead of metadata-only. |
| `model` | string | inherit parent | Default model as `"provider/model-id"`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | number | unlimited | Soft turn limit. Agent gets a steer at the limit, then `max_turns + graceTurns` before hard abort. |
| `max_tokens` | number | unlimited | Max output tokens per LLM response. Injected into provider request payloads. |
| `hidden` | `true` \| `false` | `false` | `true` removes the type from the automatic catalog and menus; it remains explicitly callable by name. |

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

**Implicit loading.** `loadSkillsImplicitly` and `loadExtensionsImplicitly` are config globals that decide what an agent gets when its frontmatter **omits** `skills` / `extensions`. They default ON, so an agent that says nothing about either gets everything. Turn them OFF (in config, or `/agents` → Settings → Advanced → System prompt, context, skills & extensions) to default every new agent to nothing — isolated sessions and minimal token cost, with agents opting in explicitly via `skills: [debug]` / `extensions: [tavily]`. A concrete frontmatter value always overrides the global.

**Token cost ranking** (highest → lowest): `preload_skills` ≫ `tools`/`exclude_tools` (each tool schema every turn) > `extensions` (hooks fire every turn) > `skills` (metadata-only, agent reads full content on-demand) > `skills: false` (zero). Prefer metadata skills over preloading; whitelist tools aggressively for narrow agents.

## Model Resolution

Model and thinking use the same precedence (highest first):

1. **Spawn override** — optional `model` or `thinking` on this Agent call
2. **Session-agent override** — `/agents` → Settings → Agent settings, lasts the session
3. **Persistent agent override** — `~/.pi/agent/subagents-lite.json`
4. **Agent Markdown** — frontmatter in the selected agent definition
5. **Global default** — session global first, then persistent global
6. **Parent value** — inherit from the calling agent

Set a default in config or frontmatter, or use the visible optional spawn fields for a one-off override.

## System Prompt Mode

Control how the subagent system prompt is built via `systemPromptMode` (default: `replace`):

- **`replace`** — minimal generic prompt plus the agent's own `<agent_instructions>`. Lowest token cost, most isolated.
- **`inherit`** — parent's system prompt (scaffolding stripped to avoid duplication) plus `<agent_instructions>`. Best when agents need parent context and guidelines.
- **`custom`** — content of `~/.pi/agent/subagents-lite-prompt.md` plus `<agent_instructions>`. Full control.

When `includeContextFiles` is `true` (default), AGENTS.md files from the project root and `~/.pi/agent/` load as `<project_context>` before agent-specific instructions — shared static context improves KV cache prefix hit rates. Toggle off to cut token cost.

## Commands

### `/agents`

Management menu with three sections:

- **Running agents** — status and description; per-agent actions (view conversation, result, error; steer; stop) and bulk stop
- **Spawn agent** — manually spawn without the LLM. Pick a type, enter a prompt, then set model/background or open Advanced options for worktree, type, thinking, limits, grace turns, and description.
- **Settings**
  - **Agent settings** — effective model and thinking with source; global and per-agent session/saved overrides
  - **Execution** — default concurrency, force background, default max turns
  - **Appearance** — compact mode, widget size, model/thinking visibility, and stats presets
  - **Advanced** — provider/model concurrency limits, system prompt/context/skills/extensions, agent behavior/discovery, detailed widget settings, and diagnostics

## Interface

### Live widget

Persistent bar above the editor showing running, queued, and completed agents in one newest-first list, updating live. `widgetShowModelThinking` controls one shared model-and-thinking column; when OFF, both values and their column are removed to free space. When `widgetShowStartTime` is ON (the default), every row shows its local creation/start time (`HH:MM`) directly after its status symbol; for queued agents this is the time it entered the queue. Running agents show a spinner, current tool activity, turn count, Pi-compatible token/cache/cost usage, context window utilization, and elapsed time. Completed agents retain their final context and subscription snapshot. Under overflow, running and queued rows take precedence over completed rows, then the visible rows are put back into newest-first order. Click the `tail -f` path to follow output logs.

**Full mode** (header + `tail -f` path + activity):
```
  ⠙ 09:42 Explorer  description  3⚙︎  5≤30⟳ · ↑10k ↓1.8k R85k W3.0k CH89.2% $0.024 45.0%/128k (auto) · 1h 2m 3s
  │ tail -f /tmp/pi-agent-outputs/...
  └ thinking…
```

**Compact mode** (single line, description truncated, activity inline):
```
  ⠙ 09:42 Explorer  description trunc…  3⚙︎  5≤30⟳ · ↑10k ↓1.8k R85k W3.0k CH89.2% $0.024 45.0%/128k (auto) · 1h 2m 3s  thinking…
```

Turn format uses `≤` and `⟳` (`5≤30⟳` = 5 of 30 turns). Turn count is colored by usage: normal < 80%, warning 80–99%, error at 100%. The max is hidden when well below the limit. The contiguous usage group follows Pi: `↑input ↓output Rcache-read Wcache-write CHhit-rate $cost context/window (auto)`. Input visibility also controls cache fields; output, context, and cost remain independently configurable.

Compact mode is active when **Force compact** is ON, or **ctrl+o shortcut** is ON and the user has collapsed tool expansion. Force compact always wins.

### Conversation viewer

Fullscreen transcript viewer for agent sessions — opens automatically from `/agents`. Streams thinking and response text live as deltas arrive. Tool calls display matching pi's style with collapsible output.

**Navigation:** `↑↓` / `PgUp/PgDn` scroll · `g`/`G` top/bottom · `Home`/`End` jump · `f` fullscreen · `r` refresh · `q`/`Esc` close.

**Stats line:** `15⟳ · ↑12k ↓8.0k R85k W3.0k CH89.2% $0.024 47.0%/128k (auto) · 47s`. Tools and turns form one counter group with two spaces between them; Pi footer metrics remain contiguous, with ` · ` separating the counter, Pi, and duration groups. The configured stats-visibility toggles also apply here, including **Cost display**. The same Pi-compatible usage group is used by foreground and background result cards.

## Configuration

`~/.pi/agent/subagents-lite.json` — managed via `/agents`, or edit directly. Per-agent model overrides are dynamic keys in `agent`; per-agent thinking overrides live in `thinkingOverrides`.

**Migration from 1.5.x:** Agent selection is now explicit. Calls that omitted `agent` or used `general-purpose` must choose one of `explorer`, `scout`, `implementer`, `reviewer`, or `verifier`. The former built-in `Explore` model key is migrated to lowercase `explorer` unless that key is already configured, including an explicit `null` inheritance value.

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
    "widgetDescLengthCompact": 30,
    "widgetCompact": true,
    "widgetShortcut": false,
    "widgetShowModelThinking": true,
    "widgetShowStartTime": true,
    "outputThinkingBufferSize": 0,
    "finishedRetentionMinutes": 10,
    "systemPromptMode": "inherit",
    "includeContextFiles": true,
    "orchestrationPrompt": true,
    "loadSkillsImplicitly": false,
    "loadExtensionsImplicitly": false,
    "disableDefaultAgents": false,
    "explorer": "xiaomi/mimo-v2.5",
    "implementer": "xiaomi/mimo-v2-pro",
    "reviewer": "zai/glm-5.2"
  },
  "thinkingOverrides": {
    "explorer": "medium",
    "implementer": "high",
    "reviewer": "high"
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

### Parent orchestration

`orchestrationPrompt` defaults to `true`. It appends a parent-only, cache-stable catalog of visible global/trusted-current-project agents; subagents never inherit it. Visible descriptions should be concise. Only exact representable names of at most 64 UTF-8 bytes are advertised; descriptions are capped at 160 UTF-8 bytes, the catalog at 24 agents/3,879 UTF-8 bytes, and the full generated block at 4,096 UTF-8 bytes; a deterministic `… +N omitted` marker reports overflow. Toggle it in `/agents` → **Settings** → **Advanced** → **System prompt, context, skills & extensions**, or set `"orchestrationPrompt": false` under `agent` in config. Opt-out intentionally provides no automatic catalog.

**APPEND_SYSTEM.md migration:** remove only static subagent delegation rules and agent catalogs from existing `APPEND_SYSTEM.md`; retain unrelated global instructions. The generated block supplies delegation guidance and the live catalog when enabled.

### Widget settings

| Field | Default | Description |
|---|---|---|
| `widgetMaxLines` | `12` | Max total lines in full mode, including the heading. |
| `widgetMaxLinesCompact` | half of `widgetMaxLines` | Max total lines in compact mode, including the heading. |
| `widgetDescLengthFull` | `50` | Max description length in full mode. |
| `widgetDescLengthCompact` | `30` | Max description length in compact mode. |
| `widgetCompact` | `false` | Force compact mode regardless of ctrl+o state. |
| `widgetShortcut` | `false` | When ON, ctrl+o (tool expansion toggle) syncs with widget compact mode. When OFF, compact is manual via `widgetCompact`. |
| `widgetShowModelThinking` | `true` | Show one model-and-thinking column in every agent row. OFF removes the values and frees its space. |
| `widgetShowStartTime` | `true` | Show each row's local `HH:MM` creation/start time. Queued rows show their queue-entry time. |
| `outputThinkingBufferSize` | `0` | Thinking buffer ring size in chars. `0` = OFF. Flushes to output log at sentence boundaries. |
| `finishedRetentionMinutes` | `10` | Minutes to retain finished agents in the widget. |

The `↓ to navigate` heading hint is always shown while the widget is visible.

### Stats visibility

These toggles apply to the live widget and conversation viewer.

| Field | Default | Description |
|---|---|---|
| `showTools` | `true` | Tool count (⚙︎). |
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
- pi >= 0.82.0

## License

MIT
