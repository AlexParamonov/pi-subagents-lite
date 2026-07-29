# Stealth tool registration

The Agent tool is registered once at extension init with a minimal, byte-stable schema: no description, no prompt snippets or guidelines, and parameters without descriptions. Its required `agent` field is always a bare `Type.String()`; it never has a config- or registry-driven enum. Model and thinking are intentionally absent from the LLM-visible schema and remain controlled through `/agents`, Agent Markdown, and settings.

## Why

Calling `registerTool()` at runtime rebuilds tools and can invalidate the system-prompt/KV-cache prefix. A fixed schema prevents mid-session tool registration and cache churn.

When enabled, the parent-only orchestration block is the sole automatic catalog of visible agents. It is regenerated from the trusted live registry before each parent turn, independently of the tool schema. Disabling that block deliberately provides no automatic catalog; `/agents` remains available for manual use. Model and thinking use the shared precedence: manual spawn > session-agent > persistent agent > agent Markdown > global > parent.

## Trade-off

The schema is intentionally terse, so the model learns parameter usage from names and tool results. This keeps recurring tokens minimal and leaves dynamic discovery out of the schema.
