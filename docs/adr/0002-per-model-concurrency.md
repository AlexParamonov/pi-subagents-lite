# Per-model concurrency pools

The AgentManager uses per-model concurrency limits instead of a single global
`maxConcurrent` pool. Limits follow a precedence chain:

1. **Per-model**: `"provider/modelId"` key gets its own slot count
2. **Per-provider**: `"provider"` key applies to all models from that provider
3. **Default**: fallback for any model not covered above

Configured via `/agents` > Settings > Advanced > Concurrency limits, persisted in
`~/.pi/agent/subagents-lite.json`.

## Why

Different local models consume different GPU memory. A 4B model may fit several
slots while a 27B model fits only one. Cloud APIs have their own rate limits.
A single global pool can't express these constraints.

Per-provider limits let you set a blanket limit for all models from a provider
(e.g. `llamacpp: 2`) without configuring each model individually.

When a spawn hits its limit, the agent is queued with status `"queued"`
and starts automatically when a slot frees up.

## Trade-off

Per-model queues mean the agent manager checks the model of every spawn before
deciding whether to queue. This adds a lookup but the concurrency map is small.
The alternative — a global pool — is simpler but can't prevent GPU thrashing
when multiple large local models compete.
