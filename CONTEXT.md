# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks, and run remote workflows through the same selection, update, and result flow. Focused fork of pi-subagents with reduced surface area — no scheduling, no join modes.

## Language

### Core concepts

**Subagent**:
An autonomous child agent spawned from the parent conversation via the Agent tool.
_Avoid_: Child agent, worker, task agent

**Agent type**:
A named configuration (general-purpose, Explore, or custom) defining a subagent's tool set, skills, system prompt, and default model.
_Avoid_: Agent kind, agent class

**Agent briefing**:
A user message sent via `/agents` that teaches the LLM about available agent types and how to use the Agent tool. The LLM learns from conversation context, not from the tool schema.
_Avoid_: Agent documentation, tool description

**Stealth tool**:
A tool registered with a single-dot description but no promptSnippet or promptGuidelines. Usage is taught exclusively through the agent briefing.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Global config**:
The personal baseline config file `~/.pi/agent/subagents-lite.json`, holding the full config surface and the default write target for menu changes.
_Avoid_: User config, personal config

**Project config**:
The per-project override file `.pi/subagents-lite.json` in a trusted project. Holds only model and concurrency overrides: each key it sets wins over the Global config, and an absent key inherits from it. An empty file (`{}`) is inert.
_Avoid_: Project settings, local config

**Model override**:
A per-type or default model preference configured at session, project, or global scope via `/agents` > Model settings.
_Avoid_: Model injection, model preference

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Model settings.
_Avoid_: Grace period, extra turns

**Resolved model**:
The model an Agent type runs on: session per-type > session default > config per-type (project over global) > config default (project over global) > the frontmatter model > the parent session's current model.
_Avoid_: Effective model, assigned model

