# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Foreground Workflow runs: a `Workflow` call sends the named definition to its endpoint, follows the run, and answers inside the tool call that started it with the endpoint's own terminal result. The run is a record in the same agent record store the subagents use, kind-tagged for its whole life (`reconcile workflow` in the `/agents` menu, the widget and `AgentStatus`) and stopped, listed and cleared like any other record - but never steered (`MessageAgent` and the menu refuse it: a remote run has no session to receive a message), never restarted as a subagent, and never promised a completion notification. Progress lives inside the call: node status lines, tool lines and the streamed text of *this* connection repaint as they arrive, kept per node, per attempt and per turn: a turn's chunks show as they arrive, and the frame that closes the turn (an `assistant_turn` step for a turn that goes on to call a tool, the unmarked `llm_response` for one that does not) replaces that turn's own chunks and nothing older, so the turn after a tool call gets its own line instead of hiding behind the first turn, and a run that delivers the same words twice in two turns is shown twice - the delivered frame decides where a turn ends, never its wording - while a node the endpoint dispatches again starts its text over. Thinking is never displayed, and nothing is repaired from a second source, so a run whose stream delivered less than its journal shows exactly what arrived. The live echo-graph gate emitted no `node_progress` frames; its observed node updates came from `node_dispatched` and `node_complete`, so that run did not verify live `node_progress` delivery. `GET /api/workflows/:id` is authoritative for run state: a terminal frame only triggers that read, a `workflow_failed` frame's `reason` never becomes the failure message, and a terminal frame delivered twice still settles once with one inline result. `Esc` ends the call and asks the endpoint to stop - `stopped` settles stopped, `already_finished` reconciles through the endpoint's answer instead of being labelled stopped, a refused stop reports the run still remote, and an `Esc` after settlement, or after the call handed the run back - on a read that never answered or on a stop the endpoint refused - does nothing, while `/agents` -> the run -> Stop still reaches the endpoint. An `interrupted` run maps to error with the endpoint's reason preserved. A terminal result the producer did not label is reported as such with the wire value it carried, `thinking` and `usage` never reach the answer, a non-ReAct result is unchanged JSON with its nested `null`s kept as data, and a completed run with an empty result slot answers that there was no output instead of answering empty. When the run cannot be read - the endpoint unreachable, refusing the read with a 4xx or 5xx, or answering unreadably - the call hands back an unknown-state note naming what the read answered while observation keeps retrying, the record stays running and Stop stays available: only the endpoint's own terminal status or an acknowledged stop settles a watched run. An unanswered create names the endpoint's request base and every configured endpoint key; it is not retried or sent to a fallback. Ending a session - `/new`, resume, fork or quit - settles the active turn first, and that abort is what stops a bound run exactly once; a shutdown that arrives with no turn to abort ends local observation and sends nothing of its own. If the create answer arrives after shutdown, no record is registered; if the run was already registered, the waiter is released with an unknown-outcome note. The next session does not re-attach the run. Nothing the endpoint says reaches a surface unfiltered: terminal control sequences are removed, the run's effective key is replaced with `[redacted]`, and only then is the text bounded, so a credential echoed by the endpoint appears in no error, hand-back note, progress line, terminal result, record or log line (US-35).

- Workflow file discovery and the `Workflow` tool's selection surface (the first slice of the workflow feature; running a workflow follows): `.yaml`/`.yml` Workflow files in `~/.pi/agent/workflows/`, `<project>/.agents/workflows/` and `<project>/.pi/workflows/` are read as real graph-schema YAML (`name`, `description`, `nodes`, `edges`, `entry_node`) at session start, the project folders only in a trusted project, and a same-name collision replaces the whole file with project > shared > global. The `Workflow` tool's `workflow` parameter lists each visible workflow's name and description, so no briefing message is needed; a file added mid-session is found by one rescan when a call names something unknown, a miss then errors listing the available names, and every call re-reads the named file from disk, so an edit takes effect on the next call. A file that is not valid YAML or has no non-empty string `name` is skipped with a warning and the rest stay selectable; two files in one folder with the same name resolve alphabetically (later file wins, warned); the tool call shows exactly the parameters supplied (`workflow`, `prompt`, `path`, `run_in_background`) with nothing invented.
- The widget's activity line can show which programs a running `bash` call has started, behind the new `widgetShowBashPrograms` setting (`/agents` → Settings → Widget → Display → Show bash programs; global config, off by default) (`running: sleep ×10, cat (12s)…`: repeats counted, first four names then `+N`, plus how long the oldest running call has gone once it passes a second) instead of just `running command…`. It reads `/proc` at most once a second while the same `bash` calls are running (a new call costs a read of its own) and only while a `bash` call is running and the widget is visible, so the setting takes effect on the next read; with it off nothing is sampled and the activity line keeps its generic `running command…`. Linux only: it finds the call's shell through `/proc` by its `PI_SESSION_ID` and walks through subshells and wrappers like `timeout`/`env` to the program on each branch; other platforms have no probe and keep `running command…` even with the setting on.
- The compact conversation viewer collapses a `codemode` call to its nested tool rows instead of an escaped `code=...` argument, and shows the script itself when expanded. Those rows use the same form as the top-level rows (`read package.json:1-12`, `$ rm -f file`), consecutive eligible calls group into the same summary row the viewer uses elsewhere, counting the calls that failed or were cancelled, excluded calls stay individually visible with Pi-style status icons, expanding reveals why a nested call failed, and the trace updates live while the script runs.
- Workflow runs on anagen-x (design records; implementation to follow): CONTEXT.md adds the Workflow, Workflow file, Workflow endpoint, Push-per-run and Poll-reconcile vocabulary; ADR-0012 records push-per-run delivery against a registry-free server, ADR-0013 the GET-authoritative client over the SSE stream. The anagen-x read-honesty round (`64ecbc62`) adds segment-aware result/error payloads, a no-404 startup window, the `interrupted` status (mapped to error with its reason), honest stop outcomes, and SSE multi-line chunk framing.
- Workflow endpoints became configurable: named `{url, apiKey}` pairs under `workflows.endpoints` plus `workflows.defaultEndpoint` in the global config file, with the built-in `anagen-x.local` → `http://localhost:4001` used when nothing is configured. A trusted project's `.pi/subagents-lite.json` may override only the **URL** of an endpoint the global file names: that endpoint's key, its name and the default stay global (ADR-0008 as amended). A Workflow file's own top-level `endpoint` key selects its endpoint and is never sent to the server. An unknown endpoint name (in the file or in the default) and a URL that is not an absolute http(s) URL name the offender and send nothing, and a project override stays inert in an untrusted project. An endpoint entry whose URL is empty or malformed keeps its name through validation, the layer merge and the built-in defaults, so a call that names it is refused naming that endpoint instead of being sent somewhere else, and a `defaultEndpoint` the file set to `null`, `""` or a non-name is kept as the configured-but-unusable value it is: the built-in `http://localhost:4001` answers only a name and a default no file mentioned at all (US-34). Within the project layer the difference is between declaring a URL and not declaring one: a project entry that declares a URL wins even when it is unusable - the run is refused against the target the project named - while a project entry that declares none (an empty entry, or one carrying only its unsupported `apiKey`) inherits the global URL and key untouched, because an unsupported project key is ignored and never erases a different key (ADR-0008). A warning about an unusable Workflow value names only the consequence its own layer can cause: the global layer says a run naming that endpoint is refused, the project layer says the value is ignored. One rule, read against the global file's declarations before the project layer is cleaned, decides which of its Workflow settings can take effect, and that same decision drives the merge, the file's own value warnings and the ignored-key warning the project layer already produces for a non-model agent key - so an endpoint's `apiKey`, an endpoint name the global file does not name, `workflows.defaultEndpoint` and a misspelling (`workflows.defualtEndpoint`, `workflows.endpoints.release.urll`) are each named exactly once by path, never twice and never dropped in silence, values never printed, and the inert bytes stay in the layer so a later save writes back what the file said (ADR-0008). The diagnostics a config file earns are printed by one read per Pi start - the `session_start` reload, not the store the extension builds to register its tools - so one bad value is reported once. A global `defaultEndpoint` naming an endpoint no layer declares is warned about as unusable where it is read and kept as configured, so the run that gets it is refused naming the endpoints that are configured. Endpoint names are looked up by own-key membership: `__proto__` and names inherited from `Object.prototype` are not special table properties, and an inherited name such as `constructor` or `toString` is not configured unless the global file explicitly declares it. A trusted project's `constructor` entry is ignored when the global file does not declare that endpoint; a run naming it is refused instead of posted to the URL the project invented. This is the endpoint config and the run client (`create`/`monitor`/`stop`, GET-authoritative, SSE for display) only — the `Workflow` tool that uses them arrives with the next slice.

