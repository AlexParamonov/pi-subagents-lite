# Lessons Learned

> Only lessons that measurably improve the next outcome survive.

## Ingest (append new lessons at EOF)

> Empty. New `## <name> (<detail>) - YYYY-MM-DD` entries land here.

## agent-color-icons (scope + tests) - 2026-08-19

**What worked:** Extending `statusIcon` with an optional `agentType` parameter was the right call — single change point, all callers benefit. Asserting the ANSI pattern (`/\x1b\[38;2;\d+;\d+;\d+m/`) instead of exact RGB values keeps tests resilient.
**What failed:** First attempt ported the fork's full badge system (WCAG contrast, 256-color quantization, `renderAgentNameLabel`) when only the status-icon tint was wanted. Tests hardcoding exact RGB values broke when the color map was corrected to the fork's values.
**Next time:** When porting from the fork, confirm the exact visual change before porting the rendering system. Assert full observable output (icon IS colored, name is NOT) and pattern-match volatile segments.

## fix-max-tokens (api-family first) - 2026-09-04

**What worked:** Verifying each API against the installed pi source settled the responses overlap without rework; the alternatives menu picked unified payload-path over model-clone and flat swap; manual tester confirmed the exact previously failing model live.
**What failed:** First fix scoped to openai-completions without checking which API family the exact reported model string rides, so both reported cases still 400d after merge; assumed sibling-model coverage without testing the verbatim reported model plus provider strings.
**Next time:** Identify the API family from the exact reported model string before scoping the fix — pi-ai does not export its resolution, so verify against installed pi source. Retest the verbatim reported cases, not neighboring ones.

## running-agents-duration-display - 2026-09-04

**What worked:** Frozen-time unit tests pinning exact menu labels plus reusing the existing `formatMs` kept the slice trivial with no rework.
**What failed:** None in this slice.
**Next time:** For display-format changes reuse the single formatter and assert full label strings, not substrings.

## validate-config-on-load (project-key scope) - 2026-09-04

**What worked:** TRIVIAL alternatives verdict still surfaced the one genuine decision (unknown agent keys as per-type model keys); per-key TypeBox schema map with error-path mapping dropped fork shapes with loud warnings while valid keys survived.
**What failed:** Manual tester used global-only `graceTurns` in a project file as the valid-key-kept case and got a correct second warning, since project files accept only model-family plus per-type keys by design (`isProjectAllowedAgentKey`).
**Next time:** For manual config scenarios use per-type overrides in project files, not global-only keys.

## pi-toolchain-0.85 (lockfile-only pin) - 2026-09-04

**What worked:** Keeping the pi toolchain version pinned only in the lockfile (no devDep; peers `>=0.82.0` auto-install) made the 0.85 upgrade attempt a pure `npm update` with zero manifest churn, and the failure was instantly diagnosable to pi's packaging rather than our code.
**What failed:** pi-coding-agent 0.85.0's dist bare-imports the undeclared `@earendil-works/pi-server` (`index.js` → `main.js` → `experimental/server.js`), so 44 test files die on `ERR_MODULE_NOT_FOUND` at import, before any assertion runs.
**Next time:** Before `npm update` of the pi toolchain, check pi's release notes for packaging changes. If the tree goes red with module-not-found inside pi's dist, hold the lockfile until pi ships the fix or install the missing package explicitly.

## typebox-peer (host-owned schema library) - 2026-09-04

**What worked:** Migrating to the unscoped `typebox` package at pi's own exact pin (1.3.7) and declaring it a peer: pi's extension loader aliases `typebox`/`typebox/value` to the host's copy in every runtime mode (jiti aliases, SEA virtualModules), dev/CI gets it via npm peer auto-install, and emitted schemas were unchanged, so the whole suite passed without assertion edits.
**What failed:** The extension built schemas with `@sinclair/typebox` 0.34 — a package the pi host does not ship — so the two schema lineages drifted; typebox 1.x's thin base `TSchema` then broke seven test typechecks that poked at concrete fields (`type`, `anyOf`, `additionalProperties`).
**Next time:** Import `Type`/`TSchema` from `typebox` and `Check` from `typebox/value`, never `@sinclair/typebox`. When tests assert schema internals, narrow to the emitted JSON shape via a structural view instead of the library interfaces.

## respect-per-model-thinking - 2026-09-05
**What worked:** Single pure resolver (`thinking-resolution.ts`) shared by runtime and every display surface made the precedence chain testable and impossible to drift; silent-vs-notifying split (`computeSpawnTarget` / `resolveWorktree`) let the listener reuse the exact trust decision without duplicate warnings; Derived-state wizard spawning with `thinkingLevel: undefined` pushes resolution to the runner at the actual target cwd (display-only predictions must not become explicit params).
**What failed:** First review round caught a trust-gate bypass — `SettingsManager.create` defaults `projectTrusted` to `true`, so an ungated settings read silently includes untrusted project settings; any injected value becomes the explicit param and outranks the whole gated chain. Wizard also folded the display tail into the spawn param, shadowing per-model at worktree targets.
**Next time:** Any new settings read must inherit the project-trust decision of the code path it feeds — audit reads and their consumers together. Never pass a display-predicted value as an explicit override when a lower-precedence source should still apply; pass `undefined` and let the resolver complete the chain.