**Thinking level**:
Per-spawn reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), or `parent` to follow the parent session's current level. Any configurable position may hold `parent`; whichever one does decides. Resolved as the explicit spawn param > frontmatter `thinking` > pi's per-model level for the **Resolved model** (pi's `modelThinkingLevels` setting, keyed `provider/modelId`, project over global) > `defaultThinking` (project over global) > pi's own fallback (pi's `defaultThinkingLevel` setting, else `medium`), then clamped to the model's supported levels (non-reasoning models support only `off`). The pre-spawn menus print the winning source: `frontmatter`, `pi per-model`, `subagent default`, `parent`, `pi default`.
_Avoid_: Reasoning effort, thinking mode, inherit

**Implicit tool loading**:
What an Agent type gets when its frontmatter omits both `tools` and `registeredTools`: ON (default) passes no tool override and pi applies its `defaultTools` resolution natively; OFF passes `noTools: "all"` so the Subagent starts with none. Explicit frontmatter values always pass through unchanged. Third member of the implicit-loading family (skills, extensions, tools).
_Avoid_: Default tools inheritance, tool fallback

**Built-in extension**:
An extension bundled with the pi CLI itself (codemode, tool-search, mcp; llama.cpp excluded) that a Subagent session loads via pi's public SDK creators wrapped with pi's own names and `builtin`/`replaceable` flags, so settings-level extension selection applies inside the child loader unchanged. Selectable and deselectable by bare name in Agent type frontmatter `extensions`.
_Avoid_: Core extension, internal extension, bundled tool

**Compact tool calls**:
Global **ConversationViewer overlay** preference (default on: an absent key means on, only an explicit `false` gives the ordinary viewer) that replaces each **Call run** with one count-and-names row on the pending background, paints every other eligible tool call as a single status-colored row with no fill bar, shows no tool result body for any call, keeps every **Ungrouped tools** name in its normal call block minus that result body, and omits hidden thinking completely. Each summary and each displayed call row carries the **ConversationViewer overlay**'s usual blank spacing row. Read when the viewer opens, from both entry points; pi's tool-output flag still selects summaries (collapsed) or individual calls (expanded). Its setting row also gates the **Ungrouped tools** row, which is listed only while it is on.
_Avoid_: Compact mode (that is the widget's own state), condensed view

**Ungrouped tools**:
Global comma-editable list of tool names the **Compact tool calls** presentation keeps whole, in their normal call block minus its result body, ending the **Call run** around them. An absent key means `write`, `edit`, `replace`, `bash`, `codemode`, `Agent`, `StopAgent`, `MessageAgent`; an empty list groups every call, `AgentStatus` included. Names match exactly and case-sensitively, custom and MCP names included. Its settings row appears only while **Compact tool calls** is on.
_Avoid_: Excluded tools, tool categories, grouping allowlist

### Workflows

**Workflow**:
A graph pipeline executed remotely by a workflow API, triggered through the `Workflow` tool. Never a Pi session; tracked alongside Subagents in the agent record store, kind-tagged.
_Avoid_: Pipeline, flow job, remote agent

**Workflow file**:
A `.yaml` file in graph's own workflow schema (`name`, `description`, `nodes`, `edges`, `entry_node`), discovered in `~/.pi/agent/workflows/`, `<project>/.agents/workflows/`, and `<project>/.pi/workflows/` with the same trust gating as agent files. Same-name collisions resolve by whole-file replacement, project > shared > global.
_Avoid_: Workflow definition, workflow agent

**Workflow endpoint**:
A named `url` + `apiKey` pair under `workflows.endpoints` in the Global config, chosen per run by a Workflow file's `endpoint` key, else `workflows.defaultEndpoint`. A Project config may override a URL but never a key.
_Avoid_: Graph connection, provider config

**Push-per-run**:
The delivery model where every Workflow run sends its full parsed Workflow file as the create request's `workflow_config`; the server holds no workflow registry and the local folders are the single source of truth.
_Avoid_: Workflow registration, deployment

**Poll-reconcile**:
The client discipline for Workflow runs: `GET /api/workflows/:id` is the authority for run state; SSE is a display-only push channel, reconciled after a silence window or any reconnect, and SSE event ids are never trusted.
_Avoid_: SSE-driven state, stream trust

### Worktrees

**Worktree**:
A linked git worktree of the same repository as the parent, distinguished by its `--git-dir` pointing outside the worktree root. One possible target of the `worktree_path` Agent tool param (any git repo on disk is accepted).
_Avoid_: Git worktree, sibling worktree

**Worktree path**:
The absolute resolved `worktree_path` param; must be inside any git repo on disk. Sets the subagent session, resource-loader and system-prompt working directory. The Agent briefing teaches this parameter.
**Worktree label**:
A short human-readable identifier derived from the worktree path. `basename(root)` when targeting the root, else `basename(root)/<relative subpath>`.
_Avoid_: Worktree name

### Runtime

**Activity tracker**:
Per-agent transient display state (active tools, streaming response text) bridging spawn callbacks and the TUI widget renderer; cleared on completion. Accumulated stats live on the AgentRecord.
_Avoid_: Agent monitor, agent stats

**Nudge**:
A completion notification delivered to the parent session for a settlement that has no tool call left to answer in: the first settlement of a run launched in the background, the settlement of a **Workflow** run whose call handed the run back for any reason (its reads exhausted, a stop the endpoint refused or left unanswered, an `Esc` whose stop the endpoint did not confirm), and every settlement of a continued agent. What decides it is that the call stopped waiting, not how the run was launched: a run whose own call still waits answers inside that call and delivers no nudge, and a closed session delivers nothing into its replacement. A 200ms hold coalesces rapid completions. The batch starts a turn if the parent is idle; if busy, Pi commits it at a turn boundary and takes another turn. An interrupted parent keeps the results without restarting that turn.
_Avoid_: Callback, notification

**Parent interrupt binding**:
The binding of a foreground Subagent to its parent run's interrupt signal, established at spawn. When the signal aborts (Esc during streaming or tool execution, a stop command, or session shutdown), a running Subagent stops as Stopped (stoppedBy "user", partial output preserved) and a queued Subagent is cancelled before starting. The binding is detached when the Subagent settles, stops, or is removed, so a later interrupt never touches settled work. Background Subagents are never bound.
_Avoid_: Parent abort signal, interrupt listener, parent signal binding

**Settled**:
An agent that is no longer in progress, in one of the terminal statuses: completed, turn_limited, aborted, stopped, error. The AgentStatus tool always lists in-progress (running, queued) agents and shows settled agents most-recently-settled first, capped at the configured `agentStatusLimit` (0 = auto: 2 × default concurrency).
_Avoid_: Done agent, finished agent, terminal agent

**Agent id**:
The 17-character key of an agent record. All tool and widget text shows the first 8 characters; tool input accepts that shown form when it matches exactly one retained agent, and an ambiguous prefix resolves to nothing. The ambiguity error is the only place a full id is printed (ADR-0010).
_Avoid_: Short id (as a second kind of id), agent key

**MessageAgent**:
The main session agent's tool for sending input to a **Subagent** it already spawned: a running agent receives it at its next turn boundary, a **Settled** agent with a live session restarts. Same seam as the **ConversationViewer overlay**'s steer/continue. Runs parent-ward; the opposite direction is a **Nudge**.
_Avoid_: SteerAgent, agent messaging tool, follow-up

**Watchdog**:
Time-based stuck-agent detection that stops a running agent when a single tool call exceeds the tool timeout, or when the agent produces no activity (tool events or streamed response text) for longer than the idle timeout. Both thresholds are configurable in minutes; a watchdog stop is recorded with a reason distinct from a user stop.
_Avoid_: Timeout killer, stuck-agent detector

### Navigation

**Navigation mode**:
Keyboard-driven browsing of agents in the widget (`↑↓` move, `Enter` view, `Esc` back).
State lives on AgentWidget. Key handler in events.ts delegates via public API.
_Avoid_: Nav menu, agent selector

**Roster**:
Ordered list of navigable entries during navigation mode: `main` (virtual) + agents
in widget render order (finished → running → queued, newest-first within each).
_Avoid_: Agent list, nav list

**Freeze window**:
The 2-second period after the last `↑`/`↓` nav move during which the roster keeps its order — a completing agent flips to its live ✓ state in place instead of re-sorting. Membership and row content are never frozen; only ordering is.
_Avoid_: Debounce period, nav lock

**Re-rank**:
Rebuilding the roster into live display order (finished → running → queued) once the freeze window elapses; repeats on every render tick while the user stays idle. The highlight follows its agent by id across a re-rank.
_Avoid_: Re-sort, refresh

**ConversationViewer overlay**:
Live, scrollable view of an agent's conversation, streamed from session events. Opened from the widget or the running-agents menu, always as an overlay twice pi's default overlay width and never wider than the terminal; owns input while open (`Enter` steers, `s` stops). Its footer names the toggles it owns in short key notation (`C-t thinking`, `C-o tools`): a hint shows the key the user has actually bound to that action, several keys joined, and nothing at all when the action is unbound.
_Avoid_: ResultViewer, snapshot viewer

**Call run**:
Two or more consecutive eligible tool calls in the **ConversationViewer overlay**'s display order, counted across turns. Visible text, revealed thinking, or an **Ungrouped tools** name ends it; tool-result messages and rows that paint nothing do not, and a run of one is not a run. Under **Compact tool calls** a run shows as one summary row on the pending background, written `N tools (name, name, …)` with its call count and its unique names in first-seen order, with no timing.
_Avoid_: Tool group, tool batch, call cluster, merged calls, assistant turn

**Call row**:
One tool call on one row of the **ConversationViewer overlay**, in either presentation and either expansion state, written the way pi writes that tool: `$ <command>` / `PS> <command>` with a `timeout` argument kept as the ` (timeout Ns)` suffix, `read <path>` with the line range its `offset`/`limit` give, `write <path>` and `edit <path>` with their content-line and edit counts (pi shows the written content and the diff themselves, which takes more than one row), `grep /<pattern>/ in <path>`, `find <pattern> in <path>`, `ls <path>`, and for a tool pi has no renderer for, its own name followed by muted `key=value` argument pairs, with no parentheses, brackets or JSON wrapper. A path under the home directory shows as `~`. pi's own forms are never cut, so a long command or path wraps onto more rows; only the generic argument text carries pi's 100-character collapsed preview, whole once expanded. pi's compact `read` classifications (`read docs`, `read skill`, `read resource`) and its key hints stay out of the row. pi keeps its formatters in internal modules the package entry point does not publish, so the viewer mirrors the form; the `name(args)` summary of **summarizeToolArgs** stays the form of transcript logs.
_Avoid_: Tool line, call summary, bash prefix, truncated row
