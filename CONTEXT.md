# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks. Focused fork of pi-subagents with reduced surface area — no scheduling, no join modes.

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
A tool registered with minimal schema (description ".", no promptSnippet, no promptGuidelines). Usage is taught exclusively through the agent briefing.
_Avoid_: Hidden tool, minimal tool

### Configuration

**Model override**:
A user-configured model preference (per-type or global) that takes precedence over any built-in or frontmatter default. Set via `/agents` > Model settings.
_Avoid_: Model injection, model preference

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Model settings.
_Avoid_: Grace period, extra turns

### Worktrees

**Worktree**:
A linked git worktree of the same repository as the parent, distinguished by its `--git-dir` pointing outside the worktree root. One possible target of the `worktree_path` Agent tool param (any git repo on disk is accepted).
_Avoid_: Git worktree, sibling worktree

**Worktree path**:
The resolved absolute filesystem path passed to the `worktree_path` param. Must be inside a git repository (any repo on disk, not only the parent's). Used as the subagent's working directory for its session, resource loader, and system prompt.
**Worktree label**:
A short human-readable identifier derived from the worktree path. `basename(root)` when targeting the root, else `basename(root)/<relative subpath>`.
_Avoid_: Worktree name

### Runtime

**Activity tracker**:
Per-agent transient display state (active tools, streaming response text) bridging spawn callbacks and the TUI widget renderer. Accumulated stats live on the AgentRecord, not here.
_Avoid_: Agent monitor, agent stats

**Nudge**:
A completion notification delivered to the parent session after a background agent finishes. Batched with a 200ms hold to coalesce rapid completions.
_Avoid_: Callback, notification

**Watchdog**:
Time-based stuck-agent detection that stops a running agent when a single tool call exceeds the tool timeout, or when the agent produces no activity (tool events or streamed response text) for longer than the idle timeout. Both thresholds are configurable in minutes; a watchdog stop is recorded with a reason distinct from a user stop.
_Avoid_: Timeout killer, stuck-agent detector

## Relationships

- An **Agent type** has an optional **Model override**
- A **Subagent** is spawned from one **Agent type**
- A **Subagent** may run in a **Worktree** of the parent's repo or in a directory inside any other git repo on disk
- An **Agent briefing** describes all available **Agent types** to the LLM
- A **Stealth tool** requires an **Agent briefing** before the LLM can use it
- An **Activity tracker** is created per spawn and cleaned up on completion
- A **Nudge** is emitted when a background agent completes or errors
- **Grace turns** are added to the max turns limit to determine when a steered agent is hard-aborted
- A **Watchdog** stops a **Subagent** when a tool call or inactivity exceeds its configured thresholds
- A **Watchdog** stop records a reason distinct from a user stop
- A **Worktree path** is the absolute resolved path passed via `worktree_path`
- A **Worktree label** is derived from a **Worktree path** for compact display
- The `worktree_path` tool param is taught to the LLM via the **Agent briefing**

### Navigation

**Navigation mode**:
Keyboard-driven browsing of agents in the widget (`↑↓` move, `Enter` view, `Esc` back).
State lives on AgentWidget. Key handler in events.ts delegates via public API.
_Avoid_: Nav menu, agent selector

**Roster**:
Ordered list of navigable entries during navigation mode: `main` (virtual) + agents
in widget render order (finished → running → queued, newest-first within each).
_Avoid_: Agent list, nav list

**ResultViewer overlay**:
Read-only markdown viewer showing an agent's conversation snapshot via `buildSnapshotMarkdown`.
Opened on `Enter` in navigation mode. Overlay owns input while open.
_Avoid_: Agent viewer, conversation viewer
