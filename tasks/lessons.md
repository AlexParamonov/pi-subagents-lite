# Lessons Learned

> Only lessons that measurably improve the next outcome survive.

## Ingest (append new lessons at EOF)

New `## <name> (<detail>) - YYYY-MM-DD` entries land here. Triage regroups by topic, so position is not chronological. Entries tagged `(pipeline)` stay in this file: `.gitignore`'s `tasks/*` rule ignores any new sibling, so an untracked copy is not a home for a rule.

## Reproduce the reported case verbatim before scoping the fix - 2026-09-04

The exact reported input decides the scope: identify the API family from the verbatim model string against the installed pi source, and retest that input, not a neighbouring one. When a report names a surface, drive it at two render widths and read the frame before editing; if the symptom does not reproduce there, hunt the truncation in the same domain and leave a pin plus a mutation behind.

## Project files accept only model-family and per-type agent keys - 2026-09-04

`isProjectAllowedAgentKey` is the rule, so a project file carrying a global-only key such as `graceTurns` earns a second, correct warning. Use per-type overrides in project-file manual scenarios.

## `typebox` is host-owned; never `@sinclair/typebox` - 2026-09-04

Import `Type`/`TSchema` from `typebox` and `Check` from `typebox/value`: pi's loader aliases both to the host's copy (jiti aliases, SEA virtualModules) and npm peer auto-install covers dev/CI. When a test asserts schema internals, narrow to the emitted JSON shape rather than the library interfaces.

## A settings read must inherit its path's project-trust decision - 2026-09-05

`SettingsManager.create` defaults `projectTrusted` to `true`, so an ungated read silently includes untrusted project settings, and any injected value becomes the explicit param that outranks the whole gated chain. Put a layered-config trust decision in the reader that can see the layers (zeroing a term in the caller drops the global layer behind the one being gated), never pass a display prediction as an explicit override, and re-audit every gate that can blank a value once that value gains a user-facing source annotation.

## A new spawn entry point routes every check through the shared helper - 2026-09-06

Enumerate what the canonical entry performs (validation, trust gating, discovery, warnings) and reuse the shared prelude in the same change: the restart path shipped for weeks without trust gating because those checks lived inside the tool handler. Taking `unknown` at the shared seam also closed a latent non-string crash on both paths for free.

## Reproduce dependency behaviour in plain node before writing the contract - 2026-10-05

The env-var agent-dir redirect and `bindExtensions`' required bindings were each a 30-second node check. For "terminate exactly once" lifecycles, funnel every trigger through one deduped path whose steps each survive throwing, put a depth-flag bracket inside the seam instead of the call site, and pin mirrored engine fallbacks against the engine's real values. When dispose must observe settlement side effects, await the last promise in the chain: `Promise.allSettled(runPromise)` resumes before the chain's `.finally`.

## A lookup moved to a shared port makes short fixtures lie - 2026-10-13

Re-audit fixtures for ids shorter than the stored length and for partial ids that used to miss, and reject a blank input before resolution (the empty string is a prefix of every id).

## Queue-then-flush is pinned at the drain, never at the queue - 2026-10-13

Assert the exact messages the drain handed its target, in order: asserting `pendingSteers` holds the item left the suite green while deleting the flush loop dropped the message. Prove the assertion bites by deleting the flush and reading the red.

## Order a broadcast against a dependency's own call by wrapping and delegating - 2026-10-13

Append a marker inside a wrapper around the dependency's prototype method, `return real.apply(this, args)`, restore in `finally`, and queue a microtask inside the emit to pin the call-stack property too. Never infer the instant from what the call later emits; a test that records both sides in test-process memory cannot see the half that happens inside the dependency.

## A dependency member is not its declared type - 2026-10-13

`pi.events` is typed `EventBus` but is a guarded facade that throws once the session that loaded the extension is disposed, reloaded or replaced. Read the implementation behind a member you call, model the fake on it, and when a fire-and-forget promise feeds a loop that waits on it remove the entry on both settle outcomes: a fulfilment-only removal turns one rejection into a hang that also starves the test timeout.

## "Fire-and-forget" justifies not throwing, never silence - 2026-10-13

Where the codebase warns on every other degraded drop, warn once naming what was dropped and the channel it was meant for. Assert it with `expect.stringContaining` per line so the sentence stays free to change; check first whether the runner surfaces `console.warn` from passing tests (this one does not, so only the diagnostic tests need a spy).

## A `vi.mock` factory that lists exports by hand is a second, unchecked declaration of the module surface - 2026-10-14

Renaming or adding one export then typechecks clean and fails at runtime in every file that stubs the module. Spread the real module (`const actual = await vi.importActual(...)`) and override only the stubs, give a dependency-free helper its own module when the mock does not spread, and grep the factories for the old name whenever you rename a member.

## Before a coverage cut, sort invariants by kind - 2026-10-13

Protocol shape and ordering survive at real seams (a live subscriber on the real bus, the wrap-and-delegate observation of the binding instant); a security boundary keeps one assertion even when every neighbour is deleted. `test/agents/agent-runner-loader-isolation.test.ts` is that one assertion: the parent's event bus must never reach a child's `DefaultResourceLoader`, because `eventBus: options.pi.events` typechecks and a child-loaded extension could read parent traffic and forge these events. Re-measure the ratio before re-adding coverage, and do not restore it as "missing tests".

