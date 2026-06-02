# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Sub-agents for [pi](https://pi.dev) — schema-first, zero-fluff.**

Spawn specialized agents with isolated sessions, custom tools, and per-type models — all at minimal token cost.

## Schema-First Design

Every tool the LLM sees costs tokens — in the system prompt, and in every turn's context. Most extensions add description text, prompt snippets, and usage guidelines that compound across the session. This extension takes a **schema-first** approach: the tool name and parameter names **are** the schema. No bloated descriptions, no prose.

| Standard | Schema-first |
|---|---|
| `description: "Spawn a sub-agent"` | _(removed)_ |
| `promptSnippet` with usage examples | _(none)_ |
| `promptGuidelines` with rules | _(none)_ |
| Parameters with `.description()` | Bare `Type.String()` |

Tool names like `Agent` and `StopAgent`, and parameter names like `prompt`, `description`, `run_in_background` are self-documenting. The LLM infers usage from the schema — no verbose descriptions needed. Tool results reinforce correct usage with clear success/error messages.

**Result:** foreground and background agents, custom agent types, per-model concurrency, cost tracking, steering, model overrides — all with minimal token overhead.

## Features

- **Two tools** — `Agent` (spawn) and `StopAgent` (stop)
- **Foreground & background** — block or fire-and-forget with auto-delivered results
- **Custom agent types** — define via `.md` files with YAML frontmatter (tools, model, thinking, turn limits)
- **Smart model resolution** — 6-level precedence: session → config → frontmatter → parent. Set once, forget
- **Concurrency control** — per-model and per-provider slot limits with automatic queuing
- **Cost tracking** — input/output/cache tokens and dollar cost per agent
- **Cost display** — toggle agent cost in stats and status bar (OFF by default)
- **Live widget** — persistent status bar above the editor showing running/completed agents
- **Result viewer** — fullscreen markdown viewer with stats
- **Steer** — inject mid-execution guidance into running agents
- **Output logs** — human-readable, `tail -f` friendly

## Install

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite        # project-local
pi -e npm:pi-subagents-lite                # try without installing
```

## Quick Start

The LLM calls the `Agent` tool like any other tool. A foreground agent returns its result inline with stats; a background agent acknowledges immediately and auto-delivers the result when done.

```
 ⠹ Working...

● Agents
├─ ⠙ Agent  Write model precedence unit tests  6🛠 ·3⟳ ·8.1k(6%)·12s
│  │ tail -f /tmp/pi-agent-outputs/bb3382a9-1f7e-474.log
│  └ The file already exists but is ~175 lines. The user wants a …
├─ ⠙ Agent  Code review of agent-runner.ts  4🛠 ·2⟳ ·8.7k(4%)·12s
│  │ tail -f /tmp/pi-agent-outputs/23689696-3cd3-400.log
│  └ Now let me check the types and related files for context on …
└─ ⠙ Explore  Explore codebase architecture  13🛠 ·4⟳ ·19.0k(15%)·12s
   │ tail -f /tmp/pi-agent-outputs/4f6b0f08-7a9a-419.log
   └ ## Architecture Summary: pi-subagents-lite
```
Then you are notified like this for async (background) invocation:

```
 Subagent Result

 ✓ Explore (model-name)·13🛠 ·5⟳ ·30.8k(15%)·21s
   Explore codebase architecture
   tail -f /tmp/pi-agent-outputs/4f6b0f08-7a9a-419.log
```

or inline:

```
 ▸ Explore
 ✓ 31🛠 ·6⟳ ·57.3k(28%)·39s
   Explore project directory structure
```

Stop a running agent at any time via /agents command

```
○ Agents
└─ ■ Agent  Code review of agent-runner.ts  12🛠 ·10⟳ ·39.0k(8%)·52s stopped
     tail -f /tmp/pi-agent-outputs/23689696-3cd3-400.log