### Changed

- The package now requires **pi >= 1.5.1** (was `>=0.99.0`). When a session ends, each bound Workflow run receives exactly one stop request. Pi 1.5.1 is required because it aborts the active turn before quit; older versions could leave a bound run running without a session to watch it.

- A configured Workflow endpoint URL is now a validated request **base**, resolved once per run, and every route is built against it: the trailing slashes it carries are normalized at resolution, and the base is the URL parser's canonical `origin + pathname` (host lowercased, a default port dropped, an IDN host punycoded, path case kept). The request target is unchanged for the URLs the transport could already use (each accepted form diffed against a loopback server): a path prefix reached `/gateway/v1/api/workflows…` on create, read, stream and stop before this change too, and so did the forms whose authority the parser rewrites (`http:/host/gateway/v1`, `http:\host\gateway\v1`), because the string the client handed the transport was parsed by that same URL parser; a URL that never parsed (`/host`) was refused then as it is now. What changed is what a URL that cannot serve as a base does. A fragment in the configured URL used to send every request to that URL's own path, the route swallowed by a fragment no transport transmits (`http://host/#section` posted to `/`), and a query used to send it to that path with the route riding along inside the query (`http://host/prefix?x=1` posted `/prefix?x=1/api/workflows`); a URL carrying an embedded `user:pass` reached no server at all - the transport refuses to build a request from a URL with credentials - but its failure named that URL twice, credential pair included, and the old refusal of a URL that was not http(s) or did not parse quoted the configured value in full, credentials included. What cannot be a base now refuses the run and sends nothing, naming the endpoint, the setting `workflows.endpoints[<name>].url` and the problem: a query (a bare `?` included), a fragment (a bare `#` included), embedded credentials in the authority (`http://user:pass@host`, plus the empty `http://@host` marker the parser deletes - which used to route as a credential-free base and now refuses, because what decides is the authority as written), a scheme that is not http(s), or a URL that does not parse. A base carrying a percent escape or a `+` anywhere - host or path - now refuses too, because those are the two characters a forwarding intermediary can turn into a different spelling of the same bytes, and the check is on the assembled base because the URL parser decodes a host escape itself (`http://a%2Bb/` arrives as the host `a+b`) and percent-encodes a non-ASCII path itself (`http://host/Müller/v1` is refused as the escape it becomes): the round-4 probe base `/gateway/double%253C7%253E`, the `+`-to-space residual (`/x/a+b/y` with the key `a b`) and every other escaped spelling of a configured prefix are refused at admission and never reach a request. An `@` inside the path stays ordinary path data. A refusal quotes **no URL value** - name, setting and the list of configured endpoint keys only - because a path prefix can carry the configured key and a refusal is published. A Workflow file whose own `endpoint` key is `null` is refused naming the file's key rather than falling back to the configured default. What a surface shows is that base itself, printed exactly as configured: the separate display value that replaced a percent-escaped path with the origin alone is **deleted**, because a base that could need it cannot be configured any more. No accepted endpoint's display changes - the withheld form was unreachable the moment such a base refused; the gain is one rule fewer, not a visible one (US-21, US-34, US-35).
- One effective credential per Workflow run: the bytes a run authenticates with and the bytes every published surface redacts are one value, derived once at endpoint resolution. A configured `apiKey` is normalized by trimming outer spaces and tabs - the wire strips them from a header value, so a padded key was sent as different bytes than the needle redacted and a key the endpoint echoed came back unredacted in the inline result, the progress lines, the hand-back note and the diagnostics. A key that cannot be both sent and redacted as the same bytes refuses the run instead: an empty string, a whitespace-only value, an embedded TAB, `"` or `\` (in a JSON body those two lose their literal form, so the needle misses the key), and any non-ASCII character - printable ASCII only, a documented restriction. The refusal names the endpoint and `workflows.endpoints[<name>].apiKey`, quotes no value, and sends nothing. A declared key the config file cannot use (`null`, a number, `""`, or nothing but the spaces and tabs a run strips) is kept as the configured value it is and named by the load warning as unusable - which now happens without printing what was declared - instead of being dropped with a warning while the run went out **unauthenticated**; only a key no file declares sends no `Authorization` header. A key a project's URL-only override leaves undeclared still authenticates with the global value (ADR-0008), and `redirect: "error"` and the sanitize → redact → bound order (a bound never cutting a key in half) are unchanged (US-8, US-21, US-34, US-35). An endpoint whose request path carries its own credential is refused the same way, before any request, naming both settings and quoting neither value: a key written into the path (`/probe123/api` configured with `probe123`), one the path spells across a segment boundary, or one that runs from the path into the route. Gateways that require a token in the path cannot run. The request-target guard is now a literal containment check and nothing else, and what it guarantees is the target this client assembles: every byte this client puts in a request target is a byte no transport or intermediary rewrites - a base that needs `%` or `+` to be written refuses above, a run id that needs percent-encoding refuses below - so a credential can appear in that target, or in any echo of it (from a gateway that decodes its target once, twice, or however many times), only as its literal bytes, the one spelling the publisher's needle matches. Two things are outside that, and neither is a transformation of the target: content the endpoint authors, which can quote the key in an encoding of its own (an error body publishing `refused: Bearer%20gate%2Cway` survives redaction and one decode recovers the key), and a hop that re-encodes the characters an accepted base is still allowed to carry (`! $ & ' ( ) * , : ; = @`), which rewrites the base's own bytes and never the key's. What that replaces is deleted, not kept: the up-to-eight-layer percent-decoding loop with its `still changing at the limit is unprovable` refusal, and the two transformations it documented as uncovered - the `+`-to-space one is gone because no `+` is reachable in a target any more, and the adds-characters one is not claimed closed, only shown unable to carry a key. Published text is never decoded or rewritten. A prefix without a credential is sent normally and shown as written (US-35).
- A created run's id is validated once, at the create response, against what this client does with it: as a *literal* path segment, and as the read, stream and stop routes it becomes. An endpoint answering `.` or `..` used to have every follow-up request normalized out of the run's own routes - an authenticated `GET /gateway/api/stream`, `POST /gateway/api/stop` against no run at all - and an id Fetch cannot encode (an unpaired surrogate) threw past the request error boundary, leaving the record running with no outcome until the session ended. A third answer is refused by the same gate: an id minted out of the credential the endpoint was given (which a literal id can still do - `wf-minted-7-suffix` under the key `minted-7`). The round-4 case - `wf-minted<7>-suffix` under the key `minted<7>` - used to go out as `/api/workflows/wf-minted%3C7%3E-suffix[/stream|/stop]`, so an endpoint echoing the target it received publishes a spelling of the key that no redaction of the literal matches - and the spelling can appear only once the route, the id and the id's suffixes are joined, which is why the gate judges the three assembled routes and not the id, through the same route assembly the requests use so the two cannot drift. All are one unknown create outcome now: the note names the endpoint and says the run may still be running remotely and was not retried, quotes neither id nor key, and no follow-up request is sent and no record registered. **The admission is now `encodeURIComponent(id) === id`, plus non-empty and not `.`/`..`, so an id that merely needed percent-encoding is refused where it used to route** - `wf 1/2` was pinned as accepted by the previous round and is refused now, because an encoded id is precisely the spelling a forwarding hop rewrites and a rewritten target is what no literal redaction can follow. Stock anagen-x mints `wf-<integer>-<time>`, which is literal, so a standard endpoint never trips it. A caller who hands an id straight to `monitor` or `stop` (only the create response passes this gate) gets that same refusal for the ids no segment can carry - an empty id, `.` or `..`, which the encoder leaves alone and the URL parser then deletes, so `stop("..")` used to arrive as `POST /api/stop`, and an unpaired surrogate, which has no encoding and used to throw past the error boundary - refused before any request, naming no id, sending nothing and owing no retry. Every other id, escaped or not, still routes as one encoded segment (`wf 1/2` is monitored as `wf%201%2F2`), so an id this client would not create remains followable.
- A completed run's answer text is its declared `text` and nothing else the value happens to hold. The formatter used to decide what a result *was* from its key set - print `text` when every key belonged to the ReAct payload, print the value whole otherwise - and both branches misfired: an `echo` or a narrow `local` result (`{text, usage}`) was answered with a `Termination reason: absent` line describing a field the endpoint never sent, and a ReAct-shaped value carrying one extra key was printed whole, `thinking` and all. Now `text` is the answer for every producer (anagen-x ADR-0023 requires it of a local handler), a `termination_reason` is quoted only when the producer reported one - an absent key and a `null` are the same fact, which is what a strategy with no reason field answers (anagen-x carries `nil`), and neither is a reason worth printing - and a value with no `text` still renders whole. What the value holds besides the answer is copied into nothing the client keeps. The first attempt put it in the tool call's `details`; measured against pi-agent-core, Pi writes `details` verbatim into the session file and posts the transcript untouched to a `pi-messages` endpoint, so that home was unredacted **and** model-reachable, and with `relay_thinking` default-on it would have carried reasoning blocks into both. The endpoint's stored result stays where a producer's full payload is read (US-37).
- Extended Workflow acceptance tests over loopback HTTP to cover endpoint refusals, credential redaction, unknown stream events, retry pacing, stop ordering, and session shutdown.

