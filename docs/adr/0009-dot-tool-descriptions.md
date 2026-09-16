# Dot tool descriptions

Supersedes [ADR 0001](0001-stealth-tool-registration.md), which already specified
`description: "."` — the code had drifted to description-less tools, hidden by
`@ts-expect-error` suppressions.

`Agent`, `StopAgent`, and `AgentStatus` are registered with `description: "."`.
The schema is otherwise unchanged: no `promptSnippet`, no `promptGuidelines`,
parameters without `.description()`, suppressions removed.

## Why

Strict OpenAI-tools gateways (e.g. opencode-go) reject description-less tools
with `400: tools[N]: function.description is required`, breaking every request
routed through them. A lone dot satisfies the contract and the gateways at one
token of prompt cost.

## Trade-off

The dot tells the model nothing. Usage is still inferred from the tool name, the
`/agents` briefing, and conversation context, as ADR 0001 assumed.