```

### Agent Tool Parameters

| Parameter | Required | Description |
|---|---|---|
| `prompt` | ✅ | The task for the sub-agent |
| `description` | ✅ | Brief description for the LLM caller |
| `agent` | | Type name — `general-purpose`, `Explore`, or any custom type you define (see [Custom Agent Types](#custom-agent-types)). The available values are **auto-populated** from `.md` files in your agent directories — drop a file, it appears in the enum. Set `hidden: true` in frontmatter to hide a type from this list (still callable by name). |
| `run_in_background` | | Fire-and-forget; result delivered automatically when done |

> `model`, `max_turns`, and `thinking` are **not visible to the LLM** through tool introspection — the extension injects them at call time from agent config and frontmatter. `model` is resolved via the [Model Resolution](#model-resolution) chain; `max_turns`/`thinking` come from the agent's config. See [Custom Agent Types](#custom-agent-types) to set them.

## Custom Agent Types

Drop a `.md` file into `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). The frontmatter configures the agent; the body is its system prompt.

The file's `name` frontmatter field (or the filename without extension) becomes the agent type name and **automatically populates the `agent` parameter's enum** in the tool schema. No registration step needed — the extension scans these directories at session start and makes every discovered agent available to the LLM. Files added during a session are discovered on the next call that references them — no restart required.

