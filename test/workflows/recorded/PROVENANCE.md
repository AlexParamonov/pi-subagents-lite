# Recorded workflow-endpoint bytes

Two kinds of file live here, and a passing test means something different depending on which one it
replayed:

- **Captured bytes**: a byte-for-byte response the workflow API wrote. Replaying one shows what the
  client does with what that server really sends.
- **Contract-derived payload**: captured framing and key set around a `result` value the ratified
  declared-output contract requires and no runnable server produces yet. Replaying one shows the
  client handles that shape; it is not evidence that any server delivered it.

Only `read-completed-declared.body` and the `workflow_engine_finished` payload inside
`replay-declared.sse` are contract-derived. Every other `.sse` and `.body` byte here came off a
socket. Where a capture was impossible, the row below says so and names the source the value came
from.

## Capture provenance

- Captured 2026-11-18 against a local dev node of the workflow API: HTTP responses from the server's
  own router, ephemeral, progress and control frames from its own SSE writer. `responses.json` holds
  each capture's status code. No server revision is recorded or gated on; nothing in this feature
  checks one.
- `node-progress-frames.sse` was re-recorded later the same day from a booted dev node (no Bearer key
  configured, the workflow API on port 4001). The other files are still the capture above.
- The replay captures taken through a real socket and through the SSE writer agree byte for byte, so
  chunked transport adds nothing to the frame bytes.

| File | Where the bytes come from |
| --- | --- |
| `live-stream.sse` | one live connection: multi-line `data:` chunk, multi-line `thinking_delta`, live `node_dispatched`/`node_complete`/`workflow_engine_finished` |
| `control-frames.sse` | the keepalive ping and the max-duration `reconnect` event the server's writer emits |
| `node-progress-frames.sse` | one live connection, each step broadcast through the server's progress broadcaster over real progress events, then closed by a `workflow_engine_finished` frame the recorder broadcast. Its limits are below. |
| `replay-completed.sse`, `replay-failed.sse` | journal replay through the router, of a completed and a failed run |
| `replay-declared.sse` | journal replay through the router of a journal seeded with the contract-derived declared-output terminal payload |
| `read-*.body` except `read-completed-declared.body` | `GET /api/workflows/:id` for each run state, and the `401` answer to a wrong Bearer key |
| `read-completed-declared.body` | contract-derived, not captured: see "Contract-derived payload" |
| `stop-*.body` | `POST /api/workflows/:id/stop`, including the `404` `{"error":"Workflow not found"}` the API gives for an unknown id on any route |
| `create-*.body` | `POST /api/workflows` validation rejections |

## What the capture proves, and what it does not

- A live lifecycle frame carries `event` and `ts` **inside** its `data:` JSON (it is the broadcast
  payload), while a replayed lifecycle frame does not (replay splits them out). The same event
  therefore arrives in two shapes on one client, and both are in this corpus.
- `id:` is on every durable frame, live and replayed. Chunks, thinking deltas and `node_progress`
  carry none: they are ephemeral, never journaled, never replayed, and a progress frame takes no
  lifecycle id, so the live id counter is untouched by it.
- A `node_progress` frame's `data:` carries exactly `node_id`, `step` (the producer's step atom as a
  string), `detail` (omitted when the producer sent none) and `ts` (the event's own timestamp).
  `workflow_id`, `task_id`, `strategy` and `correlation_id` are not on this surface: the stream is
  already scoped to one workflow. Which JSON keys sit in `detail` is the producer's per-step choice,
  and the server canonicalizes that value for encoding only, never reshaping it.
- JSON object key order is the encoder's, so a re-recording is field-stable, not byte-stable.
- The `steering_intervention` frame here is the turn-steering step, whose `detail` is the rule that
  fired (`reason: repeated_tool_call`). The cap state `cap_reached` is only ever *suppressed*: it
  goes to telemetry and never reaches a progress frame, so it is not a value this surface produces.
- The **order** of the frames in `node-progress-frames.sse` is the recorder's, not a run's. The
  recorder broadcast one progress step at a time in the order it chose, which is why both
  `llm_response` shapes sit after that turn's `tool_result` and `steering_intervention`: a sequence
  no single model turn produces. Each frame is real producer output for its own step; the sequence
  is not a run transcript, and it says nothing about the order a producer emits steps in.
- `node-progress-frames.sse` also proves less than a run would: the run id was registered by hand, no
  journal line existed, no graph executed, and the closing terminal frame was broadcast by the
  recorder. So these bytes show what the server's own writer puts on a live connection for each
  progress step; they do not show that a real run delivers progress frames. The connection carried
  no Bearer key, so they say nothing about the authenticated path either.
- `workflow_failed` carries `reason`, not `error`; `node_failed` carries both.
- The failure reason crosses lines: it is embedded as JSON escapes on named frames, while raw text
  frames are framed one `data:` line per payload line (`data:` with no trailing space for an empty
  line).
- A live kill (`stopped`) could not be captured: it needs a running graph. The stop ack shape
  `{"status": ..., "workflow_id": ...}` is source-verified from the API's stop handler.
- A successful `201` create body could not be captured without dispatching a real workflow.
  `{"workflow_id": ..., "task_id": ...}` is source-verified from the API's create handler.
- CRLF is **not** producer output: the server's SSE writer normalizes CR and CRLF to LF. The suite
  still feeds CRLF-framed frames, as intermediary-framing robustness, not as evidence of what this
  server sends.

## Contract-derived payload

`read-completed-declared.body`, and the terminal payload seeded into `replay-declared.sse`, carry the
ratified declared-output contract in their `result` slot: the declared output node's stored output as
string-keyed JSON. Their key set and framing are the captured ones (`read-completed-marker.body`,
`replay-completed.sse`), so the invented part is the `result` value and nothing else. No server this
slice ran answers them: a completed run answers with the retired marker, which is what
`read-completed-marker.body` shows. No captured body for the declared-output shape was available to
this slice.

What that means for a green test: a declared-output pass shows the client carries the ratified shape
through to the caller unchanged. It shows nothing about a server delivering it, and nothing about the
terminal-result pre-check firing against a real endpoint. The live gate in `wave.md` owns that
question.

A capture from a server that implements the declared-output contract would replace both files with
captured bytes; this slice took none, so they stay placeholders carrying the labels above. Meanwhile
`../fixtures.ts` pins which `RECORDED` values come only from these files, so the first real capture of
a declared output fails that pin instead of letting the labels go stale.

## Earlier bytes of the progress capture

The first version of `node-progress-frames.sse` was a placeholder built from lifecycle framing: every
progress frame carried an `id:` and a `data:` with `strategy`, `task_id`, `workflow_id` and
`correlation_id`, and the steering step carried `cap_reached`. The current file has no ids on
progress frames and none of those keys. The rule that event ids are display metadata and never
classify provenance or durability still stands and still governs the client.

## Re-recording

Re-recording needs a running workflow API node: journal seeding through the server's own append path
under a temporary log base, the task manager and SSE registries started, the router served over HTTP,
and for the ephemeral, progress and control frames the server's SSE loop driven with its own writer.
Pass explicit timestamps so captures stay field-stable; a progress timestamp broadcast through the
server's broadcaster comes from its clock and will not be. Booting a node that implements the
declared-output contract and dispatching a real run is also what it takes to replace the two
contract-derived files with captured bytes.
