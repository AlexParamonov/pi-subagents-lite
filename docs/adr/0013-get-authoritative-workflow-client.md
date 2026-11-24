# GET-authoritative client over the SSE stream

Workflow run state always comes from `GET /api/workflows/:id` (status, result,
error); SSE is a display-only push channel. The client reconciles
from GET after a silence window or any reconnect, never trusts SSE event ids,
and detects terminal state from the polled `status` field, never from stream
quiet.

## Why

Research at design time (tasks/research/sse-during-run.md) confirmed three
delivery defects in the SSE loop: a subscribe gap that can drop the terminal
event (client hangs until the 11-minute max-duration reconnect), a live
event-id counter that restarts at 1 after history replay (breaking
`Last-Event-Id` reconnection), and ephemeral progress chunks. The first two
were fixed server-side in `sse/loop.ex` (subscribe before replay with id-based
dedupe; counter advanced past replayed history) — apps/anagen_x is modifiable,
so compensating forever for owned bugs was worse than fixing them. The
GET-authoritative discipline stays anyway: connections still drop for reasons
no server fix covers, and reconciling from the durable event log is strictly
safer than trusting a push channel.

## Trade-off

Two paths (SSE consumer + poll reconcile) instead of one. In exchange,
terminal detection cannot hang, reconnect needs no id bookkeeping, and the
display can lose every SSE frame without lying about run state.

## Considered Options

- **Pure SSE (trust the stream)** — rejected: hangs up to the max-duration
  reconnect on a missed terminal event; even after the server fix, disconnects
  make silent gaps possible.
- **Poll-only (pi-channel's model)** — rejected: streamed text chunks
  (`node_progress`) are never persisted, so polling loses the streaming
  display entirely.