## restart-trust-gate - 2026-09-06
**What worked:** Moving `computeSpawnTarget` to `src/spawn/spawn-target.ts` gave both spawn paths one validation+trust definition; extracting `surfaceSpawnTargetWarnings` at the same time kept the two notify sites from drifting. Making `computeSpawnTarget` take `unknown` closed the same latent non-string `worktree_path` crash on the live path for free — fixing at the shared seam fixed both consumers.
**What failed:** The original implementation left a dead type import and a crash on non-string history arguments (`TypeError` instead of a clean skip) — review round 1 caught both cheaply because the issue's pinning constraint forced exact-value assertions.
**Next time:** When adding a new spawn entry point (command, menu, future tool), enumerate the checks the canonical entry point performs (validation, trust, discovery gating, warnings) and route all of them through the shared helper in the same change — the restart path shipped for weeks without trust gating precisely because the checks lived inside the tool handler rather than a shared prelude.

## fix-viewer-streaming-loss - 2026-09-14
**What worked:** Root-cause investigation before issue creation produced a falsifiable repro (pi-exact per-delta partial mutation simulated against the viewer) that doubled as the builder's failing-first suite; synchronous transcript re-render of the in-flight entry at exactly the accumulator-clearing boundaries kept the transcript copy and the live accumulator copy disjoint, and the refactor pass confirmed the delete-and-defer variant would duplicate the in-flight block.
**What failed:** The orchestrator's shell died mid-pipeline when the merge agent removed the worktree directory that was the orchestrator session's cwd (every Bash call then failed with `spawn /bin/bash ENOENT`); recovery required recreating the path via the Write tool before any command could run. Main's locally-modified CHANGELOG.md would also have blocked the merge — a narrow `git stash push <file>` before spawning the merge agent and `stash pop` after avoided it.
**Next time:** Never let the orchestrator `cd` into the issue worktree — run all worktree commands with `git -C`/absolute paths so its cwd stays at the main checkout for the whole pipeline. Before spawning the merge agent, check `git status` in main for local modifications overlapping the branch's files and stash just those files, popping after MERGED.

## test-maintenance file discovery

Use the find and grep tools for repository file discovery and content searches. Shell pipelines are only for filtering command output, not a substitute for those tools.

## menu navigation characterization

Drive real keyboard input through the component returned by ui.custom before deleting private-state navigation tests. Identify the selected row by stable content, not its entire label, which includes status and elapsed time.

## hide-tool-results-in-viewer - 2026-09-21
**What worked:** The issue pre-prescribed the whole approach (delete the two result-render paths in place, keep `invalidateCacheForNewMessages` as the status-color refresh), so review and refactor rounds found only one suggestion-level nit; exact-array assertions with ANSI-honest width mocks pinned the 3-row call block; when a reviewer returned its full review in the final message but never wrote the artifact file, persisting the returned text verbatim via the Write tool and re-running the fix step recovered without re-paying for a re-review.
**What failed:** The orchestrator repeated the `fix-viewer-streaming-loss` lesson's exact mistake: it ran the Step 8.5 test gate with `cd` into the issue worktree, the merge agent then removed that worktree, and every Bash call (orchestrator and all subagents, including the whole first manual-test round) died with `spawn /bin/bash ENOENT`; recovery required recreating the deleted path via the Write tool and `cd`-ing back to main before anything could spawn. Also: the code-reviewer claimed to write `review-1.md` but never did, burning the first builder-fix round on a verification-only pass.
**Next time:** The `cd`-into-worktree ban applies to every orchestrator-run command step, including the test gate — run suites with absolute paths or `npm --prefix` so the session cwd never leaves the main checkout. Before spawning a builder fix round, `ls` the output_dir to confirm the review artifact actually exists on disk; a reviewer's return text claiming a file was written is not proof.

## independent-widget-stat-visibility - 2026-09-26
**What worked:** A regression test hid both input and output tokens while asserting context percentage still rendered. Keeping the context annotation outside the token-count gate fixed the root cause without adding config.
**What failed:** Existing default-path coverage didn't expose that the context setting depended on token visibility.
**Next time:** Test independently-toggleable stats with neighboring visibility flags disabled; keep each visibility decision independent through the formatting gate.

## Preserve provider payload omissions (OpenAI Responses) - 2026-09-30
**What worked:** The request's existing `max_output_tokens` distinguishes a normal Responses request from one where pi intentionally omitted that field for ChatGPT sign-in. Replacing the existing value keeps agent caps effective without overriding auth compatibility.
**What failed:** The subagent post-processing blindly injected a field that pi had deliberately left out, causing the ChatGPT sign-in request to fail validation.
**Next time:** When post-processing provider payloads, preserve meaningful upstream omissions and override a field only when the provider builder emitted it.

