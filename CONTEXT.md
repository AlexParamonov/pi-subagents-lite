# pi-subagents-lite

A lightweight pi extension that lets the LLM spawn autonomous child agents for complex tasks. Focused fork of pi-subagents with reduced surface area — no scheduling, no worktrees, no join modes.

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
Per-agent state (turn count, tool usage, token usage, active tools) bridging spawn callbacks
and the TUI widget renderer. Lives in a module-level `Map<string, AgentActivity>`.
_Avoid_: Agent monitor, agent stats

**Nudge**:
A completion notification delivered to the parent session after a background agent finishes.
Batched with a 200ms hold to coalesce rapid completions.
_Avoid_: Callback, notification

## Relationships

- An **Agent type** has an optional **Model override**
- A **Subagent** is spawned from one **Agent type**
- An **Agent briefing** describes all available **Agent types** to the LLM
- A **Stealth tool** requires an **Agent briefing** before the LLM can use it
- An **Activity tracker** is created per spawn and cleaned up on completion
- A **Nudge** is emitted when a background agent completes or errors

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