### Fixed

- Workflow observation is the run's state, not the tool call's: the read backoff, its failure budget and the last known run state survive the wait that was watching them. After a degraded hand-back the retries continue from the delay they owed - gaps 2/4/8/16/30/30s, the cap held, no restart at 2s, and the hand-back itself lands at the 30s cumulative mark rather than a delay later - and only a read that answered `running` starts the cadence over. An SSE stream is opened only after a create or a `GET` that answered `running`: after a failed read, retries do not wait behind a reopened stream. A stop acknowledged `already_finished` or `interrupted` gets its authoritative `GET` on the acknowledgement's own tick - skipping exactly the one owed delay and never waiting behind the stream - and settles from what `GET` says; a `stopped` acknowledgement still outranks the run's remote footprint (US-18), a terminal state already read leaves a late acknowledgement inert, and a stop that failed keeps the record running, noted and stoppable while the call hands back. The connection's latest progress and the run's observation health (state unknown until the next authoritative read, or a stop failed) now live on the record: progress observed before an outage or a hand-back is what the call's row and any later repaint show, and a run that settles after its call returned still settles once and repaints the row through the registered invalidation. Session shutdown releases a watched run instead of settling it: the call answers with one note saying this session stopped watching and the remote outcome is unknown - never whether a stop was sent, landed or failed - the record takes no terminal status, its completion gate is dropped rather than opened, no completion reaches the gone session, and the local wait for a stop already on the wire is cancelled, so an acknowledgement arriving after disposal changes nothing (US-16, US-19, US-27, US-28, US-30).
- Unknown Workflow stream events are ignored instead of ending the connection. A frame whose `event:` name this build does not know - one `Object.prototype` happens to carry (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) or one a newer producer invents - used to be looked up on the lifecycle table through the prototype chain, so it set a bogus node status that threw once the progress lines were built, and that throw ended the stream and started a `GET` early; the same frame rearmed the lifecycle silence window and moved where the next unnamed text chunk was attributed. Recognition now happens before anything changes: an unknown name changes no node status, repaints no source node, rearms nothing, asks for no read and throws nothing, so a connection delivering only unknown frames still falls back to `GET` when the silence window expires, and a recognized frame behaves exactly as before (US-12, US-19, US-35).
- A Workflow stream frame that only means “this connection is over, read the authoritative state” (`workflow_engine_finished`, `workflow_failed`, `reconnect`) changes no display state. Its payload carries the run's terminal answer, and the node named inside it used to become the node the next unnamed text chunk was attributed to, while the frames sharing that chunk's bytes were painted before the client went to `GET`: a terminal frame arriving mid-chunk duplicated an unnamed tail into the settled row. The reconcile request is now returned before any display field is read, and nothing after that frame in the same read reaches the screen. Every Workflow state read that answers nothing this client can use quotes none of the run's state envelope - that envelope is the run's result and journal, and a `500` or `503` answer used to print its text into the hand-back note, the call's row and the record's note, where even a redacted key left the run's thinking and its result readable - and says what it found instead: `HTTP 409: the endpoint answered with no reason`, `HTTP 500: the endpoint answered with no reason`, or `answered the state read unreadably: no run status this client can read: its status was "queued"`. The endpoint's own `error` field is still what it quotes when it gives one, and a body is quoted whole only where the body is a refusal of what this client sent: a create or a stop (US-12, US-19, US-35).
- Parallel tool calls starting in the same millisecond no longer overwrite each other in the widget's active-tool list.
- Two `bash` calls running at once read `running 2 commands…` in the widget's activity line instead of `running command 2 files…`.
- A completed Workflow run whose declared output node ran through the ReAct loop no longer prints its whole result envelope, chain-of-thought included. Measured on anagen-x (`wf-1731-1795296255544`, `react_local` on `anagen-x:chain/builder`), `GET` delivers that result as `{"status":"ok","value":{…}}`: the answer, its `termination_reason` and any `thinking` block live inside `value`, so the client's one promised key was one layer deeper than it read. The value matched no answer, fell to the branch that keeps an undeclared value whole, and the JSON it printed - reasoning included, usually the largest field - became the text the parent model reads. That layer is now stepped through once before the answer is sought, so the answer and its provenance come out and nothing else does; a value without both keys, which is what a `local` handler stores, stays its own answer as before.

## [1.19.0] - 2026-11-15

### Added

- Compact conversation viewer (`/agents` > Settings > Agent behavior): **Compact tool calls** (on by default; switch it off for the ordinary viewer) summarizes each run of consecutive eligible tool calls, across turns, into one `N tools (name, name, …)` row on the pending background, and shows every other eligible call on a single status-colored row with no fill bar. While compact mode is on no tool result body is shown for any call, so a fresh install shows none until it is switched off, and every summary and displayed call row keeps the viewer's usual blank spacing row. **Ungrouped tools** (default `write, edit, replace, bash, codemode, Agent, StopAgent, MessageAgent`) names the tools that keep their normal call block minus the result body and split a run, and is listed only while compact is on.
- The conversation viewer shows each tool call's run time (`Took 4.2s` once settled, `Elapsed 4.2s` while it runs, redrawn every second, nothing under 0.1s) and, in the ordinary presentation, the call's result as plain text under it: the first 3 rows, the last 3 for `bash`, plus a `... (N more lines, ctrl+o to expand)` hint naming the key you actually bound, and the whole result once expanded. It follows pi's global tool-output flag, and the viewer's expand key flips that flag, so pi's own tool rows in the chat behind the overlay change with it. Clicking a settled call expands that call alone, and any flip of pi's flag resets those per-call choices. Expanded, a tool pi has no renderer for shows its whole arguments instead of pi's 100-character collapsed preview.
- The viewer footer names the tool-expansion toggle beside the thinking one: `C-o tools` by default, the key you actually bound to `app.tools.expand` when that is remapped (several bound keys shown joined)
- Mouse interaction in the viewer (wheel scroll, click to expand) needs pi's fullscreen TUI: under `tuiMode: "regular"` the terminal reports no mouse events, so those gestures do nothing.
- While pi's tool output is collapsed (`ctrl+o`), the agent's first reply line gets its own row on the `Subagent Result` card and on a foreground result row, cut to the terminal width and coloured alike.

### Changed

- Viewer call rows now read the way pi writes each of its own tools: `$ <command>` and `PS> <command>` with a ` (timeout Ns)` suffix, `read <path>:start-end` from `offset`/`limit`, `write <path>` and `edit <path>` with their content-line and edit counts
- Rebuilding a settings list keeps the cursor on the row it was on instead of returning to the top, so a toggle that shows or hides another row leaves your place.

## [1.18.0] - 2026-11-03

### Added