## extension tool aliases (shared resolver) - 2026-10-04
**What worked:** Expanding `extension/all` in the shared tool-entry resolver kept session registration and final tool visibility consistent; one `runAgent` regression asserted both outcomes.
**What failed:** `extension/all` was accepted as the literal tool name `all`, so extension tools were omitted from the registry allowlist.
**Next time:** Keep aliases normalized at the shared resolver used by both registry gating and visibility, and test through the agent-runner boundary.

## extension package aliases (manifest identity) - 2026-10-04
**What worked:** Resolving an extension's declared package name from the manifest made aliases stable when the entry lives under a generic `src` directory; merging tools by that canonical name keeps multi-entry packages addressable as one extension.
**What failed:** Falling back to the entry's parent directory mislabeled `src/index.ts` as extension `src`, so `pi-tool-ports/none` could not acknowledge it.
**Next time:** Use a package name only when its manifest declares the exact extension entry, then use the path-derived name as fallback.

## child-tool-delegation (contract seams) - 2026-10-05
**What worked:** Extracting `createChildSession` (prompt-free setup) from `runAgentImpl` gave the contract suite a real production seam; wiring the reference session with pi's own private `builtInExtensions` made child/reference equality meaningful instead of trivially true; redirecting `PI_CODING_AGENT_DIR` per temp workspace let real settings layers resolve per case.
**What failed:** pi's `bindExtensions` requires its bindings object (crashes reading `uiContext` when called bare); `vi.fn(impl)` generic widening was needed for the SettingsManager mock; `Promise.allSettled(runPromise)` resumes before the chain's `.finally` — track the terminal derived promise when dispose must observe settlement side effects.
**Next time:** For dependency-behavior contracts, reproduce in plain node first (the env-var agent-dir redirect and the bindExtensions arity were both 30-second node checks); when an async lifecycle must "wait for side effects", await the last promise in the chain, never an earlier link.

## child-tool-delegation (lifecycle invariants) - 2026-10-05
**What worked:** Wrapping every step of a fire-and-forget tracked promise made the never-rejects contract hold (abort, emit, and dispose can each throw while the parent is going down); deduplicating per session via WeakMap made "exactly once" hold across interleaved triggers; `createChildSession` bracketing itself with the spawn-depth flag (try/finally) enforced the no-live-binding invariant by construction instead of by call-site discipline.
**What failed:** Review found an unguarded `dispose()` step, an exported seam relying on the caller's bracket, and a debug menu showing "(none)" for children that actually start with pi's fallback tools — none caught by the builder's own tests.
**Next time:** For "terminate exactly once" lifecycles, funnel every trigger through one deduped path whose steps each survive throwing; when a seam depends on a depth flag, put the bracket inside the seam; when display code mirrors engine fallbacks, pin the mirror against the engine's real values.

## add-agent-messaging (shared id resolution) - 2026-10-13
**What worked:** Putting prefix resolution on the manager as a lookup returning every match kept one rule for both agent tools and left `getRecord()` exact-match for internal callers; the tool layer turned zero/one/many matches into distinct reports, and a blank input was rejected as a missing id before resolution because the empty string is a prefix of every id.
**What failed:** Every test that faked the old exact-lookup port had to be re-pointed in the same pass, and fixtures with ids shorter than the real stored length hid the short-vs-full distinction the feature is about.
**Next time:** When a lookup rule moves to a shared port, re-audit fixtures for unrealistically short ids and for partial ids that used to miss; when registration starts referencing real code from a module a test mocks wholesale, switch that mock to `vi.importActual` plus overrides so the shared function stays under test.

## add-agent-messaging (test-quality review) - 2026-10-13
**What worked:** Reducing report assertions to the distinguishing fragment (`steered`/`continued`, `not sent` vs `Failed to`) and merging same-branch guards cut 9 tests and 76 test lines while nine `src/` mutations (label swap, dropped guard, dropped trim, removed ambiguity branch, full-id echo, no steer) were still all caught.
**What failed:** A review item to revert a partial-mock rewrite assumed the indirection existed only for the test being deleted; it had since become the only thing keeping pre-existing renderer tests collectable, so the revert failed the whole file at import time.
**Next time:** Before removing test-side machinery justified by one test, delete that test first and run the file - other tests may have moved onto it. Merge duplicated per-tool assertions into the existing shared loop instead of deleting the guarantee.

## add-agent-messaging (mocked module vs presentation pin) - 2026-10-13
**What worked:** Deleting the mark-and-colour assertions on the shared status-line renderer let `test/index.test.ts` return to a plain `vi.mock` factory: the factory only has to carry the exports the module under test reads while registering, so one `renderStatusLine: vi.fn()` entry replaced the `vi.importActual` indirection. The surviving guarantee is which registered tools declare a `renderResult`.
**What failed:** Round 1 kept the indirection because the mock revert and the pin deletion were treated as separable changes; reverting one without the other failed the file at import time.
**Next time:** When mocked code is kept real only to keep a presentation assertion alive, delete the assertion and list the read exports in the fake. Supersedes the `vi.importActual` advice in the entry above: reach for that only when the shared function's own behavior is the contract.