## Guard the read, not the write; derive at read time - 2026-10-14

A guard on a write is valid only while the state that skips it cannot return to the state that reads it, and a value that is (user intent, current context) must be derived from both at read time: storing the projection makes every context change a place that must remember to redo it. Read-time clamping also stops pi's upward clamp from ratcheting.

## A module that predicts another module's result must mirror its exact chain - 2026-10-14

Name the mirrored chain in the helper's doc comment, and read a displayed value through the same expression the run uses (never a stored copy of the same object) on every surface that explains what a run will do. Pin it by making the two sources disagree and asserting the displayed explanation; a suite that only ever sets them to the same value cannot see the divergence.

## An entry whose job is to leave a state is not a model capability - 2026-10-14

Gate the level list on what the model supports, never the escape entries (`parent`, `pi default`): gated, a level picked on a reasoning model became unreachable after a model change, and the menu's literal item-array assertion pinned the unreachable state as the requirement. Test a reachability invariant by walking to the state, changing the gating condition, and asserting the entry is still offered: a single menu's item array documents a list, not a transition.

## Before hoisting a duplicated lookup, count the calls per state - 2026-10-14

A lazily-called lookup is already the minimum on the paths that never call it; hoisting to the top of `buildItems` added one registry lookup to every rebuild. Hand the callee a resolver (`() => Model`) instead of the resolved value: the duplication goes, the resolution point stays, and per-path counts are identical.

## A constant that exists to stop drift must be used everywhere, in one commit - 2026-10-14

Convert every hand-written site, then grep for the literals it replaced. Answering the drift with a test that compares the two surfaces is tautological once both read the shared source. Same shape in types: type a mocked member by naming the real member's type, and give a widened fixture field a value the narrow type would have rejected.

## SettingsList is a truncating, id-less list - 2026-10-14

`currentValue` is truncated with no ellipsis and `maxLabelWidth` caps at 36, so do not reserve padding inside a value a shared row truncates; measure a width problem by rendering the real component at candidate widths. Submenu rows do not refresh in place (wire `onRebuild` from the `onChange`), a rebuild that adds or drops a row must carry the selection by item id (`items?.[selectedIndex]?.id`, then `findIndex`), and a decision written against the list captured at construction (`items.some(...)`) must read the live list once a row can appear. In menu tests, drive `ui.custom`'s component with real keys, identify a row by its trimmed shape (`/(?:^|\s)Stop$/`), and never carry per-option state in a closure when the fake ignores the id: look it up when the callback runs.

## Re-derive a review finding before implementing it - 2026-10-14

Grep the behaviour rather than the cited `file:line`, re-run the finding's mutation probe, and verify any identifier the suggested fix quotes still exists: a cosmetic note can describe an intermediate revision, and a row that merged two criteria can cite the right file and name the wrong fix. Read the row against the verbatim criterion it summarizes, and check its premise sentence too. When a finding reads "the implementation diverges from the requirement", open the dependency's source and the consumer list first: the contract text may be the defect, so repair issue/README/`CONTEXT.md`/CHANGELOG and the finding's status, and leave tested code alone. Grep the real callers of any formatter a contract says feeds several surfaces.

## Pi places `appendSystemPrompt` before its own later sections - 2026-10-30

It lands ahead of project context, skills and cwd, so a conditional change there shifts the prompt before everything after it. Put guidance tied to a tool in that tool's description/schema, and keep a trailing custom section genuinely system-level and stable across turns. `sendMessage` is fire-and-forget: say "submitted", not "sent", unless the API returns a delivery acknowledgement.

## Untrusted text is painted only through `plainText` - 2026-11-14

`ui/sanitize.ts` strips both the 7-bit (`ESC [`) and 8-bit (`CSI`) encodings plus C0, DEL, C1, bidi and interlinear controls, and says why pi-tui's `stripTerminalSequences` is insufficient (DEC private modes, DSR, window manipulation and DCS all survive it). Sanitize every carrier that reaches a frame: string argument, interpolated value, `key=value` value and key, tool name. Pick the hostile form the formatter leaves intact (`JSON.stringify` turns C0 into inert text, so only the 8-bit form reaches the strip there). A sanitizing test must not sanitize its own reading: assert absence on the painted frame, strip only the theme's own SGR, and name the hostile sequence literally. Scope: tool output only, as in pi. Assistant and user text still reach the terminal as written.

## A click hit-test uses the frame that was painted - 2026-11-14

Record content top row, first line and row count during the render and map clicks through them; "never rendered" means "nothing to hit". pi-tui delivers component-local coordinates and hit-tests containers by re-rendering children, so nothing reconstructs the frame more cheaply than painting it. Pin "no click target here" by driving the real `handleMouse` at that row and expecting `undefined`, and prove the pin by registering a block there.

## Viewer tests separate behaviour from presentation - 2026-11-14

Drop copy, styling and geometry assertions; keep fixture-derived data and interaction outcomes at the public seam. Security checks read the raw painted frame, never a helper that might hide the leak. A helper that strips a frame's chrome leaves every claim about that chrome unpinned: derive the slice from the rows the component pushes (or its own constant), count them, and give chrome its own `chromeRows(width)` exact-array pin. An unconditional second header row and a truncated node title both survive a content-only suite.

## One invariant needs one guard, and the guard must be probeable - 2026-11-14