- Subagents can use `MessageAgent` and `AgentStatus` when the extension and tool settings permit. Omitting `agent_id` (or passing `null`) submits a parent message; explicit IDs still address managed subagents. Children with active `MessageAgent` tools are automatically backgrounded, even when foreground was requested.
- Mouse-wheel scrolling over the conversation viewer scrolls the viewer instead of the chat behind it (pi fullscreen mode).

### Changed

- Migrated the development environment and tooling to Vite+

## [1.17.1] - 2026-10-16

### Fixed

- **Extension startup avoids Jiti resolution overhead.** Relative imports in the source now use explicit `.ts` specifiers, avoiding repeated failed `.js` path probes.
- **Performance optimization of widget** Finished and queued rows repaint only when their visible output changes

## [1.17.0] - 2026-10-14

### Added

- **`parent` is a selectable Thinking level.** Agent files, `Subagent default thinking` and the spawn wizard accept it, and the Subagent then runs at the parent session's current level. It sits in the position you set it in, so a file's `parent` beats pi's per-model level but loses to a wizard pick, and it resolves before the Subagent exists, so nothing downstream can show the word. Nothing changes unless you select it.
- **Pre-spawn menus name what decided the Thinking level.** Model settings and the spawn wizard read `high (frontmatter)` or `minimal (parent)` instead of a bare level, so an unexpected effort is traceable before you spawn. The widget, viewer and stats stay bare, because a running session stores only its number.
- **Subagents are announced to Subagent-aware extensions.** Creation, binding and disposal are broadcast on pi's event bus, so a permission gate can raise an `ask` from inside a Subagent on the parent session. An announcement can never fail a spawn or a teardown.
- **New `MessageAgent` tool feeds input to an existing agent.** A running agent takes it at its next turn boundary; a settled agent with a live session continues on it, context intact, with no second record.
- **Short agent IDs work in `StopAgent` and `MessageAgent`.** The 8-character ID the tools print is accepted when it matches one agent; an ambiguous prefix acts on none and names every candidate.

### Changed

- **The setting row is now `Subagent default thinking`.** Label only, the key stays `defaultThinking`, and it no longer collides with pi's own `defaultThinkingLevel`. Unset reads `pi default`, and `pi default` in the list removes the key at the chosen layer.

### Fixed

- **An untrusted spawn target no longer hides your global per-model Thinking level.** The gate discarded pi's whole `modelThinkingLevels` map rather than only the untrusted project's file, so the run ignored a level that Model settings printed.
- **Both Thinking level annotations follow the same parent level.** Model settings fell back to the current session context and the wizard did not, so the two rows disagreed about one run.
- **A Thinking level picked in the spawn wizard is clamped to the model the Subagent gets.** Choosing `(inherits parent)` was the one model change that skipped the clamp.
- **The spawn wizard reads pi's per-model level for the model the Subagent actually runs on.** It used the parent's model even where the agent file pins another, so it offered levels that model cannot run.

## [1.16.0] - 2026-10-05

### Added

- **Extension tool aliases accept `extension/all` as well as `extension/*`.** Both forms include or exclude all tools from the named extension.
- **New config setting `loadToolsImplicitly` (default ON, `/agents` > System Prompt).** When frontmatter omits the tool fields, ON makes the Subagent behave like a normal session: pi's `defaultTools` applies unchanged and inactive tools stay registered for dispatcher tools. OFF starts it with no tools. Explicit frontmatter always wins.

### Changed

- **Child sessions load pi's built-in extensions** (codemode, tool-search, mcp; llama.cpp excluded). They are addressable by bare name (`codemode`) from `defaultTools`, settings `extensions`, and frontmatter `extensions`/`exclude_extensions`, exactly as in a normal session. Requires pi >= 0.99.0.
- **A silent agent config no longer snapshots `defaultTools` into a registry allowlist.** pi owns tool fallbacks, so dispatcher tools can reach inactive and late-registered tools.

### Fixed

- **Extension tool aliases use the owning package name.** Package extension entries under paths like `src/index.ts` now resolve to their declared package name instead of `src`.
- **No more child-session leaks.** Every child session terminates through one idempotent disposal (abort, `session_shutdown`, dispose) — whether it settles, stops, is cleared, outlives its record, or fails during setup — releasing built-in extension resources exactly once.

## [1.15.1] - 2026-09-30

### Fixed

- **OpenAI Responses token injection preserves ChatGPT sign-in compatibility.** The subagent output-limit hook now overrides pi's existing `max_output_tokens` but doesn't restore the field when pi omitted it for Sign in with ChatGPT credentials.
- **Context percentage respects its own widget visibility setting.** It remains visible when input and output token counts are hidden.

## [1.15.0] - 2026-09-24

### Changed

- **The conversation viewer no longer shows tool results.** Each tool call renders as a single status-colored line (tool name + args summary, pending → success/error background); result content never renders, inline under a call or as a standalone result block. Thinking, assistant text, steering, stop, and scrolling are unchanged, as is the parent chat's Agent tool display and the text the model receives.

## [1.14.0] - 2026-09-16

### Fixed

- **`Agent`, `StopAgent`, and `AgentStatus` registered with `description: "."`**. Some gateways rejected description-less tools.

### Added

- **Opt-in agent descriptions in the Agent tool schema.** A new `agent.exposeDescriptions` setting (default `false`) makes the `Agent` tool's `agent` parameter description list each visible agent's name together with its Markdown description (`Available agent types:` followed by one `name: description` line), so SDK/RPC/print-mode hosts get routing-relevant information at the decision point without any TUI interaction. Empty descriptions degrade to the bare agent name and hidden agents stay excluded. Default behavior (name-only, minimal tokens) is unchanged; the value is read when the tool registers, so toggling it takes effect on the next session. Toggle lives in Agent settings > Tools ("Expose agent descriptions").

### Changed

- **AgentStatus no longer requests constrained sampling.** Its empty, closed parameter schema remains unchanged, while providers are free to handle the status call without strict JSON schema mode.
- **Subagents respect pi's per-model thinking level setting.** A `modelThinkingLevels` entry in pi's settings.json (keyed `provider/modelId`, project layer over global) now participates in subagent thinking resolution at the position above the `defaultThinking` setting: explicit spawn param > agent frontmatter `thinking` > pi's per-model level for the resolved model > `defaultThinking` > pi's own fallback (`defaultThinkingLevel` setting, then medium, clamped to the model's supported levels). Previously the per-model level was ignored everywhere: `defaultThinking` silently overrode it, and session creation never consulted it. The Model settings menu, the spawn wizard, and the Agent tool call display show the same spawn-effective chain. The wizard's thinking value is now a Derived/UserSet state: it shows the level the spawn will actually run with and re-derives when you switch the model, while any explicit pick (including Inherit) is kept across model switches and only clamped to the new model. `defaultThinking` keeps its purpose — overriding pi's global default — but no longer overrides an explicit per-model choice.
- **`@earendil-works/pi-coding-agent` floor raised to `>=0.84.3`.** The per-model thinking setting and its `SettingsManager` accessors shipped in pi 0.84.3, so the per-model read calls the accessor directly instead of degrading through raw settings reads for older versions. Lockfile regenerated through npm.

### Fixed

- **Conversation viewer no longer loses streamed content at block boundaries.** While watching a subagent run, each completed streaming block (thinking, then response text) vanished the moment the next block started and only reappeared when a tool result landed minutes later. pi's agent loop replaces the last messages-array slot on every streaming delta, so the viewer's per-index render cache — keyed on array reference, count, and width — never went stale while a message streamed and stayed frozen at its first, near-empty snapshot; the streaming accumulators, the only other copy, are cleared at each `*_end`. The viewer now re-renders the in-flight message's cache entry from the session transcript synchronously at exactly the accumulator-clearing boundaries (`thinking_start`/`thinking_end`/`text_start`/`text_end`) and at the session-level `message_end` (pi's final-message slot swap), where the finished block exists only in the transcript — so it can never duplicate the live streaming suffix. Completed text stays on screen the moment it completes, content shown is never retroactively changed when the tool result re-renders the message, and the debounced streaming render cadence, ctrl+T thinking visibility (with the "Thinking..." label while hidden), tool-result inlining, and scroll behavior are unchanged.
- **Restart last agents obeys the project-trust gate.** Restarting agents from session history skipped every check the live Agent tool applies to `worktree_path`: the historical path was neither validated nor trust-resolved, the target project's `.pi/agents` types loaded unconditionally, and the spawn runner treated the target as trusted (`projectTrusted` defaulted to true) — so a restart into an untrusted cross-repo worktree ran with that project's agent types and settings, contradicting the warning live spawns surface. Each historical call now resolves through the same shared spawn-target computation as a live spawn: the path is validated (an invalid one is reported in the skipped list with the self-correctable error), cross-repo trust is resolved, the explicit `projectTrusted` decision is forwarded to the runner, untrusted targets' `.pi/agents` types stay hidden, and the untrusted-project warning reaches the user through the same shared notify policy as live spawns. Calls without a `worktree_path` are unaffected, and a malformed one (a non-string value from history or a tool call) counts as omitted exactly as the live tool treats it instead of failing with a TypeError; restarted agents now also show the target's worktree label in the widget like live spawns.
- **Agent tool call thinking injection obeys the project-trust gate.** The pre-execution injection read pi's `modelThinkingLevels` at the spawn target through an ungated `SettingsManager`, so an untrusted cross-repo `worktree_path` target's settings file could set the spawn's thinking level — the injected value runs as the explicit param, above every configured source, while pi's trust warning says the project's `.pi/` settings are ignored. The listener now resolves the spawn target exactly as execution does (validation plus the same trust decision, silently, without duplicate warnings) and skips the per-model term for untrusted targets; the runner's own trust-gated read still decides. The read also now uses the validated target path instead of the raw tool argument.
- **Spawn wizard no longer passes its derived thinking level as an explicit override.** The Derived display value is a prediction read at the parent cwd; passing it as the explicit param shadowed a worktree target's own per-model entry and pi's per-model fallback. In the Derived state the wizard now spawns with nothing — frontmatter, per-model, and defaultThinking are exactly the runner's chain, resolved at the actual target cwd — and re-reads the pi settings snapshot when the selected worktree changes, so the displayed level keeps tracking the spawn target. A user-chosen level (including Inherit) is still passed as chosen.

