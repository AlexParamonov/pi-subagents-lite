# Stealth tool registration

The Agent tool is registered at extension init time with a minimal schema: `description: "."`,
no `promptSnippet`, no `promptGuidelines`, parameters without `.description()`.
The model parameter is removed from the schema entirely — injected via the `tool_call` event listener.
The LLM learns about agent types and tool usage from a user message sent by `/agents` — not from the tool schema.

## Why

Registering the Agent tool at runtime (the `subagent-lazy` pattern) calls `registerTool()`
→ `refreshTools()` → `setActiveToolsByName()` → system prompt rebuild. llama.cpp renders
tool definitions into the prompt text via its Jinja2 chat template, so adding a tool changes
the token sequence and invalidates the KV cache prefix match.

Registering at init time freezes the tool set from turn 1. No mid-session tool changes,
no system prompt rebuilds, no cache invalidation.

Injecting the model via `tool_call` listener keeps the schema lean and lets the
`resolveModel()` precedence chain (session per-type → session default → config per-type → config default → frontmatter → parent)
run at call time with full context.

## Trade-off

The minimal schema (`description: "."`, no parameter descriptions) means the LLM must infer
usage from the tool name and parameter names alone. In practice this works — models use the
Agent and StopAgent tools without issues. The optional `/agents` briefing can supplement
understanding when the LLM needs to discover available agent types, but is not required for
basic tool invocation.

Registering at init time (rather than runtime) avoids system prompt rebuilds and KV-cache
invalidation on mid-session tool changes.