When guards overlap, keep the one the code consults, delete the rest, then mutate it and require a failure: three invalidation sites hid each other, and `effect.changed = show() || effect.changed` one line after `changed = true` could never fire. Before believing a guard, feed it the input it claims to catch (a text entry that is only `ESC[31m` still carried its node label), and put a guard on the thing it protects rather than on a whole-map flag: forcing such a flag `true` for every group left all 128 format and widget tests green. When one caller needs a looser type, loosen the parameter, not the shared interface; tests outside the change sprouting `NonNullable` is the widening showing up as churn.

## Cache the stable part inside the cache the derived part already reads - 2026-11-14

A row that exists because of a sequence (a run of calls spanning messages) cannot come from a per-item cache, so split at the grouping boundary: cache what depends only on (content, width, flags) and render sequence-dependent rows at assembly time. Cache the stable part in the entry the derived part already reads, one entry, so every existing invalidation site covers it, and leave `undefined` to mean "the source grew in place, render it". Measure a widened rebuild per event, not at open: 60 calls x 100KB was 20 ms collapsed / 45 ms expanded per rebuild against 0.5-1.6 ms from the cache.

## Carry the presentation decision and the produced rows through the layout plan - 2026-11-14

Encode an existing rendering choice in the entry's discriminant instead of reclassifying downstream, and let the produced rows answer "does this paint?" so the boundary and the spacing read one value; two answers already disagreed while a streaming message grew. A second presentation mode must then consult every decision the existing control flips (ctrl+o selects summaries versus calls, clears per-call overrides, and must re-enter the slow path so grouping recomputes). For spacing, reuse the unit the surrounding renderer already emits rather than a second separator rule, and suppress a shared element at the one renderer that paints it.

## Truncate a row's variable part to the width it has left - 2026-11-15

A tool whose argument is source code needs a curated call line, because the generic `key=value` preview prints the script as one JSON-escaped blob. Size the truncation from the row's own space (`width - 2 - visibleWidth(fixed parts)`), never a fixed character budget, or the trailing field wraps onto a row of its own (`... 20m` / `s`). Verify a renderer change by running the real tool once, not only by rendering fixtures.

## A parent tool that owns a nested trace keeps its own renderer - 2026-11-15

When `codemode` was absent from the ungrouped list, top-level compaction chose the compact-call renderer and bypassed the nested calls entirely; the shipped default list masked it. Preserve the parent renderer independently of the child grouping/exclusion policy, and test with the parent omitted from that list. Group a summary line by the label it prints, not by the tool name: `grep` and `find` share `searching` and read `searching, searching…` instead of `searching 2 patterns…`.

## A fixture must be shaped like what the platform serves - 2026-11-16

A fake `/proc` tree that omitted a childless task's `children` file (the kernel serves an empty one) let an empty-token filter be deleted with all 18 rows still green, so build fixtures from what the platform serves, measured, not from what the code happens to read. When a test names an identity ("the call it replaced"), change that identity and nothing else. Prove a claim that the disabled or default path is unchanged by driving base and HEAD over the real input set, not with one example.

## A mock that answers differently from the library hides a boundary bug - 2026-11-14

Read the dependency's source for the degenerate case (pi's `Markdown.render` returns no lines for blank text, so a whitespace-only block split a run that paints nothing) and copy that emptiness test into the mock. Asking the same question at both sites keeps "does this paint?" one rule.

## Test themes: pin colour as a role, and never mark a padded row - 2026-11-14