## [1.13.1] - 2026-09-04

### Changed

- **Running Agents menu shows readable durations.** Each row now shows a formatted run duration (`5m 37s`, `1h 1m 1s`) instead of a raw second count. Finished rows freeze the duration at completion and append how long ago the run settled (`... — my task 2m ago`).
- **Schemas migrated to pi's `typebox` 1.x line, declared as a peer dependency.** Tool parameter schemas and config validation now build on the unscoped `typebox` package instead of `@sinclair/typebox` 0.34 — a package the pi host does not ship, so the extension and host previously maintained different schema libraries. `typebox` (>= 1.3.7) joins the three pi packages as a peer: pi's extension loader aliases it to the host's own copy in every runtime mode, dev/CI gets it via npm peer auto-install (lockfile-pinned), and the extension ships no schema-library copy at all. Emitted schemas are unchanged JSON data; the full suite passes without behavior changes.
- **Dev dependency on pi dropped; the peer declaration is the single contract.** The `@earendil-works/pi-coding-agent` devDependency entry is removed — npm provides the package in dev/CI by auto-installing the existing peer dependency (`>=0.82.0`), so typecheck and tests are unchanged while the version floor is declared once instead of twice. The lockfile keeps pinning the resolved version. Dev-only: no impact on the published package.

### Fixed

- **Manual spawn runs in background by default.** The spawn wizard Background toggle now defaults to ON, so the parent session gets the result via nudge. Foreground menu spawns had no tool return to deliver through, so their result never reached the main session.
- **Tool count marker renders reliably across terminal fonts.** Replaced the forced text-presentation emoji with a one-cell text symbol, avoiding the Unicode replacement glyph when that text variant is unavailable.
- **Subagent output-limit injection follows pi's per-API algorithm.** When an agent sets `max_tokens`, the injected provider field is now resolved exactly the way pi resolves it for the model's API — `max_output_tokens` on OpenAI Responses APIs, nested fields on bedrock, Google, mistral, and pi-messages, pi's compat-chain field on openai-completions, and none on Codex — and it is re-resolved per request, so a mid-run model change stays in sync with pi. Previously the extension sent a top-level `max_tokens` field whenever the model's compat was silent, which those providers ignore or reject, so the author's cap silently dropped. Models on unknown future APIs keep the previous `max_tokens` injection.
- **Config files validate on load.** Every value in the global and project config files is checked against a runtime schema at load. A wrong-typed value is dropped from the effective config (built-in defaults apply), valid keys are kept, the file on disk is left unchanged, and one warning per bad value names the file, the key, what was got, what was expected, and how to fix it in the `/agents` menu or by editing or deleting the file. Fork-shaped object model values are dropped with a warning, never migrated, and a bad value can no longer crash the load with an unhandled error.

## [1.13.0] - 2026-08-20

### Added

- **Agent `color` frontmatter.** Agent `.md` files can set `color: <named-color>` or `color: #RRGGBB` in frontmatter. The agent's status icon is tinted with that color across all UI surfaces, including widget connector lines and a new toggle in General settings.
- **Background agent status indicators.** When an agent is scheduled to run in the background, the UI now clearly shows its status in the call-line icon: `◆` (accent) when queued, `◈` (accent) when running, `✓` (success) when completed or turn-limited, `✗` (error) on error or abort, and `■` (dim) when stopped; foreground call lines show `▸`. The result line shows the model tag and stats for finished foreground agents and the description only for background agents (icon lives in the call line). Live status updates via invalidation map — the icon flips as the agent progresses.
- **Model picker prioritizes configured models.** The model picker (via `/model`, model settings, concurrency settings, and spawn wizard) now shows models sorted: current model first, then models from `subagents-lite.json` agent config (default + per-type overrides), then all remaining models. This makes configured models easy to find without searching. Search/filter still works correctly with the new sort order.

### Changed

- **Flattened settings menu.** Reworked setting menu into 5 top-level categories for easier navigation.
- **Unified agent status icons across all UI surfaces.** Tool call lines, the subagent status widget, and the conversation viewer now share one status→icon map (`statusIcon` in `format.ts`): `◆` queued, `◈` running, `✓` completed (success), `✓` turn-limited (warning), `✗` error/aborted, `■` stopped (dim), `▸` when no status yet.

## [1.12.0] - 2026-08-15

### Added

- **Restart last agents from debug menu.** A new "Restart last agents" command in the debug menu finds the most recent Agent tool call(s) in session history and replays them, spawning fresh agents with the same configuration. Useful when agents are cancelled by mistake or lost after reload. Running agents are skipped. Uses current config model (not historical) and spawns as background for steer support.
- **Limit-bounded AgentStatus output.** The AgentStatus tool now always lists in-progress agents (running, queued) and then shows settled agents (completed, turn_limited, aborted, stopped, error) most-recently-settled first, capped at `agentStatusLimit` settled agents; when settled agents are hidden, the output ends with "and N more settled agents". The new `agentStatusLimit` config key (Widget settings > Behavior, numeric entry) defaults to 0 = auto: 2 × the configured default concurrency (8 at the built-in default of 4), so the cap scales with how many agents can run at once. Records are unaffected — the limit only changes what the tool prints.
- **ext/none syntax suppresses extension warning.** Agent tool configs can now use `ext/none` in the tools list to explicitly register zero extension tools, suppressing the warning about missing extensions. Previously `tools: []` meant zero built-in tools but extensions were still warned about; `ext/none` now makes the intent explicit.

### Changed