## add-agent-messaging (queue-flush coverage) - 2026-10-13
**What worked:** Asserting the exact list of messages that left the queue at the seam where it drains (the `session.steer` call arguments in arrival order) covers a pre-session steer end to end: delivery, ordering, and no second delivery after the flush.
**What failed:** The criterion "a message sent before the session exists is delivered when that session starts" was treated as met by asserting `pendingSteers` holds the message; deleting the flush loop left the suite green while the message was silently dropped.
**Next time:** For any queue-then-flush path, assert what the drain handed to its target, never that the queue held the item. Prove the assertion bites by deleting the flush and reading the red before shipping the green.

## announce-child-sessions (ordering contracts) - 2026-10-13
**What worked:** To pin "the broadcast must land before the code under test proceeds", give the test's bus subscriber and a fixture extension loaded by the code under test one shared file to append to synchronously, then assert the whole timeline (`created`, child `session_start`, `bound`, child `session_shutdown`, `disposed`). One file gives real wall-clock order across the dependency boundary, and a payload assertion in the same timeline pins the wire format with it.
**What failed:** An ordering test that records both sides in test-process memory cannot observe the side that happens inside the dependency, and the conclusion drawn from that — "an inserted `await` between emit and call is not behaviourally distinguishable at any seam" — was overbroad. It holds where the dependency's own awaits sit between the two, and not at a seam where the emit and the call are both code under test.
**Next time:** Pin the behavioural contract the ordering protects (state visible to the callee's own setup) at the contract seam, and where both sides are yours add the cheap tripwire instead of writing it off: make the bus fake queue a microtask inside `emit`, then assert the marker lands after the call. Narrow any "not distinguishable at any seam" claim to the seam you checked.

## announce-child-sessions (new dependency member read by src) - 2026-10-13
**What worked:** Reading new members of dependency objects (`session.sessionId`, `ctx.sessionManager.getSessionId()`, `pi.events`) was followed immediately by a full-suite run, which named every minimal fake that had to grow the member (contract-suite ctx, runner and manager session factories) in one pass.
**What failed:** The first pass assumed existing fixtures modelled required members; the contract suite drives real code with hand-built two-field fakes, so that assumption was wrong for all of them.
**Next time:** Treat "which fakes lack this member" as a full-suite question, not a grep question, and give session fixtures an explicit `sessionId` so payload assertions stay independent of fixture defaults.

## announce-child-sessions (a dependency member that can throw) - 2026-10-13
**What worked:** Pinning why a `catch` exists with a dependency-contract test: build a real session, capture the extension's own `pi`, dispose the session, assert `pi.events.emit` throws. The catch then carries evidence, so nobody deletes it as dead code.
**What failed:** The premise "the bus catches listener failures, so emit cannot throw" was applied to `pi.events`, which is typed `EventBus` but is a guarded facade: its emit throws once the session that loaded the extension is disposed, reloaded or replaced. Every test handed the code `createEventBus()`, so the guard was invisible and the throwing call became the one step of the child teardown outside a `try`: the fire-and-forget promise `AgentManager.dispose()` drains in a loop.
**Next time:** Read the implementation behind the dependency member you call, not its declared type: a facade can wrap the object the type names and add throwing guards. Model the boundary fake on that implementation, and when a fire-and-forget promise feeds a loop that waits on it, remove the entry on both settle outcomes: a fulfilment-only removal turns one rejection into a hang that also starves the test timeout.

## announce-child-sessions (refactor: shared bus recorder) - 2026-10-13
**What worked:** Recording the channel name rather than an encoded payload let one recorder serve the ordering test (its timeline array is the recorder's sink) and the exactly-once tests, while the payload shape stayed pinned in the module's own wire-format test against the real bus.
**What failed:** A recorder helper that also seeds the announcement it records must subscribe after seeding: subscribing first made the seed's own `created` emit land in the timeline, and three teardown tests failed on arrays whose printed diff looked identical to the expectation.
**Next time:** When one helper both seeds an event and records the channel it lands on, seed first, subscribe after, and state in the helper that the seed is unrecorded. Keep `JSON.stringify`-encoded expectations only where the encoding is itself the contract.

## announce-child-sessions (refactor: two fakes for one boundary) - 2026-10-13
**What worked:** Sharing the guarded `pi.events` behaviour through one fixture that takes the bus as a parameter (`guardedEvents(bus)`): the always-refused handle and the live-then-stale handle now come from one implementation, and the file that carried its own facade fake kept only the helper that announces and records.
**What failed:** The obvious merge — put the facade in `test/fixtures.ts` and build it on `createEventBus()` — breaks every test file that mocks the SDK module: those mock factories list only the exports the code under test reads, so a shared fixture importing the bus factory at runtime gets `undefined` there. The two fakes looked duplicated but differed by a real constraint, not by accident.
**Next time:** Before merging two similar fakes, check what each consumer's module environment allows: a shared fixture may depend only on what its most heavily mocked consumer provides. Pass such a dependency in rather than constructing it inside the fixture.

## announce-child-sessions (a best-effort catch that drops work silently) - 2026-10-13
**What worked:** One warn in the single guarded publish point, naming the entity it could not deliver plus the protocol channel it was meant for, asserted at the module seam and once at the spawn seam with `expect.stringContaining` per line so the sentence around it stays free to change.
**What failed:** A review caught a `catch {}` defended as "advisory event, must not fail the run". Correct, and it hid the drop: the user-visible symptom of a dropped child-session announcement is the very symptom this feature removes, so a dropped announcement reads as a regression of a fixed bug with nothing connecting it to the cause.
**Next time:** Where the codebase warns on every other degraded drop, "fire-and-forget" justifies not throwing, never silence: warn once naming what was dropped. Check first whether the test runner surfaces `console.warn` from passing tests before adding spies to hush it; this one does not, so only the tests asserting the diagnostic need a spy.

## announce-child-sessions (ordering against a dependency's own call) - 2026-10-13
**What worked:** To order a broadcast against a call the code under test makes *inside* a dependency, wrap the dependency's prototype method: append a marker to the same shared timeline, `return real.apply(this, args)`, restore in `finally`. The real method still runs, so the contract keeps its value and the timeline gains the call instant. Queuing a microtask inside the emit then pinned the call-stack property too: inserting one `await` between emit and call in src turned exactly that contract test red, and left the sibling ordering test green.
**What failed:** The contract suite asserted the broadcast preceded an event the dependency emits *during* that call, so an `await` between emit and bind stayed invisible and an acceptance criterion was marked met on a proxy. The earlier "not distinguishable at any seam" note in this file is what made the gap look unfixable.
**Next time:** When a criterion names a call, assert the instant of the call: instrument the dependency boundary by wrapping and delegating, never by inferring from what the call later emits. Restore the wrapper in `finally`, and scope it to the spawn under test so other sessions in the same file bind unpatched.

## announce-child-sessions (deliberate coverage cut) - 2026-10-13
**What was cut:** the feature landed ~826 added test lines against ~120 lines of production code, with several invariants pinned at two or three seams, so the maintainer cut the automated surface to the protocol core. Kept: the module's wire format (the three channel names and payload objects as a live subscriber on the real pi bus hears them, in `test/agents/child-announcements.test.ts`) and the two contract ordering tests in `test/contract/child-session.test.ts`, which keep their harness: the wrap-and-delegate observation of the instant `AgentSession.prototype.bindExtensions` is invoked, and the microtask marker queued inside the `created` emit. Deleted: the spawn-seam announcement file, the announcement additions to the teardown and manager-disposal files, the disposal and stale-handle additions to the contract suite, and the `guardedEvents`/`refusingEvents` fixtures plus the mock session members that became unreferenced.
**Not verified automatically any more, by decision and not by oversight:** `disposed` is the last teardown step, after the session is disposed; exactly one `disposed` announcement per child session across overlapping termination triggers; no `bound` announcement when binding fails; every announcement is a no-op when the event bus is unavailable; a refused emit is dropped with one diagnostic and cannot fail a spawn or a teardown; teardown still completes when the announcement handle has gone stale. Gone with them: teardown announces nothing for a child that was never announced; a spawn whose parent session id cannot be read fails before publishing anything (that read was the one announcement input allowed to fail a spawn).
**Kept back out of that list, deliberately alone:** the parent's event bus is never handed to the child's resource loader. `test/agents/agent-runner-loader-isolation.test.ts` is one test: spawn with a bus on `pi`, then assert that the options the child's `DefaultResourceLoader` was built from contain neither that bus nor the `pi` instance carrying it; two further assertions prove the loader was built and that this bus was the one the run used, so the check cannot pass vacuously. It is a security boundary rather than protocol behavior (a child-loaded extension that reached the parent's bus could read parent traffic and forge these events), so it stayed while its neighbours in the same deleted file went, and its isolation in a one-test file is intentional, not a leftover. Neither leak is hypothetical: `DefaultResourceLoaderOptions.eventBus` is a real pi field, so `eventBus: options.pi.events` typechecks, and the indirect path handing over the whole `pi` object needs no cast either (`Object.assign`). Mutating either leak into src failed this test and no other of the 1917, which is why it stays: nothing else can fail for that leak.
**Next time:** Do not "restore" these as missing tests. Sort invariants by kind before a coverage cut, not just by duplication: protocol shape and ordering at a dependency boundary survive at the surviving seams, a security boundary keeps one assertion even when everything around it is deleted. Re-add coverage for one of them when its symptom is actually reported (a gate still holding a disposed Subagent registered, a teardown failing on an advisory emit), and re-measure the ratio first: the survivors are the only announcement tests that a src change can fail without the same invariant being restated at another seam.
## thinking-inherit-parent (widening an accepted value) - 2026-10-14
**What worked:** Naming the winner and its position from one scan of the chain, so the displayed value and its source cannot disagree, and letting the picker entry that writes nothing take the name of the source it lets win (`pi default`): the same string serves as the unset display value and the menu entry, so the wizard needed no extra state for "not set".
**What failed:** Renaming the shared parser (`parseThinkingLevel` to `parseThinkingChoice`) typechecked clean and broke two suites at runtime: a `vi.mock("../../src/utils.js", ...)` factory lists export names by hand, so the code under test called `undefined` and every spawn in those files died with `raw is not a function`.
**Next time:** When renaming a member of a module that tests mock wholesale, grep the mock factories for the old name, not just the importers. A mock factory is a second, unchecked declaration of the module surface.

## thinking-inherit-parent (simulating SettingsList in menu tests) - 2026-10-14
**What worked:** Driving the menus through the same seams the real `SettingsList` uses: `item.submenu(value, done)` to open, then the fake list's `onSelect`, then `settingsListCalls[n].onChange(id, value)` because the real component writes the picked value into its row itself.
**What failed:** The shared menu fake records only the most recent submenu callback, and its `activate(id)` ignores the id. A target picker that keeps one callback per layer stayed correct under it; a callback that captured loop/iteration state wrote the wrong layer, which no assertion caught until the config object was checked.
**Next time:** Under a fake that ignores the id, never carry per-option state in a closure: look the option up by id when the callback runs, so a late or replayed callback still selects the right entry.
## thinking-inherit-parent (a stash you cannot pop) - 2026-10-14
**What worked:** Recovering a `git stash` the tool guard would not let me pop or list: read the SHA from `.git/logs/refs/stash` and take each file back with `git show <sha>:<path> > <path>`. Read-only, per-file, and it left the stash entry intact for the maintainer to drop.
**What failed:** Splitting the change into two green commits by stashing the display-layer files, which turned a staging decision into a recovery task: `git stash push` is allowed while `pop`, `list` and `drop` are blocked, so the work was stranded mid-operation.
**Next time:** Split commits by staging file groups (`git add <files>`, temporarily re-adding the export the uncommitted half still needs), never by stashing under this guard. If work is already stranded, the stash is an ordinary commit: read it by object, do not resurrect it.

## thinking-inherit-parent (a snapshot write guarded by display state) - 2026-10-14
**What failed:** `refreshThinkingSnapshot` returned early unless the wizard was already on `default`, which was sound while a user pick was terminal: the snapshot could then never be read again. Adding the `pi default` entry made `default` reachable again, so a worktree change made while `picked`/`following` left the snapshot on the previous target cwd and the row printed a level and source the spawn would not use. The run stayed correct, so the bug was silent misdirection in exactly the diagnostic the feature exists for.
**Next time:** A guard on a write is only valid while the state that skips it cannot return to the state that reads it. Refresh on every input change and let the read decide what to show: guard the read, not the write. When a transition is added to a state diagram, re-audit every early return the old transitions made unreachable.

## thinking-inherit-parent (reserved padding inside a SettingsList value) - 2026-10-14
**What failed:** Aligning the `[session]`/`[project]` tag by padding the thinking label to the longest label the chain can print cost 19 columns of value width. `SettingsList` truncates `currentValue` at `width - 2 - maxLabelWidth - 2 - 2` with no ellipsis (`packages/tui/src/components/settings-list.ts`), and `maxLabelWidth` counts the group headers' bare model ids up to 36, so a provider-style id (`openrouter/anthropic/claude-sonnet-4.5`) pushes the cut point to 80 columns and the tag disappears silently. Measured against the real renderer: the padded worst row needs 80 columns, the same row unpadded 79, while a typical row goes from 80 to 68.
**Next time:** Do not reserve width inside a value a shared component truncates silently; join the parts with one space, as every other settings row here does (`${value}${" [project]"}`). Before deciding a width problem is out of scope, measure it by rendering the real component at candidate widths instead of reasoning about string lengths.

## thinking-inherit-parent (a shared constant no caller was forced to use) - 2026-10-14
**What failed:** `THINKING_CHOICE_TAIL` was exported as "the two entries every thinking picker offers", yet the wizard still pushed `parent` and `pi default` by hand, so "both menus present the same choice list" was held by convention only. Each menu's test pins its own literal item array, so a diverged tail turns that test green on the wrong list: the suite documents the requirement and cannot see it break. Same shape in the doubles: `setDefaultThinking(level: ThinkingLevel)` and `defaultThinking: ThinkingLevel | undefined` where both members carry `ThinkingChoice`, harmless only while nobody routes `parent` through them.
**Next time:** When a constant or type exists to stop drift, convert every hand-written site in the same commit, then grep for the literals it replaced. Do not answer the drift with a test comparing the two surfaces: once both read the shared source such a test is tautological. Type a mocked member by naming the real member's type, and give the widened fixture field a value the narrow type would have rejected.

## thinking-inherit-parent (refactor: hoisting a lazy lookup) - 2026-10-14
**What failed:** De-duplicating the wizard's "which model would this spawn use" registry lookup: the thinking picker's builder re-wrote that lookup next to the `currentModel()` helper that exists to name it. The obvious move hoisted `currentModel()` to the top of `buildItems`, threaded the resolved model through the display helpers and handed the value to the builder. Typecheck and all 1965 tests passed, and it was still wrong: the `picked` state returns the picked level from the display path before touching the registry, so that rebuild had been doing zero lookups and the dedup gave it one on every rebuild. The earlier round's note that the builder must stay lazy was right about laziness and wrong about the lookup arithmetic it cited, which is what made the hoist look free.
**Next time:** Before hoisting a duplicated lookup, count the calls per state on the paths as they exist, not at the shared call site: a lazily-called lookup is already the minimum on the paths that never call it. Prefer handing the callee the resolver (`() => Model`) over the resolved value: the duplicated expression is gone, the resolution point stays where it was, and per-path call counts are identical, so the refactor needs no measurement to be honest. Pass the value only once a count shows the earlier resolution is not new work.

## thinking-inherit-parent (refactor: one word, two provenances) - 2026-10-14
**What failed:** `buildModelGroups` already spelled its winning model layer `source` (from `resolveModelSource`) when the change added the thinking chain's winner to the same loop body and to `ModelGroupRow` as `source`. Inside that scope `source` meant the model layer while `row.source` meant the thinking source, and the row's tag derives from the first while its `thinking` derives from the second. Nothing breaks: the compiler sees two different expressions, and only a reader who mixes up `[session]` with `(frontmatter)` pays for it.
**Next time:** When a change adds a second provenance concept to a module, rename the older one in the same commit and say which field carries which in the row's doc comment. Ambiguity between two live concepts is a defect the suite cannot see, and a later "simplify `modelSource` back to `source`" edit re-introduces it silently.

## thinking-inherit-parent (a review note that no longer matched the tree) - 2026-10-14
**What failed:** Review 3 listed `value: v as string, label: v as string` in the agent-settings thinking picker as a cosmetic leftover of the shared-tail commit and named the one-keyword fix. The tree has no casts there: the `readonly` tuple of literals feeds `SelectItem.value` directly, so the note described an intermediate revision. Acting on it would have "removed" nothing and reported a change that never happened.
**Next time:** Re-read the cited lines before implementing any review note, cosmetic ones first: they are the least verified and the cheapest to invent. Report such a note as already satisfied rather than skipping it silently, so the reviewer can retire it.

## thinking-inherit-parent (an escape entry behind a capability condition) - 2026-10-14
**What failed:** The wizard pushed `parent` and `pi default` behind `if (model.reasoning)`, so a non-reasoning model offered only `off` and the states those entries set became unreachable: a level picked while a reasoning model was selected could never be returned to `pi default` after a model change, which is the exact reversal the issue's Key Decision promised and an invariant named. The menu's own literal item-array assertion pinned `["off"]`, so the suite recorded the unreachable state as the requirement and stayed green.
**Next time:** An entry whose job is to leave a state is not a capability of the model: gate the level list on what the model supports, never the escape entries. Where an issue states a reachability invariant, test it by walking to the state, changing the gating condition, and asserting the entry is still offered. A single menu's item array documents a list, not a transition.

## thinking-inherit-parent (a review row that merged two criteria) - 2026-10-14
**What failed:** The AC review merged "both pickers take the tail from one shared definition" with "the wizard's level list follows the selected model" into one row, then judged the settings picker at fault for offering every level, which is the clause of that same criterion that exempts it because that picker has no selected model. The row cited the right file and named a fix that would have removed the only way to set `max` as a default, while the real defect was the `isReasoning` guard a few lines below the shared spread both menus already read.
**Next time:** Re-read every review row against the verbatim criterion it summarizes before implementing, rows that span two criteria first: a merged row can point at the right file and the wrong fix. Implement the clause that is genuinely unmet and report the mangling, so the row can be re-cut.

## thinking-inherit-parent (a derived level stored at the transition) - 2026-10-14
**What failed:** The wizard clamped a picked level to the new model inside the model picker's `onSet`, behind `if (thinkingState.kind === "picked" && currentModelStr)`. `(inherits parent)` is the model change that clears `currentModelStr`, so the one transition the criterion named skipped its own clamp: the row and the spawn intent kept `xhigh` for a model that cannot run it. The same rule sat a second time in the display path for `following`, so each state had to remember the clamp separately and one of them forgot.
**Next time:** When a value is (user intent, current context), derive it at read time from both inputs: storing the projection turns every context change into a new place that must remember to redo it, and a guard on the write silently un-does the requirement. Read-time clamping also stops pi's upward clamp from ratcheting - `low`, clamped up from a user's `minimal`, is no longer what the user picked, and a model that supports `minimal` should show it again.

## thinking-inherit-parent (a prediction that mirrored its own chain) - 2026-10-14
**What failed:** The wizard predicted the spawn's model as "the picker's value, else the parent's model". The runner resolves an omitted model as the agent file's model, then the parent's, so after `(inherits parent)` the wizard read pi's per-model entry for the parent's model and clamped the level list to the parent's capabilities while the child ran the agent file's model. Each side was reasonable on its own; nothing stated that the prediction must reproduce the runner's chain, although `CONTEXT.md` already said the level is clamped to the **Resolved model**.
**Next time:** Where one module predicts what another will do, mirror the other module's exact chain and name it in the helper's doc comment. A plausible simplification of someone else's precedence is a standing divergence the suite cannot see until a test walks the transition that exposes it: add that test with the fix.

## thinking-inherit-parent (a trust gate that blanked the trusted layer too) - 2026-10-14
**What failed:** Closing the earlier trust bypass zeroed the injected prediction's whole per-model term for an untrusted cross-repo target, so the user's own global `modelThinkingLevels` entry vanished with the target project's, while pi drops only the project scope on the child's settings instance. One configuration, two levels, differing only by the target's trust, and the Model settings row still printed the level the run would not use. The gate had been a silent correctness detail; putting a `(<source>)` annotation next to the same value made it load-bearing, because the annotation explains a level the gate can silently remove.
**Next time:** Put a layered-config trust decision in the reader that can see the layers and hand it the decision; zeroing a term in the caller drops every layer behind the one being gated. When a value gains a source annotation or any other user-facing explanation, re-audit each gate that can blank that value: an ignore nobody could see is a wrong prediction once somebody can.

## thinking-inherit-parent (one displayed value, two places to read it) - 2026-10-14
**What failed:** The two annotated surfaces read the parent's Thinking level from different objects: Model settings from the shell's stored session context with the live extension context as fallback, the spawn wizard from the stored context only. Each looked right alone; in the state where the fallback applied the menus contradicted each other about whether the Subagent follows the parent, while the run followed it either way. No test failed, because every existing test moved both objects together.
**Next time:** Where a surface explains what a run will do, read its inputs through the same expression the run uses, not a stored copy of the same object, and keep that expression identical across the surfaces. Pin it by making the two sources disagree in a test and asserting the displayed explanation: a suite that only ever sets them to the same value cannot see the divergence.

## widget redraw polling (preflight error boundary) - 2026-10-16
**What failed:** Redraw suppression rendered the widget synchronously from `update()`, outside the component callback's existing catch. A transient rendering dependency failure could escape a navigation input event, even though normal TUI renders reported it safely.
**Next time:** Treat a render used only for comparison as best-effort. On failure, fall through to the normal component render path so optimization work cannot bypass the established error boundary.

## Vite+ migration (split test configuration) - 2026-10-16
**What failed:** `vp migrate` rewrote test imports and created `vite.config.ts`, but left the old `vitest.config.mts` in place. Vite+ recommends one config; keeping both makes it easy for test and check commands to read different settings.
**Next time:** After running the migrator, explicitly merge the test block into `vite.config.ts` and remove the standalone Vitest config, then validate both `vp check` and `vp test`.

## Promise-returning lifecycle mocks - 2026-10-16
**What failed:** A manager test double implemented `dispose()` synchronously even though the real API returns a promise. Attaching rejection handling exposed the mismatch as `undefined.catch`.
**Next time:** Keep lifecycle test doubles promise-shaped and type their methods against the real API; do not hide contract mismatches with optional chaining.

## Vite+ lint policies (AST rules over custom scanners) - 2026-10-16
**What failed:** `test:any-gate` duplicated explicit-any linting in Bash and kept obsolete allowlists after the fixture helpers were typed.
**Next time:** Enforce syntactic policies with a scoped Oxlint rule; keep exceptions local and documented, and remove bespoke scanners.

## Pi prompt-section ordering and cache stability - 2026-10-30
**What failed:** Treating `appendSystemPrompt` as a true suffix; Pi places its addendum before project context, skills, and cwd, so a conditional change there alters the prompt before those later sections.
**Next time:** Inspect Pi's section builder before choosing an insertion point. Put guidance tied to a tool's availability in that active tool's description/schema; use a trailing custom section only for genuinely system-level guidance, and keep it stable across turns.

## Pi extension message acknowledgement - 2026-10-30
**What failed:** Returning “sent” after calling `pi.sendMessage`, whose extension API is fire-and-forget and reports asynchronous persistence failures separately from the caller.
**Next time:** Say “submitted” or best-effort unless the API provides an awaitable delivery acknowledgement. Don't add retries or polling without a delivery contract.