A theme that wraps rows in control characters inflates `visibleWidth`, truncates padded rows to `...`, and trips frame-wide control checks. For a padded row use a theme that answers with the text and records `role + text.trimEnd()` per call, then pin text and roles as two exact arrays; unpadded rows (a tool card's flat lines) can keep the marking theme. Markers as suffixes keep the frame's border characters at the string edges, and a border strip must be marker-aware rather than a fixed offset.

## A transcript test must use the transitions the host really makes - 2026-11-14

The viewer's cache assumes append-only growth, so a `splice` in the middle re-attributes a cached entry to the message that moved into its index. Drive live updates the way the host does: append, or replace the whole array on compaction.

## Mirror a platform formatter from its dispatch table and its constants - 2026-11-15

Copy every branch of pi's `createAllToolRenderers`-style map (`read <path>:start-end`, `$ <cmd>`, `grep /p/ in <path>`) and keep the generic `key=value` form for the tools pi renders generically. Copy the constants and separators from the same file (`COLLAPSED_ARGS_CHARS = 100`, `key=${JSON.stringify(value)}`), reuse a platform helper only when `exports` and the built `.d.ts` publish it, and keep the mirror in one function all modes share. Give the untruncated forms their own wrap test (assert the tail survives across rows), because a short fixture cannot tell a cut from no cut.

## Never index an object-literal map by external data - 2026-11-15

`SHELL_PROMPTS["constructor"]` returns `Object` and paints the constructor's source; `"toString" in STATUS_NOTES` on stored `details` cut real prose. Use `Object.hasOwn`/`Map`/explicit comparison (see `agent-runner.ts`), pin the hostile name itself, and prove the guard by running that test once against the loose lookup.

## A shortened-value test does not pin a numeric limit - 2026-11-15

Pin the boundary pair at the seam that owns the constant: a value exactly at the limit (whole, no ellipsis) and one character past it (cut to `limit - 3` plus `...`), each as one exact full line, plus the expanded state that shows it whole. Then mutate the constant both ways and drop the ellipsis allowance. Forms the platform exempts from the limit need their own test per carrier, kept apart so a mutation names which rule broke.

## When a formatter stops truncating, re-point every test that used the cut as its signal - 2026-11-15

Dropping the viewer's blanket cut left click tests that told calls apart by a long command's tail: vacuous, not red. Grep the suite for long-argument fixtures whose presence is the observation, re-point them to a presentation that still changes, and assert both directions (absent while collapsed, present after the interaction). Deleting a user-visible claim needs the same pass: grep every committed pin of the phrase and re-point each in the same commit, as a positive claim about what is now true. An absence-asserting test needs a mutation that would add the thing; if none can, the guard is structural.

## A fixture that is the output of this repo's function must call it - 2026-11-15

Hand-written content invented a separator `getStatusNote` never emits, so "shows the reply line for a stopped agent" passed while a real one-line reply put the whole note on the only preview row. Build such fixtures through the producing function plus the shared record factory, hand-write only shapes fabricated on purpose, and probe both settings of a new strip or gate (always-on and always-off) so the over-stripping guard exists beside the leaking one.

## A read-only guarantee needs arguments the rewrite would change - 2026-11-15

Put in the fixture exactly the shapes a presentation rewrites (home-directory prefix, trailing blank rows, text past the collapsed preview) and prove the test with a write-back probe per shape. Assert the session's own array identity alongside a deep clone: a presentation that filters in place leaves the data equal and steals the agent's context.

## Produce a presentation value where the parts are still separate - 2026-11-15

`replyPreview` is built in `buildAgentDetails`, where reply, appended note and envelope are still distinct, and every surface renders it unchanged. Earlier attempts reconstructed it from composed text and each produced a defect: a reply opening `Error: ` lost its row, a one-line stopped reply showed the whole stop note, a stored `status` of `toString` cut real prose, and a producer-side `.trim()` had to be pinned at another module's boundary. Before keeping a fallback parse for older records, check whether the feature was ever released; if not, render nothing for them.

## A default lives wherever a caller may omit the value - 2026-11-15

Flipping an effective default is not one line: grep the key across `src` and `test` and flip the stored-value resolution, the component's own option default, the test store mirror and the doc comments naming it in one pass. Pin each layer and give it a triangulating partner (absent means on, an explicit false still means off) so a stub cannot pass both.

## A footer hint takes its key from the resolved binding - 2026-11-15

Build it from the resolved binding, omit it entirely when the action is unbound (no dangling separator), and abbreviate only modifiers you can name. Re-check every width branch the string passes through and end the preference ladder with a rung that renders nothing: the last rung previously showed the actions unconditionally and truncated the group the ladder protects.

## A user-enumerated default list is the user's decision, not the builder's - 2026-11-15

Change membership only when the user names the new member; when code, docs and the issue disagree, fix the text that drifted in the same pass. Before flipping membership, grep every site that pins the list (config default, resolved-view tests, menu labels, mock store mirrors, docs) so one commit moves all of them.

## State a wire rule at the surface its reader consumes - 2026-11-16

A "no output" rule written as key presence was true of the server's event serialization and false of GET, whose key set is fixed for every run state. Put the forbidden form next to the allowed one (`payload.result == null` yes; `'result' in payload` / `Object.hasOwn` no), read it together with `status` because several states share an empty slot, and name the surface in the sentence. When an upstream owner withdraws a requirement you filed, correct the requirement, its criteria and the fixture list in one pass, then grep this repo for the old vocabulary.

## Measure a transport fact instead of inventing a signal - 2026-11-17

The workflow API has no end-of-stream event and no `retry:` hint; the connection close is the end signal and can arrive mid-run. A close means "observe again", never a state, and a client that hangs settlement off an invented frame cannot distinguish "run over" from "follow ended". The live loop forwards a fixed list of message types with a catch-all, so every type missing from it is invisible until a reconnect; a live id is not a journal position (ids separated durable from ephemeral frames, never replayed from live). Duplicate delivery needs no dedupe when settlement is already exactly-once: say "a frame is a trigger, never a countable occurrence".

## A recorded identity is not a check - 2026-11-17

Ask who would act on a recorded server revision and when; "an operator comparing a SHA after the fact while the branch moves" means the record is documentation theatre. State the requirement behaviourally plus one runtime check (a completed run answering the retired marker is a tool error naming the endpoint), delete the recording duty, and correct the acceptance criteria, manual-test steps and Definition-of-Done lines too: a requirement removed only from prose comes back as "good practice". When you write "covers every X", write the residual in the same sentence. Keep "the contract is defined" and "the implementation shipped" separate: client work resumes once the contract is, while only the live gate and the recorded-real fixtures stay blocked.

## Recorded wire fixtures are captured bytes with a per-file evidence class - 2026-11-19

Capture with `mix run --no-start`, the real Plug router and the project's own SSE loop, and return frames with their terminator (`map(f => f + "\n\n")`) so a concatenation is the stream a real `fetch` consumer reads. Classify each file in code a test cannot route around: name the contract-derived files and refuse them at the captured accessor, so a later real capture fails the stale label. Handcrafted shapes had encoded an `error` field where the API sends `reason`, dropped the `event`/`ts` keys a live lifecycle frame carries, and claimed CRLF that `format_chunk` normalizes away. Pin the double you still construct against the capture at fixture load, and note the producer revision as provenance, never as a support floor.

## Every end-of-connection trigger must resolve the wait - 2026-11-19

Close, silence, terminal frame and caller cancel are events; run the body reader as a task beside them, because aborting a controller does not wake a push-based fake that stopped yielding. Assert the cancellation reaches the transport (`init.signal.aborted` in the fetch fake). Separate handles by lifetime: `finish()` stops the deadline, `close()` ends the request, called from the reader's `finally`. Otherwise one call removes the caller's abort bridge and every reconnect opens a second live connection beside the one it replaced.

## To pin a trigger, remove its competitors and mutate the trigger away - 2026-11-19

A test whose endpoint closes right after the terminal frame proves nothing about the frame: EOF fires the same read, and deleting `"reconnect"` from the reconcile set left the suite green. Keep the connection open and the silence window unreachable, assert the read count around the push, and where two scenarios answer identical bytes pin the input that separates them (`whose signal aborted`) and mutate the guard that reads it.

## A narrowing condition needs its near-miss value - 2026-11-19

Put a value on each side of the line: the marker, and a declared output carrying the marker's key plus one more. Relaxing the condition to "carries the distinguishing key" kept 48 tests green while the real effect was refusing a legitimate answer. Where a test name contains a count, assert the count; a criterion naming a plural needs a fixture with more than one and a needle that appears nowhere else in the message.

## Witness the event, don't poll for it - 2026-11-19

Let the test endpoint expose the event (`socket.on("close")` into a deferred the test awaits): faster than `vi.waitFor`, no timeout to guess, and it fails the same way when the behaviour is missing. Where the evidence is an appended history, test the history: check it before waiting and again in the `catch`, and pin live-only content by what must be absent later, because a partial and a settled result can render the same text.

## Fake timers leak, and the fake clock jumps over unscheduled work - 2026-11-19

`vi.useRealTimers()` belongs in the file's `afterEach`; a test that passes alone and times out in the file is an ordering dependency, not a slow test. `advanceTimersByTimeAsync(90_000)` fires nothing when the loop is still awaiting real I/O and arms its timer afterwards: wait for a meaningful milestone (the first GET), drain continuations with `advanceTimersByTimeAsync(0)`, then step, sizing the budget from implementation constants and never shrinking an assertion to fit the clock.

## Registering a tool reaches surfaces beyond its own module - 2026-11-19

`test/index.test.ts` pins the registered tool names and the dot-description convention (`description: "."`), so a new tool breaks it in the same pass; name the convention's scope in the test title when a tool legitimately leaves it. `pi.registerTool` replaces by name and calls `runtime.refreshTools()`, so re-register only on a real schema change, comparing the exact text the schema carries. pi has no `unregisterTool` and `registerTool` returns `void`, so an on/off setting for a tool is honest only as a restart-required flip; OFF is safe across resume because a call to an absent tool becomes the error result `Tool X not found`. To pin "scans once, on miss only", `vi.spyOn(fs.promises, "readdir")` works where src calls `fs.promises.X` (property lookup at call time); spying the builtin namespace object itself does not.

## A git worktree of this repo has no installed dependencies - 2026-11-19

`test/agents/pi-builtin-registry.ts` reaches into `<repo>/node_modules/...`, so a buildtree dies with module-not-found that looks like a regression. Read the failing path: an absolute worktree `node_modules` path is the environment. Run those files at the base commit in the main checkout before calling them a regression.

## A kind-aware display name is a wording change in every surface - 2026-11-18

`AgentStatus`, the `/agents` menu row and `MessageAgent`'s "Known agents:" name a record by its raw type; the widget and both viewers use `getDisplayName`. Read what each call site printed before routing it through a shared helper and pass it in (`recordDisplayName(record, name)` overrides only the new kind).

## Before removing a user-visible claim, check what outlives it - 2026-11-18

The reload notice counted every active record, and dropping the kind nothing was sent to would have left it silent about a run still executing: `session_shutdown` disposes the manager, so the record holding the remote id dies with the same reload. If the detail the claim wrongly asserts lives only in memory that dies here, replace the claim with the truthful one instead of deleting it, and verify "the record still shows it" by finding where the record is constructed.

## An early return for a degenerate value swallows the annotation beside it - 2026-11-19

The terminal-result formatter returned the no-output note as soon as text was empty, so `termination_reason` was never appended, exactly the case where the note carries all the meaning. Compute the must-survive parts first, compose last, and check the producer's emitting path before calling an edge value hypothetical (the terminal-tool path completes with `""`).

## A whole-state display contract is pinned per published state, per forbidden shape - 2026-11-18

Assert the full published array of every published state, not the last snapshot and not one channel, and put the criterion's own property first so it fails with its own message. List the forbidden shapes before writing the pin (a view shared across connections, an accumulator publishing previous-plus-new) and check each trips an assertion; an assertion no shape can trip is decoration. A repeated delivery must advance in at least one field, or a deduplicating merge has nothing to show.

## A returned value can be the record's value and still not be the record - 2026-11-20

`runWorkflowForeground` derives its flag and its text from the record, so a tool-result assertion proves nothing about which slot holds the text. When a criterion names a stored field, read the record on the path that stores it and name the slot: status, the one field carrying the text, and the sibling undefined. Then mutate the store (swap error/result), and on the read side remove the record from the expression: a `record.error ?? record.result ?? ""` over a call-content fallback survives deleting `record.error` entirely.

## Read a discriminant into a local once - 2026-11-20

Deriving every condition from that local makes the conjunct that cannot fail disappear by itself, and deriving the payload from it (`event === null ? null : parse(data)`) removes the paired guard and skips a parse on the busiest channel.

## Before writing a small formatter, grep `src/` for the rule's artifact - 2026-11-20

Search for the ellipsis codepoint, join character or cap, not the helper's name: a private helper in a shared module is still the codebase's answer, and exporting it is smaller than a second spelling. A field a test fixture writes that no test reads is dead code. Before refactoring a limit nobody can see, check it has a pin; if not, add the boundary tests against the old code first.

## A run's lifetime must be claimed before the first outbound call - 2026-11-20

`dispose()` visits records, so a run that registers only after its create POST returns is invisible during that window: a shutdown then let the late answer register into a dead manager and send a remote stop. One ownership object, taken before the request and released when local observation ends, makes late registration, publication and remote stop impossible rather than individually guarded. Keep a failed read out of the terminal outcome too: an HTTP 401 on a state read reached `settle("error")` and answered "already terminal" while the run was still executing. Only the authority's terminal status, an acknowledged stop or explicit local shutdown end a lifecycle; a result type with no `error` case cannot be settled from a rejection.

## In layered config, an invalid value must never be erased into absence - 2026-11-20

`{"anagen-x.local": {url: ""}}` dropped the entry and the built-in merge restored a target nobody named. A value that selects a resource survives validation as a value and is refused at the seam that resolves it. A declared value wins and an absent one inherits (`"url" in entry`, `=== undefined`, never `??`, which erases an explicit `null`), so pin the inheritance case next to the override case: the inheritance test is what catches the fix. Audit the whole entry-point list in one pass (both validations, both merges, the defaults merge, the store getter, the resolver, the tool), and warn only about paths the layer it validates can cause, once per load, from the read that is allowed to speak (`WarningSink` as a parameter, `load({ report: false })` for the shell's eager store). Never add a suppression flag to a shared reporter.

## Redaction runs before the cut, on both sides of the comparison - 2026-11-20

Sanitize, remove the secret, then bound: a rejection body longer than the cap exposed the key's first ten characters because truncation ran first. Normalize the needle the same way as the text, or a key carrying a control character is unfindable. For each "it is redacted there" claim, name the test that fails when that line is deleted; `workflows/public-text.ts` is the one factory, with `shown` and `bounded` naming what each surface does.

## A display rule keyed to the wrong unit latches - 2026-11-20

The stream view held text channels per node and chose by permanent precedence, so on a run that calls a tool the visible text froze on the first turn and every later frame was dropped. Name the unit the view selects for (node, attempt, turn) and key the state exactly that: closed turns plus one open turn per attempt. Write the second unit of every kind (second turn, second attempt, second source) before the fix, because the first unit cannot see a latch, and derive ordering facts from the producer's emission site, not from a fixture's frame order.

## A credential's derived forms are a configuration problem, not a matcher problem - 2026-11-21

A credential can only come back on a path this client's own configuration put it on, so refuse the configuration instead of enumerating the forms it can be echoed in: a base that carries `%` or `+`, or a create answer whose id is not `encodeURIComponent(id)`, makes the assembled target literal by construction and one `target.includes(key)` completes the guard. Share `runRoutes` with the real requests so the check cannot fall behind the target, and name the gate each entry owns: `create` judges the id it was answered against the credential, `monitor` and `stop` refuse only an id that names no route, and a stricter gate on one path widens the set arriving un-gated at the others. Pin the case that must stay byte-for-byte unchanged, because that is what stops the next round from widening the guard into a ban on escapes. Percent-encoding is not a segment guarantee: the encoder leaves `.` and `..` alone and throws on a lone surrogate. Judge the assembled target, never the contained value, and when a fix adds enumeration to a guard, re-open the mechanism rather than refine it.

## Pi settles the active turn before `session_shutdown` - 2026-11-21

So ending a session does stop its bound run, the opposite of "disposal sends no remote stop". Pin the two events separately: the parent-interrupt binding stops a bound run exactly once, and the disposal path adds no second stop and publishes nothing into the dead session. Re-measure any claim that a mutation is uncatchable. (`AgentSession.dispose()` does not emit `session_shutdown`.)

## A handoff the user's Esc can empty is not a handoff - 2026-11-21

`deliverAs: "steer"` queues into a queue `clearQueue()` empties, and pi restores only the user's own typed text from it, so an extension's custom message is dropped without a trace. `sendCustomMessage` with `triggerTurn: false` and no `deliverAs` while the parent is busy commits the message at the turn's end on every exit path; `{ triggerTurn: true }` starts a turn when idle. The host tests `triggerTurn !== false`, so omitting the key selects the queue and the `false` must be written down. Pin the exact options object (`toEqual`; mutation: re-add `deliverAs`), and prove the host half against a real session: a fake of the host proves the model, not the host. To drive that, a faux `streamFn` plus a `baseToolsOverride` tool that resolves on abort holds a real turn open, `convertToLlm` and `registerProvider(id, {apiKey})` are required, and a timer must be pending or node exits on the unsettled top-level await.

## A committed notification is not a model turn - 2026-11-24

`triggerTurn: false` commits a busy-session notification without waking the model, and `triggerTurn: true` while busy sends it through a queue Esc can empty. So a temporary `turn_end` handler sends the durable message and requests continuation together at the boundary; a batch that missed that boundary wakes the idle session from `agent_settled`; and the handler stays temporary because pi builds a session projection (an in-memory `SessionManager` plus `buildSessionProjection()`) at every `turn_end` that has a handler, so one left installed taxes every turn. Verify both the saved entry and the next provider request with a real pi session: a mock `sendMessage` call proves neither.

## A closure can run before the variable it reads exists - 2026-11-22

The teardown branch read a `const record = ownership.register(...)` declared later in the same body, from a hoisted `function end()` handed to the manager before the create request was awaited: `Cannot access 'record' before initialization`, and TypeScript could not narrow it inside the closures either. Anything reachable from a teardown, abort or dispose callback is declared before the first await as state. Prefer a boolean flag (`let recorded = false`) over a second alias for the same object: the flag states the constraint, the alias hides it.

## An optional short form means the diagnostic fallback owns the note - 2026-11-22

`ack.refusal ?? ack.error` put a diagnostic naming the endpoint and URL into a model-facing note on every arm where nothing answered. Prefer required short form plus a separate long diagnostic, and pin the exact composed string where it is composed. If the long form keeps no production reader, give it one or stop claiming a path reads it.

## A word-ban must name the slot the claim would live in - 2026-11-22

`/stop failed.*unknown/i` and a bare `/stopped/i` can be satisfied, or tripped, by the note's own honest wording; pin the slot (`/\)\s+(stopped|error|completed|failed)\b/` for a listing row) and prove the ban bites by mutating the note back to the false claim. A clause appended outside a per-arm branch is a claim about the union of the arms, so check it against the worst arm (`HTTP 409: workflow is not running` beside "still running remotely"). When a criterion names copy that another clause of the same document forbids, the criterion is the defect: change it, record why, and re-audit wording whenever a new reader is added to the note.

## A live pane's evidence is the repaint it asked for - 2026-11-23

A "follows the live source" pin written as mutate-render-read stays green after the refresh interval is deleted, because `render()` re-reads the source. Pin `tui.requestRender` after the clock advances, and the frame's content separately. Only timer-driven repaints must ask: pi-tui calls `requestImmediateRender()` after handing input to the focused component. Prove a cross-surface equality pin by truncating one side; a `slice(-2)` that leaves it green means it compared two fixtures, not two surfaces.

## A byte-equality pin between two spellings decides which one can carry new information - 2026-11-23

A criterion asking a surface to carry a new label could not pass while `displayRows(items) == progressLines(items)` was pinned: grep for equality pins between the surfaces that spell the value first. And when you turn a return into a throw, grep every caller in the same pass: `SelectList` calls `onSelect(item)` with no `await` and no `.catch`, and no installed pi package handles `unhandledRejection`, so a rejection from a menu callback ends the process. Every async menu callback owns its own failures.

## Type a viewer to the structural source it reads - 2026-11-23

The viewer reads entries, one subscription and optional context-usage getters, so typing its constructor to that `TranscriptSource` lets an `AgentSession` satisfy it with no adapter and lets a run's snapshot satisfy it through a getter. `subscribe` declared method-style accepts a listener taking `(event?)` (parameters are bivariant); `wrapTextWithAnsi` re-opens the colour on every line it produces, so a coloured row survives the wrap. A poll is a signal waiting to be named: find the path that already writes the value and let it tell the watchers. When a review reversal is decided, delete the alternative outright and re-apply the base version of anything it had absorbed.

## A view's freshness key must cover everything it paints - 2026-11-23

Memoising rows on one field's array identity rested on two unstated rules (every publish assigns fresh, everything painted lives in that array) and broke when a settlement arrived with no new snapshot. Rebuild inside the subscription the record already emits, so no array identity is load-bearing, and ask what a view asserts once the record is terminal.

## A dependency limit cited to justify a design is a claim - 2026-11-23

"`renderResult` returns a `Text`" and "it composes before pi knows the width" were both false: `renderResult` returns `Component`, and pi's own `Box` pads every child line with `toolPendingBg`/`toolSuccessBg`/`toolErrorBg`. Open the installed `.d.ts` and the render path, quote `file:line`, and state the real tradeoff.

## A borrowed row look must not inherit the host model's capabilities - 2026-11-23

Faking `assistant`/`toolResult` messages to borrow `renderToolCall` buys a click target, a duration, a tool name, and the compact layout's grouping acting on a node name. Reuse the paint instead: carry a title, a state and body lines, map the state onto the same three background roles, and extract the body fold with the parameter that varies. Then treat every footer hint as an assertion the view can honour: guard the hint and the key with the same predicate.

## A green suite after touching an uncovered line proves nothing - 2026-11-23

Folding a pad-and-fill expression into a helper kept all 937 `test/ui` tests green, and so did replacing that footer's text with `PROBE`: no test renders that footer. Mutate the expression being extracted and read the `FAIL` lines before believing the run. An idiom that repeats at N sites gets extracted at all N or none; a partial extraction adds a name and leaves the duplication.

## A state-to-treatment mapping is pinned per surface - 2026-11-23

Each surface has its own mapping table and its own fixture, so a sibling's coverage proves nothing: one criterion named four node states and the details view's fixture carried three, through rounds of green. Cross the width in the fixture (a name shorter than the render width cannot tell wrapping from truncation), mutate that surface's table, and report the run's `FAIL` lines. Zero red means the pin exists nowhere, however many sibling pins pass.

## Work inside an overlay's `render()` is paid once per frame - 2026-11-23

pi composites every visible overlay each frame (16 ms floor), so wrapping a 2,000-line error body in `render()` cost 40,000 `wrapTextWithAnsi` calls and 19.6 ms per frame against 1.5 ms after the change. Anything O(all text) belongs behind a cache keyed on the inputs it depends on, and the invalidation key needs its own pin: no scroll or wrap test can see a stale cache. For a steady-state refresh, warm past registration and the first paint, count the expensive boundary calls for one unchanged tick, then change an input and assert what the user sees.

## Which component owns a fill decides where colour may be added - 2026-11-23

A registered message renderer receives no fill (`CustomMessageComponent` keeps its `customMessageBg` for the default rendering only), while `ToolExecutionComponent` sets `bgFn` and `Box.applyBg` pads every child line, so `renderCall`/`renderResult` output arrives already filled. Name the component that owns the fill on every surface before editing one line, and pin the role at the seam (mock `Box`, capture its `bgFn`), because an exact escape-byte pin cannot tell one role from another. A row padded to the render width needs the recording theme above.

## A per-status claim about the host is a claim about every status - 2026-11-23

The card's fill follows its own status mark's colour while pi reddens a row only when the call's own result is an error, so `aborted` diverges. State the rule plus a named exception rather than an equivalence: the rule is checkable from one file and the equivalence breaks silently with the next status. The same test applies to a test name; a fact that needs another repo's source to see does not belong in it. A measured "unchanged" claim comes from base output (`git show <base>:<file>` into a scratch file, old against new over every captured stream), never from a shape assertion.

## A reserved slot needs an owner before a run promise exists - 2026-11-24

Reservation must precede callbacks that could start another run, but synchronous setup can throw before attaching the promise that releases the slot: release it on that path, and test that the next queued record actually starts rather than that the failed start was reported.

## A widened scope is a deviation to approve, not a detail to carry (pipeline) - 2026-09-04

When the builder covers more than the issue listed, say so as a deviation and get explicit approval before merge: an accepted widening explained at review reads the same as one nobody noticed.

## A refactor loop that never returns NOOP is diminishing returns (pipeline) - 2026-09-04

For a validation-heavy issue, repeated REFACTORED rounds up to the round cap with no NOOP closeout are diminishing returns, not blockers. Cap the expectation and close out instead of adding a round.

## Never cd into the issue worktree (pipeline) - 2026-09-21

An orchestrator whose cwd is a worktree the merge agent later removes loses every Bash call (`spawn /bin/bash ENOENT`), test gates and subagent commands included: run everything with `git -C` or absolute paths from the main checkout for the whole pipeline. Before spawning a merge agent, `git status` in main for local modifications overlapping the branch and stash just those files, popping after MERGED.

## A returned review is not a written artifact (pipeline) - 2026-09-21

`ls` the output dir before spawning a builder fix round: a reviewer's claim that it wrote `review-1.md` is not proof, and a verification-only pass costs a whole round. When the text came back in the final message, persist it verbatim and re-run the fix step rather than re-reviewing.

## An approved slice's prediction about a later slice is not a contract (pipeline) - 2026-11-23

A fix report's sentence about what a later slice will do to a pin is a prediction. When a merge goes red, read the state the surface reads on that scenario's real event order before touching an expectation, and name the committed pin the answer satisfies.

## Verify a history or tracking premise before acting on it (pipeline) - 2026-11-23

A merge prompt's premise is checkable: `git merge-base A B`, `git log --oneline B..A` and `git reflog show A` settle whether a conflict is reachable or a surface was un-merged by a later reset. Before letting "it is gitignored" justify leaving a change uncommitted, run `git check-ignore -v <path>` and `git ls-files <path>`: a dirty mainline is merge input, so commit the stray edit as its own commit first and resolve the clash as a union.

## When three rounds return one concern, escalate (pipeline) - 2026-11-15

Stop the fix loop and put the choice to the decision owner (amend the criterion and pin the producer invariant, or carry a second data path): a fourth round repeats the guess. Keep the criterion wording in the same edit as the decision that supersedes it, or the next reviewer re-litigates it.

## A delegated manual gate that fails twice gets driven once by hand (pipeline) - 2026-05-04

A third round of the same prompt tests the prompt, not the code. Capture the failing command's own output first (`pi ... --print x` prints every load error at once), and check the harness can reach the state: curl the routes the client actually speaks and time one run before demanding a mid-run observation.

## Manual gate harness mechanics, pi plus tmux (pipeline) - 2026-11-21

`pi -e <checkout>/src/index.ts` loads nothing when that checkout is already discovered: both copies conflict on every tool name (`Tool "Agent" conflicts with ...`), so use `pi -ne -e <path>`, and link the main checkout's `node_modules` into a throwaway build first. For the workflow endpoint, start it detached (`nohup mix run --no-halt > log 2>&1 &`) and poll `GET /api/workflows/unknown` for its `404`; a foreground start dies when the tool timeout fires. Read colour from `tmux capture-pane -p -e` (truecolour bytes); force monochrome by copying the theme JSON with every hex set to one grey, because `NO_COLOR=1` proves nothing. A cancellation window needs a long node chain, not an echo graph (a 40-node echo chain finishes in about a second).
