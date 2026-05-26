# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Sub-agents for [pi](https://pi.dev) — schema-first, zero-fluff.**

Spawn specialized agents with isolated sessions, custom tools, and per-type models — all at minimal token cost.

## Schema-First Design

Every tool the LLM sees costs tokens — in the system prompt, and in every turn's context. Most extensions add description text, prompt snippets, and usage guidelines that compound across the session. This extension takes a **schema-first** approach: the tool name and parameter names **are** the schema. No bloated descriptions, no prose.

| Standard | Schema-first |
|---|---|
| `description: "Spawn a sub-agent"` | `description: "."` |
| `promptSnippet` with usage examples | _(none)_ |
| `promptGuidelines` with rules | _(none)_ |
| Parameters with `.description()` | Bare `Type.String()` |

Tool names like `Agent` and `StopAgent`, and parameter names like `prompt`, `description`, `run_in_background` are self-documenting. The LLM infers usage from the schema — no verbose descriptions needed. Tool results reinforce correct usage with clear success/error messages.

**Result:** foreground and background agents, custom agent types, per-model concurrency, cost tracking, steering, resume, model overrides — all with minimal token overhead.

## Features

- **Two tools** — `Agent` (spawn) and `StopAgent` (kill)
- **Foreground & background** — block or fire-and-forget with auto-delivered results
- **Custom agent types** — define via `.md` files with YAML frontmatter (tools, model, thinking, turn limits)
- **Smart model resolution** — 6-level precedence: session → config → frontmatter → parent. Set once, forget
- **Concurrency control** — per-model and per-provider slot limits with automatic queuing
- **Cost tracking** — input/output/cache tokens and dollar cost per agent
- **Live widget** — persistent status bar above the editor showing running/completed agents
- **Result viewer** — fullscreen markdown viewer with stats
- **Steer & resume** — inject mid-execution guidance or continue a previous conversation
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
| `agent` | | Type name — `general-purpose`, `Explore`, or any custom type you define (see [Custom Agent Types](#custom-agent-types)). The available values are **auto-populated** from `.md` files in your agent directories — drop a file, it appears in the enum. Set `enabled: false` in frontmatter to remove a type from this list. |
| `run_in_background` | | Fire-and-forget; result delivered automatically when done |
| `resume` | | Agent ID to continue a previous conversation |

> `model`, `max_turns`, `isolated`, and `thinking` are **not visible to the LLM** through tool introspection — the extension injects them at call time from agent config and frontmatter. `model` is resolved via the [Model Resolution](#model-resolution) chain; `max_turns`/`isolated`/`thinking` come from the agent's config. See [Custom Agent Types](#custom-agent-types) to set them.

## Custom Agent Types

Drop a `.md` file into `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). The frontmatter configures the agent; the body is its system prompt.

The file's `name` frontmatter field (or the filename without extension) becomes the agent type name and **automatically populates the `agent` parameter's enum** in the tool schema. No registration step needed — the extension scans these directories at session start and makes every discovered agent available to the LLM.

Built-in types (`general-purpose`, `Explore`) are always present. User agents override built-ins with the same name; project agents override user agents (see [Merge precedence](#merge-precedence)).

```markdown
---
name: security-review
display_name: Security Review
description: Review code for security issues
tools: [read, bash, grep, find, ls]
extensions: false
skills: false
model: anthropic/claude-sonnet-4-5-20250514
thinking: high
max_turns: 10
---

You are a security review specialist. Analyze code for vulnerabilities,
focusing on injection flaws, auth bypasses, and insecure defaults.
```

**Frontmatter quick reference:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Agent type name. Used as the enum value in the `agent` parameter (defaults to filename). |
| `display_name` | string | Human-readable label shown in the UI. |
| `description` | string | Short description — displayed in the `/agents` type list and tool rendering. |
| `tools` | string[] | Built-in tool allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. If omitted, inherits all. |
| `disallowed_tools` | string[] | Tool denylist — removes these from the agent's toolset even if allowlisted by `tools` or extensions. |
| `extensions` | bool \| string[] | `false` = no extension tools; `true` = inherit all; `["ext-a"]` = allowlist. |
| `skills` | bool \| string[] | `false` = no skill prompts; `true` = inherit all; `["skill-a"]` = only these. |
| `model` | string | Default model as `"provider/model-id"`. Override via `/agents` or `subagents-lite.json`. |
| `thinking` | string | Default thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `max_turns` | number | Turn limit (soft stop with steer). |
| `enabled` | bool | `false` removes the agent type from the tool schema's enum (LLM can't see or invoke it). Running agents unaffected. Default: `true`. |
| `isolated` | bool | Shorthand for `extensions: false` + `skills: false`. Reduces token footprint per turn. |

### Token-Saving Frontmatter Settings

Every tool schema and every skill snippet you inject costs tokens — in every turn. These frontmatter fields are your main levers:

| Setting | What it controls | Token impact |
|---|---|---|
| `tools: [a, b, c]` | Which built-in tools the LLM sees | High — each tool has a schema (name, params, description) injected every turn. Fewer tools = fewer tokens. |
| `extensions: false` | Disables all extension-provided tools | Medium — extensions can register many tools (linters, browsers, etc.). Each adds schema tokens. |
| `extensions: ["my-ext"]` | Allowlist only specific extensions | Medium — pick only what the agent needs. |
| `skills: false` | Prevents skill content from being injected into the system prompt | **Highest** — skill prompts are prose, not schemas. A verbose skill can be 10-50x the token cost of a tool schema. |
| `skills: ["skill-a"]` | Inject only listed skills (preloaded inline) | Medium — you control exactly which skills appear. |
| `isolated: true` | Shorthand for `extensions: false` + `skills: false` | High — zero extension tools, zero skill prompts. Useful for fast, focused agents. |

**Practical example:** An `Explore` agent that only reads files doesn't need write tools, browser extensions, or git skills. Setting `tools: [read, bash, grep, find, ls]` + `extensions: false` + `skills: false` saves thousands of tokens per turn compared to inheriting everything.

### Merge precedence

Project agents override user agents, which override built-ins (`general-purpose`, `Explore`). Agent types discovered from `.md` files automatically appear in the `agent` parameter's dropdown — no registration required.

## Model Resolution

The extension picks the right model automatically. Precedence (highest first):

1. **Session per-type override** — `/agents > Model settings`, lasts the session
2. **Session global default** — temporary
3. **Config per-type override** — `~/.pi/agent/subagents-lite.json`
4. **Config global default**
5. **Agent frontmatter** — `model` in `.md` file
6. **Parent model** — inherit from the calling agent

The LLM never passes `model` — it's injected at call time. Set it once in config or frontmatter and forget about it.

## Commands

### `/agents`

Management menu with four sections:

- **Model settings** — global default, per-type overrides, force background mode
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

## Configuration

`~/.pi/agent/subagents-lite.json` — managed via `/agents` menu, or edit directly:

```json
{
  "agent": {
    "default": null,
    "forceBackground": false,
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

> **Note:** `agent.default` (global fallback), `agent.forceBackground` (flag), and per-type overrides like `"Explore"` are peers in the same object. Agent type names become dynamic keys alongside the special fields.

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