- **No explicit `any` type usage remains in test code.** `typecheck` already covered `test/`; every explicit `any` annotation across the test suite is now replaced with the real `src/` or pi-package type, or with a structural fake asserted at a single call boundary. Type-level only: all 1592 tests behave identically.
- **Test `any` regression gate.** `npm run test:any-gate` scans `test/` for explicit `any` annotations and fails if any are found (whitelisting the two documented load-bearing sites and `expect.any(...)` vitest matchers). Import specifiers in test files unified to `.js` (no `.ts` extensions in import paths).
- **Typed test context helpers.** `fakeCtx()` and `createMockCtx()` in `test/fixtures.ts` now return properly typed `ExtensionContext` / `ExtensionCommandContext` with typed defaults and an options parameter for overrides, eliminating the two documented `any` return annotations.
- **`subscribeToSessionEvents` annotation corrected.** The function's parameter type now references `RunCallbacks` (the interface that defines the callback keys) instead of `RunOptions` (which carries extra fields the function never reads). Purely defensive; no call sites changed.
- **TypeScript 7 toolchain and test typechecking.** The development toolchain now uses TypeScript 7.0.2 (the native compiler, `tsc`); the package swap is behavior-neutral for the extension itself. `npm run typecheck` now covers `test/` as well as `src/` (tests were previously transpiled by vitest but never typechecked); the type errors this surfaced were fixed in test code only (stale mock typings, fixtures, and imports), with no change to extension behavior.
- **Subagents honor pi's `defaultTools` setting.** Agent types without explicit tool config now use pi's `defaultTools` (global `~/.pi/agent/settings.json` + project `.pi/settings.json`) as their registered built-in tool set. Unconfigured keeps the hardcoded `read`/`bash`/`edit`/`write` set, explicit `[]` means zero built-in tools, and explicit agent tool config (whitelist, `exclude_tools`, `tools: false`, read-only sets) still wins. Extension tools remain always-enabled. On pi < 0.84.2 the setting is honored via the merged-settings read; only the `getDefaultTools` API is missing (pi ≤ 0.84.1 lacks the accessor — 0.84.2 ships it — so the read feature-detects and falls back to the merged settings field).
- **Model settings grouped by resolved model.** Per-type overrides are grouped alphabetically by the model they resolve to; each row shows the spawn-effective (clamped) thinking level and the winning layer's tag (`[session]`/`[project]`, global-won rows untagged). Only explicit per-type overrides are listed; frontmatter-only and inheriting types stay hidden (hint arrows gone). The session default is a session-wide override that beats config per-type overrides and frontmatter models. Concurrency settings share the style: rows set targets inline with a nested Clear, section headers in bold accent, and clear/remove pickers offer only the levels that carry the setting ("All levels" only when at least two do), and `j`/`k` navigate list submenus.
- **Debug menu shows each agent type's effective tool set.** The Agent types listing and the Agent briefing now display the tools an agent actually gets: the explicit `registeredTools` when configured, otherwise pi's `defaultTools` setting, otherwise the hardcoded `read`/`bash`/`edit`/`write` set. The generic "all built-in tools" placeholder is gone, the briefing always includes a Tools line, and an explicitly empty set renders as `(none)`. The menu reads `defaultTools` through the same version-tolerant accessor as the spawn path, so the two displays and the session gate cannot diverge. `tools: []` in an agent config now means zero built-in tools everywhere — no consumer silently falls back to the default set.

### Fixed

- **Agent tool error display shows ✗ instead of ✓.** Agent and StopAgent tools now throw on errors instead of returning `errorResult()`, matching how built-in tools (bash, edit, read, write) handle errors. Agent-loop's catch block sets `isError: true`, so the renderResult callbacks use `context?.isError` (from the agent-loop's correct error flag) instead of `result.isError`, which is absent from the production data flow. Failed tool calls now correctly display a red cross (✗) and error background color.
- **nanoid bumped to 3.3.18.** The dev-only transitive dependency (via postcss) is now locked at 3.3.18, clearing the high-severity `npm audit` finding for nanoid's zero-size generator loop (GHSA-2v37-7h3g-55p8). No runtime or extension behavior change.
- **Agents status line stays visible for the session.** The status line's visibility is now: after the last agent finishes and its row ages out, the line keeps showing the session done count and cost in its dimmed form, and it hides only when no agent records exist.
- **Git-root discovery during skill loading is constant-time per ancestor level.** `findGitRoot` now probes `.git` with a single `existsSync` per level instead of reading the full directory listing
- **Tool-argument summaries truncate with the ellipsis character.** Long single string arguments to arbitrary tools now end with `…` (U+2026) like bash commands, instead of three ASCII dots.
- **Write-tool summaries show the real file path.** `summarizeToolArgs` now reads the `path` argument key that pi's write tool actually sends, so summaries render as `write("/path/to/file", N chars)` instead of `write("", N chars)`.

## [1.11.0] - 2026-08-14

### Added

- **Parent interrupt forwarding.** Foreground subagents are now bound to the parent's interrupt signal. Stopping the parent stops all foreground children. Background agents are not affected.
- **Project-level config.** `.pi/subagents-lite.json` in a trusted project is an override layer over the global `~/.pi/agent/subagents-lite.json`: it may hold only model and concurrency settings, and each key it sets overrides the global value; clearing a project value falls back to global. `/agents` menu changes now pick a write target — session, global, or project — and persist only that level's keys; the merged config is never written to a file. Unknown keys in a hand-edited project file are ignored with a warning; a malformed project file is ignored and the project level is not offered. Loaded only in trusted projects, same as `.pi/agents`.
- **Agent menu clear actions.** Individual `Clear` action removes a settled agent. `Clear all`/`Clear done` bulk-removes all/done agents from the widget.
- **Time-based finished retention.** Replaced turn-based eviction with a configurable time window. Finished agents stay visible for `finishedRetentionMinutes` (default 1 min) instead of a fixed number of turns.
- **Transient transport error retry.** Brief stream failures (ECONNRESET, EPIPE, ETIMEDOUT, EAI_AGAIN) are retried automatically instead of failing the run.
- **Continue settled agents.** `steer()` now resumes a settled agent (completed, errored, aborted, stopped, turn-limited) that still has a live session, instead of requiring a re-spawn. The viewer footer/composer switches from "steer" to "continue" for settled agents.
- **Per-agent context and prompt inclusion.** New `include_context_files` and `include_system_prompt` frontmatter fields on agent definition files override the global settings per agent: whether AGENTS.md/CLAUDE.md context files load as `<project_context>`, and whether the parent's system prompt is included (inherit, replace, or global mode).
- **Stop notes for never-started agents.** Agents stopped before they started (queued stop, aborted spawn) now report that the task was NOT attempted instead of claiming partial output. Applies to tool results and background nudges.

### Removed

