# pi-subagents-lite

[![npm version](https://img.shields.io/npm/v/pi-subagents-lite)](https://www.npmjs.com/package/pi-subagents-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Sub-agents for [pi](https://pi.dev). Schema-first, minimal token overhead.

Spawn custom agents in isolated sessions with their own tools, extensions, and model. Most tool descriptions stay minimal; the child-only `MessageAgent` description carries routing guidance when the tool is active. The tool names and parameter names, such as `run_in_background` and `worktree_path`, are part of the schema.

Foreground and background agents with detailed model configuration, concurrency, custom agent types, steering and continuation, cross-repo worktree support, configurable system prompt modes, a live widget and conversation viewer with cost tracking, and a watchdog for stuck agents.

## Install

Requires Node.js >= 22.19.0 and pi >= 0.99.0.

```bash
pi install npm:pi-subagents-lite
pi install -l npm:pi-subagents-lite   # project-local
pi -e npm:pi-subagents-lite           # try without installing
```

## Usage

The LLM calls `Agent` like any other tool. Foreground agents return inline with stats. Background agents return without waiting for completion and notify the parent when done.

```
◈ Agents
  ⠧ builder  Bump all gpu_inference_proxy deps to latest  6⟳ ·↑7k↓2k 2%·$0.00·54s
  │ MiMo V2.5 • high
  └ running command…
  ⠧ scout  Explore keepalive events config  25⟳ ·↑79k↓5k 8%·$0.01·2m 39s
  │ MiMo V2.5 • high
  └ Now I have enough information to provide a comprehensive answer.
```

The widget shows running and recently finished agents above the editor. `↓`/`↑` highlights an agent, `Enter` opens the conversation viewer, `Esc` closes navigation. The viewer streams the live transcript — thinking blocks, tool calls, and compaction summaries. Tool results are not shown: each call appears as a single status-colored line (pending → success/error).

The `/agents` menu covers active and settled agents (view, steer or continue, stop, clear), manual spawns without an LLM round-trip, model and concurrency settings, agent behavior, system prompts, widget settings, and diagnostics.

### Agent tools

- `Agent` spawns a sub-agent (see [Agent options](#agent-options) for parameters). If the child's active tools include `MessageAgent`, it is automatically backgrounded, even when `run_in_background` is explicitly `false`.
- `StopAgent` stops a running or queued agent by ID. IDs come from the spawn result, the stop error, or `/agents`.
- `MessageAgent` gives an existing agent more input by ID: a running one picks it up at its next turn boundary; a settled one continues with its own context if its session is live and a model concurrency slot is available. Subagents can also use it; omitting `agent_id` (or setting it to `null`) submits a message to their parent instead. The child receives an acknowledgement of submission, not confirmation of delivery.
- `AgentStatus` lists every running and queued agent, plus a configurable number of recently settled agents (default: twice the default concurrency). It tells the LLM not to poll for updates.

Subagents receive `MessageAgent` and `AgentStatus` when this extension is loaded in their sessions, subject to their tool settings. Their active `MessageAgent` tool description explains parent routing and message discipline. They can list and message other managed subagents, but cannot spawn or stop agents. Parent-directed messages are submitted as steering input to a busy parent or as a follow-up for an idle parent; the child acknowledgement does not guarantee delivery. In the UI, messages show a `Message from …` heading with the model, thinking level, runtime statistics, and saved task description. Completion notifications still go only to the parent. If `MessageAgent` is active, the child is automatically backgrounded so the parent can handle its messages while it works; this overrides `run_in_background: false`.

Other foreground agents keep the `Agent` tool call open until they finish and are stopped by the parent's interrupt. Background agents return without waiting for completion and do not inherit that interrupt, but can still be steered or stopped through the UI or tools.

### Steering and continuation

Steer a running agent mid-task to redirect it: `Enter` in the conversation viewer, `Steer` in the `/agents` menu, or `MessageAgent` from the session agent. Settled agents (completed, turn-limited, aborted, stopped, or errored) can be continued from the conversation viewer, the `/agents` menu, or `MessageAgent`.

### Permission gates and other Subagent-aware extensions

Lite announces each Subagent session on pi's extension event bus when it is created, when its extensions bind, and when it is disposed. A gate installed alongside lite, for example `@gotgenes/pi-permission-system`, uses those announcements to escalate an `ask` decision made inside a Subagent to the parent session instead of failing closed inside the child. With no such extension installed nothing is observable, on a pi without the event bus the announcements are skipped, and if pi refuses one, which happens when the parent session is replaced, reloaded or disposed while the Subagent is still running, lite warns and names that Subagent. An announcement never fails a spawn or a teardown.

## Built-in agents

These built-in agents provide a starting point, create custom agent files to define specialized setups.

- `general-purpose` does general task execution using the configured session tools.
- `Explore` is intended for read-only codebase exploration. Its prompt prohibits file changes, but it includes `bash` and is not sandboxed, so read-only behavior is not enforced. It loads extensions by default unless `loadExtensionsImplicitly` is off or its frontmatter filters them.

Built-ins can be overridden by custom agents or disabled from `/agents` > Settings > Agent behavior.

## Custom agents

Drop a `.md` file into `.pi/agents/` (project), `.agents/agents/` (shared), or `~/.pi/agent/agents/` (global). Frontmatter configures the agent, and the body is its system prompt. On name clash the config priority is: project > shared > global > built-in. Type names resolve by exact match first, then by a unique case-insensitive match; ambiguous case variants require the exact name.

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

A minimal agent with just `name` and `description` gets the same default tools, extensions, and skills as `general-purpose`. Its name appears in the `Agent` tool's `agent` parameter description. Set restrictions only when you want them.

### Frontmatter reference

| Field                   | Type                            | Default                                                     | Description                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | string                          | —                                                           | Agent type name. Must be unique; a file without it is skipped.                                                                                                                                                                                            |
| `display_name`          | string                          | `name`                                                      | Label in the UI.                                                                                                                                                                                                                                          |
| `color`                 | string                          | none                                                        | Agent color for icon tinting. Named colors: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. Palette aliases: `amber`, `teal`, `indigo`, `gold`, `violet`, `rose`, `lime`, `gray`, `slate`, `navy`, etc. Also accepts `#RRGGBB` hex. |
| `description`           | string                          | `""`                                                        | One-sentence description.                                                                                                                                                                                                                                 |
| `tools`                 | list or comma-separated string  | pi's `defaultTools`; none if implicit tools are off         | Tool allowlist, an empty list gives the agent no tools. Mutually exclusive with `exclude_tools`.                                                                                                                                                          |
| `exclude_tools`         | list or comma-separated string  | none                                                        | Tool blacklist. Mutually exclusive with `tools`.                                                                                                                                                                                                          |
| `extensions`            | `true` \| `string[]` \| `false` | `true`                                                      | Which extensions load, including their tools, hooks, and commands. The `tools` field separately controls tool access.                                                                                                                                     |
| `exclude_extensions`    | `string[]`                      | none                                                        | Extension blacklist.                                                                                                                                                                                                                                      |
| `skills`                | `true` \| `string[]` \| `false` | `true`                                                      | Skill whitelist (metadata-only in system prompt).                                                                                                                                                                                                         |
| `preload_skills`        | `string[]` \| `false`           | `false`                                                     | Dump full SKILL.md content into the system prompt. Expensive.                                                                                                                                                                                             |
| `model`                 | string                          | inherit parent                                              | `"provider/model-id"`. See [Model resolution](#model-resolution).                                                                                                                                                                                         |
| `thinking`              | string                          | see [Thinking level resolution](#thinking-level-resolution) | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `parent` to follow the parent session.                                                                                                                                                      |
| `max_turns`             | number                          | unlimited                                                   | Soft turn limit, then grace turns before hard abort.                                                                                                                                                                                                      |
| `max_tokens`            | number                          | unlimited                                                   | Max output tokens per LLM response.                                                                                                                                                                                                                       |
| `hidden`                | boolean                         | `false`                                                     | Hide from the `Agent` tool's agent-type list. Still callable by name.                                                                                                                                                                                     |
| `output_transcript`     | boolean                         | inherit global                                              | Write streaming transcript to `/tmp/pi-agent-outputs/<agentId>.log` (frontmatter overrides).                                                                                                                                                              |
| `include_context_files` | boolean                         | inherit global                                              | Include AGENTS.md files as `<project_context>` in the system prompt. `true` = load, `false` = none, unset = global "Include AGENTS.md" setting.                                                                                                           |
| `include_system_prompt` | boolean                         | inherit global                                              | Include the parent's system prompt for this agent. `true` = inherit parent, `false` = replace mode, unset = global mode. When the global mode is `custom`, the custom prompt wins over `true`.                                                            |

When frontmatter omits `tools` and the agent type carries no explicit registered-tools set, `loadToolsImplicitly` (config, default ON) decides: ON delegates tool setup to pi, so your `defaultTools` setting applies exactly as in a normal session, and tools left inactive stay registered for dispatcher tools to call by name. OFF starts such agents with no tools. Explicit frontmatter always wins.

`tools` and `exclude_tools` accept built-in names (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and extension tool names (`codemode`, `web_search`). Use `tavily/*` or `tavily/all` in either list to include or exclude all tools from that extension. Excluding tools doesn't prevent the extension from loading; use `exclude_extensions: [tavily]` to prevent loading.

`loadSkillsImplicitly`, `loadExtensionsImplicitly`, and `loadToolsImplicitly` (config, default ON) decide what an agent gets when frontmatter omits `skills`, `extensions`, or the tool fields. With implicit tools ON, pi's `defaultTools` setting applies; OFF starts agents with no tools. These toggles are independent: turn implicit extensions OFF separately to stop loading extensions, then opt in explicitly where needed.

Built-in extensions: child sessions load pi's built-in codemode, tool-search, and mcp extensions (llama.cpp excluded), addressed by bare name (`codemode`) from `defaultTools`, settings `extensions`, and frontmatter, exactly as in a normal session. A user extension registering the same tool, command, or flag replaces the built-in.

Codemode in Subagents needs two things: the codemode extension loaded, and the codemode tool activated. With default settings one line does both, in `.pi/settings.json`:

```json
{ "defaultTools": ["+codemode"] }
```

Every agent whose frontmatter omits `tools` then starts with codemode active, exactly like your main session. Agents with an explicit `tools` list ignore `defaultTools`: add `codemode` to that list to activate it. If `loadExtensionsImplicitly` is off, agents also need `extensions: codemode` in frontmatter to load the extension.

## Agent options

`Agent` accepts:

- `prompt` (required) is the task text.
- `description` is a short label for the widget, it defaults to the prompt's first line.
- `agent` is the agent type; defaults to `general-purpose`.
- `run_in_background` requests that the agent return without waiting for completion and notify the parent when done. If the child has `MessageAgent` active, it is backgrounded regardless of this parameter, including an explicit `false`.
- `worktree_path` is a directory inside any git repository on disk. Relative paths resolve against the parent's working directory. See [Worktree paths and trust](#worktree-paths-and-trust).

`model`, `thinking`, `max_turns`, and `max_tokens` are injected from config and frontmatter, never passed by the LLM. Set them once and forget.

Subagents cannot spawn further subagents.

### Worktree paths and trust

`worktree_path` accepts a path inside any git repository on disk: a linked worktree of the parent's repo, its main checkout, or a different repo entirely. Relative paths resolve against the parent's working directory. The subagent runs with that directory as its working directory.

Cross-repo targets are gated by pi's existing trust framework. The target's saved trust decision (nearest ancestor wins) applies, and an undecided target falls back to the global `defaultProjectTrust` setting. Anything other than "always" means untrusted. An untrusted target still spawns, but its project resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, its `.pi/agents` types are not discovered, the extension's project config (`.pi/subagents-lite.json`) is not loaded, and pi surfaces a warning. Same-repo paths are never gated. The `/agents` spawn wizard still lists same-repo worktrees only.

## Model resolution

Precedence, highest first:

1. Session per-type override (`/agents` > Model settings)
2. Session global default
3. Config per-type override (`~/.pi/agent/subagents-lite.json`)
4. Config global default
5. Agent frontmatter `model`
6. Parent model

## Thinking level resolution

Precedence, highest first:

1. Spawn choice (`/agents` spawn wizard)
2. Agent frontmatter `thinking`
3. pi's per-model level for the resolved model (`modelThinkingLevels`)
4. `Subagent default thinking` (`defaultThinking`, project over global)
5. pi's own default (`defaultThinkingLevel`, else `medium`)

Then clamped to the resolved model's supported levels; non-reasoning models support only `off`.

Agent frontmatter `thinking`, or `Subagent default thinking` can be set to `parent` to follow the parent session's current level. Resolution happens before the Subagent starts, so a run always reports a real level, and a `parent` with no parent to read counts as unset.

Model settings and the spawn wizard print the deciding source in brackets: `high (frontmatter)`, `medium (pi default)`, `minimal (parent)`. `pi default` means nothing is configured here, so pi's own setting decides; in the spawn wizard that choice sends no level at all.

## Concurrency

`concurrency` caps parallel agents. A per-model limit overrides a per-provider limit, which overrides the `default` per-model limit. Excess spawns queue until a slot frees.

## Settings

Global settings live in `~/.pi/agent/subagents-lite.json`, managed via `/agents` or edited directly.

`/agents` settings cover model overrides, concurrency, agent behavior (turn limits, background delivery, watchdogs, transcripts, and tool-schema options), system prompt mode, and widget layout and display.

```
Settings

→ Model overrides                Set global default and per-type model overrides
  Concurrency limits              Set default, per-provider, and per-model limits
  Agent behavior                  Configure limits, delivery, watchdog, and tools
  System prompt                   Configure prompt mode, context, skills, and extensions
  Widget                          Configure layout, display, and stats
```

Use `/agents` > Settings > Widget to configure layout, model/thinking labels, and displayed stats.

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

Output transcripts are disabled by default. Enable them globally via the `outputTranscript` config option or per-agent via the `output_transcript` frontmatter field. When enabled, the transcript streams to `/tmp/pi-agent-outputs/<agentId>.log` (append-only, `tail -f` friendly) and the widget shows a `tail -f` command for the file. The files persist across session reloads (`/reload`, extension reload), even though reload stops running agents.

## License

MIT
