# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks. Focused fork of pi-subagents with reduced surface area — no scheduling, no join modes. Worktree-scoped subagent spawning is supported via a single tool param.

## Language

**Subagent**:
An autonomous child agent spawned from the parent conversation via the Agent tool.
_Avoid_: Child agent, worker, task agent

**Agent type**:
A named configuration (general-purpose, Explore, or custom) that defines a subagent's
tool set, skills, system prompt, and default model.
_Avoid_: Agent kind, agent class

**Agent briefing**:
A user message sent via `/agents` that teaches the LLM about available agent types and
how to use the Agent tool. The LLM learns from conversation context, not from the tool schema.
_Avoid_: Agent documentation, tool description

**Model override**:
A user-configured model preference (per-type or global) that wins over any built-in
or frontmatter default. Set via `/agents` > Model settings, persisted in `~/.pi/agent/subagents-lite.json`.
_Avoid_: Model injection, model preference

**Stealth tool**:
A tool registered with `description: "."`, no `promptSnippet`, no `promptGuidelines`.
The LLM schema tells it nothing — usage is taught via agent briefing.
_Avoid_: Hidden tool, minimal tool

**Activity tracker**:
Per-agent transient display state (active tools, streaming response text) bridging spawn callbacks
and the TUI widget renderer. Owned by the spawn coordinator. Accumulated stats (turn count, tool
usage, token usage) live on the AgentRecord, not here.
_Avoid_: Agent monitor, agent stats

**Nudge**:
A completion notification delivered to the parent session after a background agent finishes.
Batched with a 200ms hold to coalesce rapid completions.
_Avoid_: Callback, notification

**Grace turns**:
Additional turns allowed after the soft turn limit steer message before hard abort. Default 6, configurable via `/agents` > Model settings.
_Avoid_: Grace period, extra turns

**Worktree**:
A linked git worktree of the same repository as the parent. Distinguished from the main checkout by the location of its `.git` reference: a worktree's `--git-dir` points back to `<main>/.git/worktrees/<name>` (outside the worktree root), while the main checkout's `--git-dir` is inside the repo path. Validated by `git-common-dir` match with the parent plus a `--git-dir`-not-inside-path check. The target of the `worktree_path` Agent tool param.
_Avoid_: Git worktree, sibling worktree (the "sibling" framing is approximate; the validator accepts any worktree of the same repo)

**Worktree path**:
The resolved absolute filesystem path passed to the `worktree_path` param, stored on `AgentInvocation.worktreePath` for UI display. Always the realpath, never the LLM's raw input string. The subagent's session, resource loader, and system prompt `Working directory` line all use this value.

**Worktree label**:
A short human-readable identifier for a worktree, stored on `AgentInvocation.worktreeLabel`. Computed as `basename(worktreeRoot)` when the requested path equals the worktree root, else `basename(worktreeRoot)/<relative subpath>`. Forward-slash normalized for cross-platform display.
_Avoid_: Worktree name (the label is a path-derived identifier, not a git branch name)

## Relationships

- An **Agent type** has an optional **Model override**
- A **Subagent** is spawned from one **Agent type**
- A **Subagent** may run in a **Worktree** of the parent's repo
- An **Agent briefing** describes all available **Agent types** to the LLM
- A **Stealth tool** requires an **Agent briefing** before the LLM can use it
- An **Activity tracker** is created per spawn and cleaned up on completion
- A **Nudge** is emitted when a background agent completes or errors
- **Grace turns** are added to the max turns limit to determine when a steered agent is hard-aborted
- A **Worktree path** is the absolute resolved path passed via `worktree_path`
- A **Worktree label** is derived from a **Worktree path** for compact display
- The `worktree_path` tool param is taught to the LLM via the **Agent briefing**

## Example dialogue

> **Dev:** "I want the Explore subagent to use a different model. Do I change the frontmatter?"
> **Domain expert:** "No — use `/agents` > Model settings to set a **Model override** for Explore. It wins over frontmatter."
> **Dev:** "And if I haven't briefed the LLM with `/agents`, can it still spawn subagents?"
> **Domain expert:** "The LLM can't meaningfully call the Agent tool without an **Agent briefing**. The **Stealth tool** schema tells it nothing."
> **Dev:** "How does the parent know when a background agent is done?"
> **Domain expert:** "A **Nudge** is auto-delivered — a `subagent-result` message injected into the parent session. No polling needed."

## Flagged ambiguities

- "model" was used to mean both the parent's LLM model and the subagent's model — resolved: the subagent's model specifically is a **Model override** when user-configured, or the agent type's default otherwise.
- "concurrency" could mean total agents or per-model slots — resolved: concurrency is per-model (`"provider/modelId"` key) with a `"default"` fallback.