- **`effectiveDefault` from the model-groups builder result.** `buildModelGroups` no longer computes or returns an `effectiveDefault` field: no production code consumed it (the menu derives the default row from the config snapshot's own `default` key), and it duplicated the menu's local `effectiveDefault` under a different meaning. The `ModelGroups` interface and its tests no longer reference it.
- **`deltaInputTokens` setting and delta estimation.** Removed the vLLM-specific workaround that estimated input token deltas by subtracting consecutive `usage.input` values.

### Changed

- **Running Agents menu bulk actions grouped.** The stop row sits above the clear-actions group.
- **Case-insensitive agent type resolution.** The `Agent` tool's `agent` parameter now resolves type names case-insensitively: the exact registered name wins; a single case-insensitive match resolves; two types differing only by case produce an error naming both candidates instead of a silent pick, and nothing spawns. Applies to the initial lookup, the mid-session re-scan, and worktree-targeted spawns.

### Fixed

- **Model settings per-type provenance tag.** When the session default shadows a project key, the per-type row now shows `[session]` (the value's true source) instead of a misleading `[project]`.
- **Spawn options menu refreshes after a change.** Setting or clearing any spawn option now rebuilds the row immediately, so "Default max turns" and "Default thinking level" show their new value and `[project]` tag without reopening the menu.
- **Default concurrency limit removable per target.** The "Default concurrency limit" row now offers Edit limit / Remove limit like the per-provider and per-model rows, so the value can be cleared at the chosen level (session, global, project, or all) and fall through to the next layer.
- **Default max turns clearable per target.** The "Default max turns" row's target picker now offers "Clear...", leading to a nested per-level picker (global, project, or all levels) so the value can be removed at a chosen level and fall through to the next layer, instead of requiring an empty submission.
- **Model settings "Set globally" label aligned.** The entry now reads "Set globally (saves to config)", matching the target picker's "saves to" phrasing.
- **Target-picker wording.** The global and project entries now read "Global (saves to config)" / "Project (saves to project config)", parallel with "Session (not saved)".

- **"(inherits parent)" no longer stored as a model value.** In the Model Settings menu, picking "(inherits parent)" now deletes the key at the chosen level (session, global, or project) instead of persisting the literal sentinel string into the config file or session overrides; the effective model falls through to the next layer.
- **"All levels" clears never create a project file.** Clearing a model or concurrency key at all levels in a trusted project without `.pi/subagents-lite.json` previously wrote an empty project file out of nothing. A clear now skips the project layer entirely when no project file exists (only a set creates the file); an existing project file keeps today's behavior.

- **Conversation viewer freeze from running agents menu.** Viewer overlay now uses `{ overlay: true }` so closing it restores the menu instead of clobbering it and freezing all input.
- **View result bottom border.** Fixed mirrored corner characters in the text viewer frame.
- **Running Agents menu skips separator rows.**
  Up/down navigation no longer lands on the blank separator rows between the agent list and the bulk actions; the cursor jumps from the last agent straight to the first bulk action row. The separator-skip mechanism is now a shared helper used by both the settings-menu wrapper and the Running Agents menu.
- **`defaultMaxTurns` fallback in tool execution path.** Prevents failures when max turns is not explicitly set.
- **Stale concurrency slots cleaned up.** Removing a concurrency limit from config now frees the orphaned slots in-session.
- **`outputThinkingBufferSize` changes apply live.** The thinking-buffer size is now read from the config store at run time, so changing the setting takes effect without restarting pi.
- **Rejected abort/steer promises swallowed.** Session abort and steer calls no longer throw unhandled rejections when the session is already closed.
- **Qwen quota retry.** Qwen `insufficient_quota` errors containing "Allocated quota exceeded" are retried instead of failing immediately. These may be transient false positives when the quota check is eventually consistent.

## [1.10.0] - 2026-08-09

### Added

- **Respect pi's `hideThinkingBlock` setting.** Conversation viewer now honors the parent's thinking block visibility setting.

### Changed

- **Widget layout.** Activity expands to remaining width.
- **Compact mode layout.** Activity and description expands to remaining width.

## [1.9.0] - 2026-08-06

### Added

- **`outputTranscript` setting.** Global config option and `output_transcript` frontmatter field disable per-agent `.output` transcript writing; agent-level setting overrides global. Spawn Options menu includes toggle.
- **Model/thinking placement setting.** Controls where model name and thinking level appear in the widget: `header`, `metadata`, or `none`. Defaults to `metadata` in full mode, `header` in compact.
- **CI automation for GitHub releases.** Pushing a version tag now automatically creates a GitHub release.

### Changed

- **Migrated from Bun to npm.** Project now uses npm for package management; lockfile is `package-lock.json`.
- **Default changes.** `modelDisplayStyle` now defaults to `name`; `finishedRetentionMinutes` defaults to 1 (was 10); `outputTranscript` defaults to `false`.
- **`finishedRetentionMinutes` setting accepts decimals.** decimal values are allowed.

### Fixed

- **ConversationViewer cache invalidated on message replacement.** Ensures stale conversation state doesn't persist when messages array is replaced.
- **Model/thinking placement defaults aligned.** Internal defaults now match user-visible defaults.
- **Output-file streaming survives session compaction.** File output continues correctly after session compaction events.
- **Widget block height matches rendered lines.** `getBlockHeight` now accounts for metadata line presence.

## [1.8.0] - 2026-08-05

### Added

- **Watchdog for stuck agents.** Detects agents stuck in long tool calls or idle states and stops them automatically. Configurable timeouts: `watchdogToolTimeoutMinutes` (default 45) and `watchdogIdleTimeoutMinutes` (default 45). Surface in widget, results, and nudges.
- **Scroll-viewport navigation.** Widget navigation now tracks a scroll window that follows the highlighted agent, keeping the selected row visible when the roster overflows the available space.
- **Identity-based nav highlight with deferred rerank.** Navigation highlight now tracks agent IDs instead of positional indexes, so the highlight survives roster reordering between renders.
- **Tool and idle timeout entries in Spawn Options menu.** Configure watchdog timeouts per-agent at spawn time.
- **Optional background completion hiding.** Widget Behavior settings can hide background-agent completion cards from the TUI; results remain available to the model and Running agents. Thanks [@michalriha1](https://github.com/michalriha1).

### Changed

- **`navHint` setting now respected during active navigation.** The nav hint in the widget heading shows only when not actively navigating.
- **Widget navigation refactored.** `navUp`/`navDown` merged into `moveNav`, nav state extraction unified behind `resolveNavState`, and rendering split into focused methods.
- **Subagents without explicit tool config default to pi's active set (`read`, `bash`, `edit`, `write`)** instead of all built-ins; `grep`/`find`/`ls` must be whitelisted in `tools:` to activate.

### Fixed

- **Non-numeric input rejected in numeric menu items.** Prevents entry of invalid characters in timeout and other number fields.
- **ctrl+o shortcut detection uses `matchesKey`.** Supports all terminal input formats instead of raw character matching.
- **Hidden agents now display their configured `display_name`.** Previously, hidden agents showed "Agent" instead of their frontmatter `display_name` when spawned.

## [1.7.0] - 2026-08-02

### Added

- **Transient Codex stream error retry.** Brief stream failures (ECONNRESET, EPIPE, ETIMEDOUT, EAI_AGAIN) are now retried automatically instead of failing the run.
- **Cross-repo `worktree_path` targets.** `worktree_path` accepts a path inside any git repository on disk: a linked worktree of the parent's repo, its main checkout, or a different repo. Paths outside any git repo are rejected.

### Changed

- **Cross-repo spawns gated by project trust.** Spawning into a different git repo loads the target's project resources only when pi's trust decision (nearest ancestor) or the global `defaultProjectTrust` setting allows it. An untrusted target still spawns, but its resources (`.pi/` settings, extensions, skills, prompts, themes, system prompt files, `.agents/skills`) are ignored, `.pi/agents` types are not discovered, and a warning is surfaced. Same-repo paths are never gated.

### Fixed

- **Git path normalization on Windows.** Worktree paths use backslash separators on Windows so `git rev-parse` resolves correctly.
- **Newlines sanitized in error messages.** Prevents TUI layout breakage when error text contains `\n` or `\r` characters.

## [1.6.1] - 2026-08-01

### Changed

- **`showTools` and `deltaInputTokens` now default to off.** Reduces noise in the widget and spawn wizard for new users.

### Fixed

- **`defaultThinking` from spawn options now applied in LLM-driven spawn path.** Subagents spawned via the `Agent` tool now respect the thinking level set in spawn options when agent frontmatter does not define one. Previously they inherited the parent's thinking level instead.
- **Error message included in background agent failure nudge.** The completion nudge for a failed background subagent now appends the error text so the parent sees why the agent failed without opening the output file.
- **Subagent model errors surfaced as failed runs.** When a subagent's model fails (load error, OOM, provider error), the run is now reported as an error instead of silently completing with an empty result.
- **Agent self-stop distinguished from user stop in status notes.** Agent-initiated stops now read 'STOPPED BY YOU' matching the user stop style.
- **CRLF line endings parsed in agent frontmatter.** Agent files with Windows line endings (`\r\n`) are now parsed correctly. Previously the closing delimiter was not recognized and the agent was silently dropped.
- **Model picker uses `ctx.scopedModels` for pi 0.83+.** Model list respects provider-scoped model availability.

## [1.6.0] - 2026-07-29

### Added

- **`statusBarFormat` setting** (`'full' | 'compact'`). Full format (default) always shows active and done counts. Compact: `◈ N MΣ`.
- **Model and thinking indicators in widget.** `(modelName · thinkingLevel)` shown next to agent names. `modelDisplayStyle` toggles between short ID and full name. Independent visibility toggles in widget settings.
- **Model-aware thinking level filtering in spawn wizard.** Levels filtered by selected model's capabilities. Model change clamps current level.
- **`agentToolStrictMode` toggle.** Constrained sampling with strict json_schema for the Agent tool. Reduces malformed tool calls at higher token cost.
- **Thinking level in nudge cards.** Shown alongside model name.
- **Project agent dirs gated behind `isProjectTrusted()`.** Untrusted projects skip `.agents/agents` and `.pi/agents`. User-level agents always load.

### Changed

- **Widget settings reorganized into 4 submenus.** Layout, Display, Behavior, Stats.
- **DONE line shows token count, not cost.** `getLifetimeTotal()` returns input + output only.
- **Stats labels drop `Show` prefix.**

### Fixed

- **Spawn wizard display refreshes** after model or thinking level change.
- **Thinking level displayed in widget** when using default (inherit) thinking level.
- **Failed agent starts no longer count** toward `totalAgentCount` or `totalAgentCost`.
- **`setShowModel`/`setShowThinking` now sync stats visibility** to the widget immediately.
- **Home directory resolution on Windows.** Replaced `process.env.HOME` with `getAgentDir()` from SDK.
- **Text emoji for tools count** in spawn options.

## [1.5.2] - 2026-07-28

### Added

- **Configurable turn-based eviction for finished agents.** Widget evicts agents after a configurable number of idle turns (default 4). Gated behind `finishedEvictTurns` setting.
- **`finishedRetentionMinutes` setting** (Widget Settings, default 10, min 1). Controls how long finished agents stay visible.
- **Navigation highlight clamps** when roster shrinks from agent eviction.
- **`max` in spawn menu.** Max thinking level now selectable in the spawn wizard.

### Changed

- **Finished agents no longer vanish mid-navigation.** Widget eviction unified with manager retention.
- **Agent tool result message clearer.** Delegation confirmation now explicitly states the agent was spawned.

### Fixed

- **Turn eviction timing corrected.** Eviction now triggers on `turn_start` instead of `tool_execution_start`, preventing incorrect eviction.
- **Widget error containment.** Render, timer, and turn errors are caught and logged instead of crashing the widget.
- **Extension tools available to subagent sessions.** Tools registered by extensions now pass through to subagent sessions correctly.
- **Nav breakage after eviction fixed.** Roster navigation stays consistent when agents are evicted.

## [1.5.1] - 2026-07-26

### Fixed

- **Extension tools no longer missing from subagent sessions.** `createAgentSession({ tools })` is a registry allowlist gate in pi; a builtins-only list silently filtered out every extension tool before registration. Fix: expand `tavily/*` and bare extension tool names in the whitelist _before_ session creation so they enter the gate. `resolveSessionAllowedTools` (new, in `agent-types.ts`) owns this policy; in whitelist mode the gate derives from the expansion alone (no raw wildcards, no unlisted builtins leak). `tools: undefined` agents register all loaded extension tools consistent with pi's own `includeAllExtensionTools` semantics.
- **Whitelist no longer leaks unlisted builtins into the registry gate.** A secondary bug where `registeredTools` was used as an unconditional base alongside the whitelist. Under strict semantics, builtins not named in `tools:` do not enter the allowlist, and raw wildcard literals like `"tavily/*"` never reach pi as bogus tool names.

## [1.5.0] - 2026-07-24

### Added

- **Shared workspace agent discovery.** Agents from `.agents/agents/*.md` are now discovered alongside `.pi/agents/`. Precedence: default < user < shared < project.
- **ConversationViewer replaces ResultViewer.** Full conversation transcript with live streaming, thinking blocks, tool args (4000 char limit), success/error icons, compaction summaries, and event-driven updates (no polling). Navigation: arrow keys, vim j/k, g/G, Home/End, f fullscreen, r refresh. Steering via Enter when agent running.
- **Constrained tool sampling with strict json_schema.** Provider-side schema validation reduces malformed tool calls. Graceful fallback on unsupported providers.

### Changed

- **Agent status icons replaced with ◈/◇.** Broader terminal-font coverage than ●/○.
- **Peer dependencies updated to pi 0.82.** `@earendil-works/pi-*` peers now resolve to ^0.82.0.

### Fixed

- **Widget timer survives steer re-registration.** `clearWidget` no longer kills the timer when steer re-registers the tool.
- **ConversationViewer scroll boundary.** Scroll max computed from actual content, not stale cache.
- **Streaming deduplication.** No duplicate text when full message event catches up to streamed deltas.
- **`bun.lock` peerDep carets restored.** Lock file peer dependencies use carets for flexible resolution.

## [1.4.9] - 2026-07-17

### Added

- **`thinking: max` level support.** Import `ThinkingLevel` from `@earendil-works/pi-ai` so the `max` thinking level is available alongside `none`, `low`, `medium`, `high`, and `xhigh`.

### Fixed

- **Removed deprecated `modelRegistry` from `createAgentSession`.** Compatible with pi 0.80+ which replaced `modelRegistry` with `modelRuntime`.

## [1.4.8] - 2026-07-11

### Fixed

- **Cleanup timer preserves unconsumed agent records.** Background cleanup no longer evicts records before the LLM has read their results.

## [1.4.7] - 2026-07-08

### Added

- **Delta input token tracking for vLLM models.** Shows input token delta in the widget for models without cache stats. Opt-in, off by default.

### Fixed

- **User vs agent stops distinguished in status notes.** `StopAgent` tracks stop initiator, surfacing different notes in result output.

## [1.4.6] - 2026-07-01

### Added

- **`deltaInputTokens` widget setting.** Toggle input token delta display for models without cache reporting.

## [1.4.5] - 2026-06-25

### Added

- **Thinking buffer flush rounded to sentence boundaries.** Log file thinking content flushes at natural sentence breaks.

### Fixed

- **Nudge delivery fixed with fresh pi instance.** `SpawnCoordinator` stores the pi instance for nudge delivery, preventing stale context crashes.
- **Fallback to UI notification when nudge delivery fails.** Completion notifications surface even if `sendMessage` fails.

## [1.4.3] - 2026-06-24

### Fixed

- **Nudge messages use correct `deliverAs` mode.** Prevents delivery failures when parent session state has changed.
- **Stale context error suppressed on background agent nudge.** No spurious errors when nudging agents whose parent context was replaced.

## [1.4.2] - 2026-06-24

### Added

- **Thinking buffer ring selector in widget settings.** Configure how many lines of thinking content appear in the widget tail.
- **Agent display format flipped to `id (type)`.** Resolves `StopAgent` ambiguity when multiple agents of the same type are running.
- **Thinking blocks streamed to output file in real-time.** Thinking content written as it arrives, with deduplication when `thinking_end` fires.

### Fixed

- **Stale pi context crash in SpawnCoordinator nudge emission.** Uses current pi instance instead of captured reference.
- **Worktree validation warnings flushed via `ctx.ui.notify`.** Errors surface to the user instead of silently failing.
- **KV cache ordering improved.** `active_agent` tag moved after shared prefix; `AGENTS.md` placed before `agent_instructions`.

## [1.4.1] - 2026-06-19

### Added

- **Search in type, provider, model, and worktree selection menus.** Incremental text search across all spawn wizard and settings menus.
- **Live descriptions in SettingsList menus.** Contextual descriptions replace the Back button.

### Fixed

- **Notify calls buffered during setup.** Prevents session tree corruption when extensions call `notify()` before initialization.
- **Inline YAML array syntax parsed correctly.** `[a, b, c]` bracket notation strips brackets in frontmatter parsing.
- **System prompt menu rebuilds when switching modes.** Custom/inherit/replace changes update the submenu immediately.
- **Pi scaffolding stripped from parent prompt in all modes.** Inherit mode no longer duplicates pi's system prompt wrappers.

## [1.4.0] - 2026-06-19

### Added

- **`disableDefaultAgents` setting.** Hide built-in agents so only custom `.pi/agents/*.md` agents are advertised.
- **Status notes for non-normal agent outcomes.** Stopped, aborted, and turn-limited agents carry explicit notes for the orchestrator.
- **KV cache optimization.** System prompt reordered for maximum cache reuse across agents.

### Changed

- **Menus unified to pi-style SettingsList/SelectList.** All menus use pi's native components with consistent navigation and submenus.
- **`steered` status renamed to `turn_limited`.** More accurate naming for agents that wrapped up at their turn budget.

### Fixed

- **Disabled agents no longer advertised in tool description.** `enabled: false` agents filtered from the LLM's type list.
- **Agent tool type list built after settings load.** Description reflects persisted settings.

## [1.3.0] and earlier

AgentStatus tool, `worktree_path` parameter, manual spawn menu, cost display, compact mode sync, configurable grace turns, selective extension loading, skill whitelisting, and the foundational subagent spawning system with foreground/background modes, concurrency limits, and the `/agents` menu.
