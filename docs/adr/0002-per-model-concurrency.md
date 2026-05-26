# Per-model concurrency pools

The AgentManager uses per-model concurrency limits instead of a single global
`maxConcurrent` pool. Each `"provider/modelId"` key can have its own slot count,
with a `"default"` fallback. Configured via `/agents` > Concurrency settings,
persisted in `~/.pi/agent/subagents.json`.

## Why

Different local models consume different GPU memory. A 4B model may fit several
slots while a 27B model fits only one. Cloud APIs have their own rate limits.
A single global pool can't express these constraints.

When a spawn hits its per-model limit, the agent is queued with status `"queued"`
and starts automatically when a slot frees up.

## Trade-off

Per-model queues mean the agent manager checks the model of every spawn before
deciding whether to queue. This adds a lookup but the concurrency map is small.
The alternative — a global pool — is simpler but can't prevent GPU thrashing
when multiple large local models compete.
