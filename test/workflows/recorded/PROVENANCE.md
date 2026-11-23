# Recorded workflow-endpoint bytes

Two kinds of file live here, and a passing test means something different depending on which one it
replayed:

- **Captured bytes**: a byte-for-byte response the anagen-x workflow API wrote. Replaying one shows
  what the client does with what that server really sends.
- **Contract-derived payload**: captured framing and key set around a `result` value the ratified
  declared-output contract requires and no runnable server produces yet. Replaying one shows the
  client handles that shape; it is not evidence that any server delivered it.

Only `read-completed-declared.body` and the `workflow_engine_finished` payload inside
`replay-declared.sse` are contract-derived. Every other `.sse` and `.body` byte here came off a
socket. Where a capture was impossible, the row below says so and names the source the value came
from.

## Capture provenance

- Producer: anagen-x at `fbd34207` (`main`, which contains `5dff0214`).
- Captured 2026-11-18, committed here as `6b2742a`. This revision is fixture provenance only: it is
  not a supported-revision floor, and nothing in this feature records or gates on a server revision
  (`tasks/workflows/waves/1-foreground-run/arch-resolution.md`).
- HTTP: the real `AnagenX.Web.WorkflowApi.Router` on a real Cowboy socket, Bearer key
  configured, journals seeded through the producer's own path
  (`Graph.Core.WorkflowEvent` factories → `Graph.Persistence.WorkflowLog.append`), read with a
  real HTTP client. `responses.json` holds each capture's status code.
- SSE: the same router's `/stream` route for the replay captures, and
  `AnagenX.Web.WorkflowApi.SSE.Loop` driven with the project's own writer for the ephemeral,
  progress and control frames. The replay captures taken through the socket and through the
  loop agree byte for byte, so chunked transport adds nothing to the frame bytes.
- `node-progress-frames.sse` was re-recorded later on 2026-11-18, committed here as `f9279a7`, from
  a booted anagen-x dev node (no Bearer key configured, the workflow API on port 4001). Both dates
  and that order are this repository's git history: the note that once dated one capture
  2026-11-19 was wrong. No anagen-x revision is recorded or gated for this capture either
  (`tasks/workflows/waves/1-foreground-run/arch-resolution.md`). The other files are still the
  capture above.

| File | Where the bytes come from |
| --- | --- |
| `live-stream.sse` | one live connection: multi-line `data:` chunk, multi-line `thinking_delta`, live `node_dispatched`/`node_complete`/`workflow_engine_finished` |
| `control-frames.sse` | `Keepalive.format(:ping)` and the max-duration `reconnect` event the loop writes |
| `node-progress-frames.sse` | one live connection, each step broadcast through `AgentLoop.Boundary.ProgressBroadcaster.broadcast_progress/3` over real `%AgentLoop.Core.NodeProgressEvent{}` values, then closed by a `workflow_engine_finished` frame the recorder broadcast. Its limits are below. |
| `replay-completed.sse`, `replay-failed.sse` | journal replay through the router, of a completed and a failed run |
| `replay-declared.sse` | journal replay through the router of a journal seeded with the contract-derived declared-output terminal payload |
| `read-*.body` except `read-completed-declared.body` | `GET /api/workflows/:id` for each run state, and the `401` answer to a wrong Bearer key |
| `read-completed-declared.body` | contract-derived, not captured: see "Contract-derived payload" |
| `stop-*.body` | `POST /api/workflows/:id/stop`, including the `404` `{"error":"Workflow not found"}` the API gives for an unknown id on any route |
| `create-*.body` | `POST /api/workflows` validation rejections |

## What the capture proves, and what it does not

- A live lifecycle frame carries `event` and `ts` **inside** its `data:` JSON (it is the
  broadcast payload), while a replayed lifecycle frame does not (`WorkflowLog.read/2` splits
  them out). The same event therefore arrives in two shapes on one client, and both are in
  this corpus.
- `id:` is on every durable frame, live and replayed. Chunks, thinking deltas and
  `node_progress` carry none: they are ephemeral, never journaled, never replayed, and a
  progress frame takes no lifecycle id, so the live id counter is untouched by it.
- A `node_progress` frame's `data:` carries exactly `node_id`, `step` (the producer's step atom
  as a string), `detail` (omitted when the producer sent none) and `ts` (the event's own
  timestamp). `workflow_id`, `task_id`, `strategy` and `correlation_id` are not on this surface:
  the stream is already scoped to one workflow. Which JSON keys sit in `detail` is the producer's
  per-step choice (`SessionExecutor`), and the server canonicalizes that value for encoding only
  (`Graph.Core.WorkflowEvent.serialize_value/1`) — it never reshapes it.
- JSON object key order is the encoder's, so a re-recording is field-stable, not byte-stable.
- The `steering_intervention` frame here is `SessionExecutor`'s turn-steering step, whose `detail`
  is the rule that fired (`reason: repeated_tool_call`). The cap state `cap_reached` is only ever
  *suppressed* — it goes to telemetry and never reaches a progress frame, so it is not a value
  this surface produces.
- The **order** of the frames in `node-progress-frames.sse` is the recorder's, not a run's. The
  recorder drove `broadcast_progress/3` once per step in the order it chose, which is why both
  `llm_response` shapes sit after that turn's `tool_result` and `steering_intervention` — a
  sequence no single model turn produces. Each frame is real producer output for its own step; the
  sequence is not a run transcript, and it says nothing about the order a producer emits steps in.