Built-in types (`general-purpose`, `Explore`) are always available. User agents override built-ins with the same name; project agents override user agents (see [Merge precedence](#merge-precedence)).

```markdown
---
name: security-review
display_name: Security Review
description: Review code for security issues
tools: [read, bash, grep]
extensions: false
skills: false
model: anthropic/claude-sonnet-4-5-20250514
thinking: high
max_turns: 10
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

**Minimal agent — just name and description:**

```markdown
---
name: my-agent
description: Does something
---

System prompt here.
```

This agent gets everything: all tools, all extensions, all skills. Same as `general-purpose`. No boilerplate needed — set restrictions only when you want them.

**Frontmatter reference:**

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | filename | Agent type name. Used as the enum value in the `agent` parameter. Must be unique across all agent types. |
| `display_name` | string | `name` | Human-readable label shown in the UI widget, `/agents` menu, and result viewer. |
| `description` | string | `""` | Short description displayed in the `/agents` type list and tool rendering. Keep it one sentence. |
| `tools` | `true` \| `string[]` \| `false` | `true` | **Tool whitelist.** Controls which tool schemas the LLM sees. Accepts built-in names and extension tool references (see below). `true` = all tools visible; `false` = no tools; `string[]` = only listed tools visible. Mutually exclusive with `exclude_tools`. |
| `exclude_tools` | `string[]` | none | **Tool blacklist.** All tools except these are visible. Mutually exclusive with `tools` (when `tools` is `string[]`). |
| `extensions` | `true` \| `string[]` \| `false` | `true` | **Extension loader.** Controls which extensions load (hooks + commands fire). Does NOT control tool visibility. `true` = load all; `false` = load none; `string[]` = load only listed extensions. Mutually exclusive with `exclude_extensions`. |
| `exclude_extensions` | `string[]` | none | **Extension blacklist.** All extensions except these load. Mutually exclusive with `extensions` (when `extensions` is `string[]`). |
| `skills` | `true` \| `string[]` \| `false` | `true` | **Skill whitelist.** Controls which skills are available (metadata injected into system prompt). `true` = all skills; `false` = no skills; `string[]` = only listed skills. |
| `preload_skills` | `string[]` \| `false` | `false` | **Full skill injection.** Dumps complete SKILL.md content into system prompt instead of metadata-only. `string[]` = list of skills to preload; `false` = none. |
| `model` | string | inherit parent | Default model as `"provider/model-id"`. Override via `/agents` or `subagents-lite.json`. See [Model Resolution](#model-resolution). |
| `thinking` | string | inherit parent | Default thinking level. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | unlimited | Soft turn limit. Agent gets a steer message at the limit, then `max_turns + 5` grace turns before hard abort. |
| `hidden` | `true` \| `false` | `false` | `true` hides the agent type from the tool schema's enum (LLM can't see or invoke it). Agent is still callable by name. Running agents unaffected. |

#### `tools` field values

The `tools` field accepts built-in tool names and extension tool references:

| Value | Meaning | Example |
|---|---|---|
| `true` | All tools visible (default) | `tools: true` or omit the field |
| `false` | No tools visible | `tools: false` |
| `[read, bash, grep]` | Only listed built-in tools | `tools: [read, bash]` |
| `[web_search]` | Extension tool by name | `tools: [read, web_search]` |
| `[tavily/*]` | All tools from an extension | `tools: [read, tavily/*]` |
| `[tavily/web_search]` | Specific tool from extension | `tools: [read, tavily/web_search]` |
| Mixed | Combine the above | `tools: [read, bash, tavily/*, exa_search]` |

Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`.

#### Blacklist mode (`exclude_tools` and `exclude_extensions`)

When you have many tools or extensions and want to disable a few, use the blacklist fields:

```yaml
---
name: restricted-agent
description: Agent with write disabled
exclude_tools: [write]              # all tools except write
exclude_extensions: [quality-monitor]  # all extensions except quality-monitor
---
```

`exclude_tools` supports the same `ext/*` syntax as `tools`:

```yaml
exclude_tools: [tavily/*]           # hide all tavily tools (extension still loads)
exclude_tools: [write, tavily/*]    # hide write + all tavily tools
exclude_tools: [tavily/web_search]  # hide only web_search from tavily
```

| Field | Mutually exclusive with | Behavior |
|---|---|---|
| `exclude_tools` | `tools` (when `tools` is `string[]`) | All tools except listed ones visible. Supports `ext/*` syntax. |
| `exclude_extensions` | `extensions` (when `extensions` is `string[]`) | All extensions except listed ones load. |

**Constraint:** You can use EITHER `tools` OR `exclude_tools`, not both. Same for `extensions`/`exclude_extensions`. If both are set, the whitelist (`tools`/`extensions`) wins.

**Note:** `exclude_tools: [tavily/*]` hides tavily's tools but the extension still loads (hooks fire). Use `exclude_extensions: [tavily]` to prevent the extension from loading entirely.

#### `extensions` field values

The `extensions` field controls which extensions load. It does NOT affect tool visibility.

| Value | Meaning | Example |
|---|---|---|
| `true` | Load all extensions (default) | `extensions: true` or omit the field |
| `false` | Load no extensions | `extensions: false` |
| `[tavily]` | Load only listed extensions | `extensions: [tavily, pi-tokf]` |
| `[tavily/web_search]` | Load extension (tool part ignored) | `extensions: [tavily/web_search]` loads all of tavily |

#### `skills` and `preload_skills` field values

Skills have two injection modes:

| Field | Value | Effect |
|---|---|---|
| `skills` | `true` | All skills available (metadata-only in system prompt) |
| `skills` | `false` | No skills |
| `skills` | `[debug, tdd]` | Only listed skills (metadata-only) |
| `preload_skills` | `[debug]` | Dump full SKILL.md content into system prompt |
| `preload_skills` | `false` | No preloading (default) |

Metadata-only means the agent sees skill name, description, and file path. It reads the full content on-demand via the `read` tool. Preloading injects the full content upfront — higher token cost but no read latency.

### Token-Saving Frontmatter Settings

Every tool schema and every skill snippet you inject costs tokens — in every turn. These frontmatter fields are your main levers:

| Setting | What it controls | Token impact |
|---|---|---|
| `tools: [a, b, c]` | Which tool schemas the LLM sees (built-in + extension tools) | High — each tool has a schema (name, params, description) injected every turn. Fewer tools = fewer tokens. |
| `tools: [ext-name/*]` | All tools from a specific extension | Medium — lazy shorthand for listing each tool individually. |
| `extensions: false` | Disables all extensions (no hooks, no commands) | Medium — extensions can register hooks that fire every turn. |
| `extensions: ["my-ext"]` | Load only specific extensions | Medium — pick only what the agent needs. |
| `skills: ["skill-a"]` | Whitelist skills — injects metadata only (name, description, location) | Low — agent reads full content on-demand via `read` tool. No prose in system prompt. |
| `skills: false` | Disables all skills | Zero skill tokens. |
| `preload_skills: ["skill-a"]` | Dump full SKILL.md content into system prompt | **Highest** — skill prompts are prose, not schemas. A verbose skill can be 10-50x the token cost of a tool schema. |
| `exclude_tools: [write]` | Disable specific tools (blacklist mode) | High — same as whitelist but without listing everything. |
| `exclude_extensions: [ext]` | Disable specific extensions (blacklist mode) | Medium — same as whitelist but without listing everything. |

**Practical examples:**

```yaml
# Read-only agent: whitelist approach
tools: [read, bash, grep]
extensions: false
skills: false

# Read-only agent: blacklist approach (same result, easier to maintain)
exclude_tools: [edit, write]

# Agent that uses all tools except write, and all extensions except quality-monitor
exclude_tools: [write]
exclude_extensions: [quality-monitor]
```

### Merge precedence

Project agents override user agents, which override built-ins (`general-purpose`, `Explore`). Agent types discovered from `.md` files automatically appear in the `agent` parameter's enum — no registration required. Files added during a session are discovered on the next call that references them.

## Model Resolution

The extension picks the right model automatically. Precedence (highest first):

1. **Session per-type override** — `/agents > Model settings`, lasts the session
2. **Session global default** — temporary
3. **Config per-type override** — `~/.pi/agent/subagents-lite.json`
4. **Config global default**
5. **Agent frontmatter** — `model` in `.md` file
6. **Parent model** — inherit from the calling agent

The LLM never passes `model` — it's injected at call time via the `tool_call` listener. Set it once in config or frontmatter and forget about it.

## Commands

### `/agents`

Management menu with four sections:

- **Model settings** — global default, per-type overrides, force background mode, cost display toggle
- **Concurrency** — default limit, per-provider and per-model slots
- **Running agents** — list, steer, stop, view snapshot, view result
- **Debug** — agent types, agent briefing (sends capabilities to the LLM)

## Interface

### Live Widget

Persistent bar above the editor showing running and completed agents. Updates live during execution.

- Running agents show a spinner, current tool activity, turn count, token usage (with optional context-fill percent), and elapsed time
- Completed agents show a check mark with final stats
- Click `tail -f` path to follow output logs in real time

Format (tree structure with branch connectors):
```
├─ ⠙ Explore  description  3🛠 ·5≤30⟳ ·12.0k(45%)·1h 2m 3s
│  └ thinking…
```

Turn format uses `≤` and `⟳` glyphs (`5≤30⟳` = 5 of 30 turns). Token count uses compact notation (`12.0k`) with optional context-fill percent in parentheses. No "tokens" label — the glyphs are self-explanatory.

### Result Viewer

Fullscreen markdown viewer for agent results. Opens automatically when viewing a completed agent's result from the `/agents` menu.

Key bindings: `↑↓` navigate · `PgUp/PgDn` · `g`/`G` top/bottom · `f` toggle fullscreen · `r` refresh · `q`/`Esc` close

Stats line: ` ↑12.0k · ↓8.0k · W3.0k · $0.024 · 15 turns · 47s`

When **Cost display** is enabled (ON), agent stats show dollar cost: `✓ Builder·2🛠 ·5⟳ ·12.3k·$0.008·10s`. The status bar shows total agent cost: `agents: $0.008` or `2 agents: $0.008`.

## Configuration

`~/.pi/agent/subagents-lite.json` — managed via `/agents` menu, or edit directly:

```json
{
  "agent": {
    "default": null,
    "forceBackground": false,
    "showCost": true,
    "Explore": "anthropic/claude-haiku-4-5-20251001"
  },
  "concurrency": {
    "default": 4,
    "providers": { "ollama": 2 },
    "models": {
      "anthropic/claude-sonnet-4-5-20250514": 3
    }
  }
}
```

> **Note:** `agent.default` (global fallback), `agent.forceBackground` (flag), `agent.showCost` (toggle cost display), and per-type overrides like `"Explore"` are peers in the same object. Agent type names become dynamic keys alongside the special fields.

## StopAgent Tool

Stop a running agent by ID. Returns a success message or an error if the agent isn't found.

| Parameter | Required | Description |
|---|---|---|
| `agent_id` | ✅ | The agent ID returned by the `Agent` tool when the agent was spawned |

Agent IDs can be discovered from:
- The `Agent` tool's result (shown on spawn)
- The `StopAgent` error message, which lists all running agent IDs
- The `/agents` menu's **Running agents** section

## Output Logs

`/tmp/pi-agent-outputs/<agentId>.log` — append-only, human-readable, `tail -f` friendly. Every line is prefixed with an ISO 8601 timestamp:

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