- `node-progress-frames.sse` also proves less than a run would: the run id was registered by hand
  with `AnagenX.TaskManager.create_task/4`, no journal line existed, no graph executed, and the
  closing terminal frame was broadcast by the recorder. So these bytes show what the server's own
  writer puts on a live connection for each progress step; they do not show that a real run delivers
  progress frames. The connection carried no Bearer key, so they say nothing about the authenticated
  path either.
- The producer path behind that capture is a branch, not `main`: the fix that lets a progress frame
  be encoded at all is `db87e5d8`, on anagen-x `feature/workflows-server`, unmerged. A `main`
  deployment still fails on that frame, which is what
  `tasks/workflows/waves/1-foreground-run/4-server-progress-stream/issue.md` tracks.
- `workflow_failed` carries `reason`, not `error`; `node_failed` carries both.
- The failure reason crosses lines: it is embedded as JSON escapes on named frames, while raw
  text frames are framed one `data:` line per payload line (`data:` with no trailing space for
  an empty line).
- A live kill (`stopped`) could not be captured: it needs a running graph. The stop ack shape
  `{"status": ..., "workflow_id": ...}` is source-verified from
  `AnagenX.Web.WorkflowApi.WorkflowController.stop/2`.
- A successful `201` create body could not be captured without dispatching a real workflow.
  `{"workflow_id": ..., "task_id": ...}` is source-verified from
  `AnagenX.Web.WorkflowApi.WorkflowController.create/2`.
- CRLF is **not** producer output: `SSE.Format.format_chunk/1` normalizes CR and CRLF to LF.
  The suite still feeds CRLF-framed frames, as intermediary-framing robustness, not as
  evidence of what this server sends.

## Contract-derived payload

`read-completed-declared.body`, and the terminal payload seeded into `replay-declared.sse`, carry the
ratified declared-output contract (anagen-x `tasks/workflow-terminal-result/spec.md` @ `63492f50`) in
their `result` slot: the declared output node's stored output as string-keyed JSON. Their key set and
framing are the captured ones (`read-completed-marker.body`, `replay-completed.sse`), so the invented
part is the `result` value and nothing else. No server this slice ran answers them: `main` answers a
completed run with the retired marker, which is what `read-completed-marker.body` shows. The
server-side change is `53c3ac7f`, on anagen-x `feature/workflows-server`, unmerged to `main` and not
deployed here, so no captured body for it was available to this slice.

What that means for a green test: a declared-output pass shows the client carries the ratified shape
through to the caller unchanged. It shows nothing about a server delivering it, and nothing about the
terminal-result pre-check firing against a real endpoint. The live gate in `wave.md` owns that
question.

A capture from a node booted off `feature/workflows-server` would replace both files with captured
bytes; this slice took none, so they stay placeholders carrying the labels above. Meanwhile
`../fixtures.ts` pins which `RECORDED` values come only from these files, so the first real capture
of a declared output fails that pin instead of letting the labels go stale.

## Superseded note

`tasks/workflows/waves/1-foreground-run/arch-resolution.md` calls `node-progress-frames.sse` a
placeholder "constructed with lifecycle framing". That describes the bytes this file had before
`f9279a7`: every progress frame carried an `id:` and a `data:` with `strategy`, `task_id`,
`workflow_id` and `correlation_id`, and the steering step carried `cap_reached`. The current file has
no ids on progress frames and none of those keys. The ruling's rule, that event ids are display
metadata and never classify provenance or durability, still stands and still governs the client.

## Re-recording

Seed journals with `Graph.Core.WorkflowEvent` factories through
`Graph.Persistence.WorkflowLog.append/3` under a temporary `:graph, :workflow_log_base`, start
`AnagenX.TaskManager`, the `:graph_workflow_registry` Registry,
`AnagenX.Web.WorkflowApi.SSE.{StreamRegistry,ShutdownRegistry}` and a `Phoenix.PubSub` named
`AnagenX.PubSub`, serve `AnagenX.Web.WorkflowApi.Router` with `Plug.Cowboy.http/3`, then read
each route over HTTP. For the ephemeral, progress and control frames, call
`AnagenX.Web.WorkflowApi.SSE.Loop.run/4` with the loop's own writer, deliver chunks through the
`StreamRegistry` lookup the executors use, and broadcast lifecycle and progress events with the
producer's own factories. Pass explicit `ts:` values so captures stay field-stable; a
`node_progress` timestamp broadcast through `ProgressBroadcaster.broadcast_node_progress/2` comes
from the producer's clock and will not be.

For `node-progress-frames.sse` the recorded path was: `MIX_ENV=dev mix run` a node (which boots
`AnagenX.TaskManager`, `AnagenX.PubSub`, the SSE registries and the API endpoint), register the
run id with `AnagenX.TaskManager.create_task/4` so `/stream` answers before any journal line
exists, open one `GET /api/workflows/:id/stream` connection and wait until the loop process is a
subscriber of `workflows:<id>`, then broadcast each step with
`ProgressBroadcaster.broadcast_progress/3` over `NodeProgressEvent.new/2` (explicit timestamp)
and close the run with `Graph.Core.WorkflowEvent.workflow_engine_finished/4 |> to_map/1` minus
`:event` — the message `WorkflowRunner.broadcast_event/3` sends. With no journaled line the
connection's first lifecycle id is 1, and the progress frames before it left the counter free.
Booting that node from `feature/workflows-server` and dispatching a real declared-output run is also
what it takes to replace the two contract-derived files with captured bytes.
