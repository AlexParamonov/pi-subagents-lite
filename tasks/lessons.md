# Lessons Learned

> Dated wave reports were consolidated into these sections; only lessons that measurably improve the next outcome survive.

## Worktrees
- Clean up after merge first. Verify worktree path, branch, and checkout state before spawning agents.
- Read files through the worktree path, never the main checkout. Verify `git status` after writing.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.

## Testing
- vi.fn() with an arrow implementation is not a constructor — a `new`ed mock needs a `function` implementation.
- Cost accumulators: assert with toBeCloseTo (0.1 + 0.05 ≠ 0.15 in floats), and remember usage callbacks report per-message cost, not cumulative.
- Per-message usage callbacks must be driven BEFORE the run settles — post-settlement the tally already read the old total.
- When a new run path (e.g. continuation) reuses callback wiring, mirror every first-run callback: a dropped onTextDelta silently breaks idle-watchdog feeding for streamed text.
- Re-bridge every spawn-time consumer on continuation: spawn-only callbacks (live-view bridging) die at first settlement, so a continued run renders stale "thinking…" until the manager forwards the continuation's events through callbacks captured on the record.
- When a run reuses a session's transcript (continuation), scope history-scanning fallbacks to messages added during this run — a full-history scan resurrects a prior run's result text on failed runs (model error/abort with no output).
- vitest writes transformed modules under TMPDIR; a shared machine pruning /tmp mid-run produces flaky ENOENT import failures — run with TMPDIR set to a stable local dir.
- Replace `setTimeout` sleeps with awaiting chained completion promises — faster, no flake.
- afterEach cleanup must remove the whole temp base dir, not one sibling.
- Re-review recently fixed code fresh — don't assume the fix held because it was just touched.
- vitest mocks are strict: extending a vi.mock factory must keep every symbol the production module imports; module-level singletons still require vi.mock().
- `parseInt` accepts trailing garbage — require `/^\d+$/` after trim.
- Closure capture traps: a factory mock's closure binds its own parameter — assign explicitly against the outer variable.
- Never name a snapshot variable after a callback parameter in scope; don't read `.length` off something that might be a function.
- Vacuous-test grep list: `.find()` with no expect; global `some()` passing from initial state; `expect.any(String)` for branch-specific messages.
- Verify the mock is actually called — a test that passes if the feature was deleted is worse than no test.
- Prove each consumer reaches an extracted shared mock — a mock is vacuous when the importing modules are themselves mocked.
- When a fix is about which arguments reach a function, assert the call args — a mock that ignores args keeps the old bug green.
- A lib-contract test via `vi.importActual` pins the input formats a fix claims to support.
- Boolean flag inversion (hide vs show): write the test FIRST with the correct expected value.
- Test UI features through public APIs (session events), not private state; exercise both streaming and non-streaming paths.
- Time-window fixtures at exactly the filter edge are latent flakes — same-ms passes in isolation are luck. When adding a time-based filter, audit shared fixture boundaries.
- Pin listener lifecycle exactly-once with spy-based detach regression guards.
- For pi-tui widgets, verify `truncate()` runs on every render path — hard contract.
- When shipping wording adjusted from a spec's provisional text, update the spec's Further Notes in the same pass.

## Delegation
- Delegate immediately without pre-reading files. For simple tasks, propose 2-3 name/design alternatives upfront.
- Parallel agents: mandate distinct output paths / disjoint file sets; go sequential when file contention is unavoidable.
- Comment cleanup across many files: delegate per-module with a shared ruleset, then verify the union diff is comment-only by filtering changed lines. Stale consumer names in comments rot — verify with grep.

## Verification
- Don't assume — verify: confirm merge commits exist; code review catches silent production bugs.
- Never use `general-purpose` when the workflow specifies a specialized agent type.
- `ExtensionAPI` rejects calls to old ctx — wrap sendMessage in try-catch.
- Keep review loops strictly sequential; verify agent completion order before spawning the next agent.
- Verify agent output files exist before treating a return as verdict — empty return with no file means restart, not approval.
- Acceptance tests committed before implementation give builders a precise Red target.
- Review prompts should ask "does the code compute X?" (thresholds, values), not "is the feature implemented?"; reviewers verify each finding against source.
- For sweep/enumeration claims in plans, grep-verify counts — eyeballing undercounts.
- Before manual testing, probe the configured model endpoints first; budget a model swap.

## Manual Testing Environment
- This box runs a shared agent pool whose gate-clean workflow wipes recently-created files under /tmp (observed: mock server dir, request logs, test projects, backups all deleted mid-test). Keep mock servers, request logs, test projects, and config backups outside /tmp (e.g. $HOME/manual-test/); expect an external wipe at any moment and write evidence immediately after capture.
- Verify a config backup is the PRE-modification state before trusting it — re-copying after an earlier mutation silently freezes the modified version.
- For pi extension e2e tests: point pi at a local mock OpenAI-compatible SSE server (llamacpp provider already targets localhost:8080) via --model + --api-key; drive the spawn deterministically by having the mock return an `Agent` tool call (agent type read from a file), and capture the sub-agent's exact system prompt from the logged request. Discriminate parent vs sub-agent requests by the `<agent_instructions>` marker in the system message.

## Types & Refactoring
- Run typecheck before removing "redundant" fallbacks. Verify narrowing claims with the typechecker.
- Make source fields optional from the start for explicit-vs-default overrides. Trace ALL mutation paths when adding similar config.
- When two code paths must agree, share the exact computation; if two functions compute the same derived state, one should call the other. Pin the contract as a state table.
- State consumed by render paths must be clamped at the render path, not only in mutators. Pin with tests that mutate state without a nav move in between.
- Config setter traps: check which getter the production path reads before choosing the setter in test setup.
- Check for WIP branches that might land before merging.
- Prefer public API for cross-package access — private fields break silently on upstream changes.
- Two mechanisms converging on the same state with the same gates are vestigial duplication: keep the one owned by the authoritative module, delete the other.
- Remove dead code in the same commit that makes it dead, not later.
- Centralize a decision on one authoritative field; downstream consumers key off it.
- When a callback consumer cannot observe an event (continuations bypass the coordinator), ride the signal on the record the callback receives — a settlement ordinal in the shared settlement chain cannot drift from the notify that fires there.
- New config setting: audit the full plumbing list in one pass (type, DEFAULT_AGENT, resolution/setter/sync, CONFIG_AGENT_NON_MODEL_KEYS, mirrored internal defaults). When changing a user-visible default, grep for the old value across src/ and test/. A "setting survives clearAllModelOverrides" test belongs with every new setting.
- Config constraints: enforce at every entry point in one pass (setter, load/default-merge, resolution getter) — enforcing two of three is a trap.

## pi-ai API & Subagent Lifecycle
- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. `followUp` waits for the agent. Check `ctx.isIdle()` at call time.
- `createAgentSession` re-executes EVERY extension factory and re-fires session_start/shutdown in subagent context. Bracket `runAgent` with a nesting-depth flag; no-op factory and session handlers while a subagent is in flight.
- `AgentSession.dispose()` does NOT emit session_shutdown; subagent `bindExtensions` DOES fire parent's session_start.
- Reading pi's settings.json directly is acceptable when pi APIs don't expose the setting yet.

## Extension Tools
- When tools/resources are silently missing, find the gate first. Seed `createAgentSession({ tools })` with concrete names.
- Allowlist gate must derive from whitelist expansion alone in whitelist mode and gate builtins too.
- Cross-repo trust gate is narrower than it reads: `.pi/` resources + `.agents/skills` are gated, but root `AGENTS.md`/`CLAUDE.md` load unconditionally.

## SettingsList & Menus
- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs. Never call `ctx.ui.input/select/custom` inside it.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly.
- Separator-skip lives in one shared helper (`installSeparatorSkip`): override `selectedIndex` on the list instance, since pi-tui stores it as a plain own property and writes ±1-with-wrap directly.
- When simulating library navigation writes in tests, initialize the state field exactly as the library class field does — `undefined + 1` is `NaN`, which silently passes any index check.

## Issue Design
- Prototype state machines/key handlers in issue.md as a contract. Call out overflow behavior as a hard AC gate.
- Grill / voice-of-reason shape vague questions into precise issues.

## Buffer & Error Patterns
- Buffer-then-flush is the simplest fix for ordering/corruption. Consider error paths when deferring side effects; try/finally guarantees flush.
- When nudges stop working, restart the harness rather than debugging live state.
- `session.abort()`/`steer()` return promises fired from event listeners; Node's EventTarget re-throws a listener's rejected promise as an uncaught exception — always `void promise.catch(() => {})`. Mock sessions must be promise-shaped too.

## Package Management
- Regenerate lockfiles with the package manager when bumping versions; never hand-edit package-lock.json.
- Releasing: keep `[Unreleased]` as an empty running header; insert the versioned section below it.

## Cross-Platform
- `process.env.HOME` is unreliable on Windows — use `os.homedir()` or the SDK's `getAgentDir()`.

## Edit tool
- `append` must not re-include the anchor line's content (it inserts after it). Single-line `replace` with multiple lines swaps one line and inserts the rest. Re-read after failed/stale-anchor edits.
- Multi-op `replace` calls on adjacent ranges are one wrong anchor away from deleting a neighboring field — verify range endpoints against a fresh read, then run typecheck before the test suite.

## Scope
- Stay within issue scope. When provisional wording or removed-machinery comment changes, update the spec/comment in the same commit.

## continue-settled-agents - 2025-07-18
**What worked:** shared settlement chain (`attachSettlementChain`) kept first-run and continuation paths from drifting; TDD with deferred promises verified async timing without sleeps; reviewer caught 3 real bugs (watchdog feed, stale result text, widget live-view) that unit tests alone missed.
**What failed:** initial implementation missed `onTextDelta` on continuation path (watchdog idle-kill); stale result text from prior runs resurfaced on failed continuation; widget live-view showed stale "thinking…" during continuation.
**Next time:** when a new run path reuses session/callback wiring, audit every first-run callback before shipping (checklist: onTextDelta, onToolActivity, onUsage, onCompaction); scope history-scanning fallbacks to the current run via pre-prompt boundary; re-bridge every spawn-time consumer on the record.

## nudge-after-continuation - 2025-07-18
**What worked:** settlement ordinal on the record (incremented in the shared settlement chain's `.finally` before `notifyComplete`) gave the coordinator a race-free continuation signal off the steer path; replacing the ctx map with a record-carried `spawnCtx` followed the established `liveView` precedent; the manual harness's mutation check (revert the gate branch → exactly the continuation scenarios fail) proved the tests detect the regression.
**What failed:** the one-shot `backgroundAgentIds` set consumed at first settlement hid the continuation gap; foreground agents were never armed at all. First review round approved clean — the bug analysis done before writing the issue (coordinator not on steer path, notify fires on every settlement) made the fix land correctly the first time.
**Next time:** when a delivery/notification gate is a consumed set, ask whether the event can re-occur before writing the issue; verify the callback's visibility of run ordinal at the point the gate reads it (increment must precede notify synchronously).

## running-agents-menu-skip-separators - 2026-08-13
**What worked:** extracting the wrapper's `selectedIndex` accessor into a shared `installSeparatorSkip` helper (applied to the list instance directly, bypassing the wrapper/delegator incompatibility); verifying the pi-tui mechanism in library source before committing to the approach; unit tests mirroring the library's exact ±1-with-wrap writes; manual tmux test with real spawned agents (running + completed) matching the issue's menu layout.
**What failed:** the wrapper's initial-selection bootstrap line read through the new getter and always stored 0 (silently discarding pre-install selection) — hidden-state bug caught only in the refactor pass, not review; AC-1 initially promised j/k navigation that this menu never had (no j/k→arrow conversion, host binds arrows only) — scope decided by user: separator-skip only, j/k out of scope.
**Next time:** when overriding a property accessor, check pre-install state reads through the getter before defineProperty; verify keybinding claims against the host's default keybindings before writing ACs about keys; wrap-around edge cases (both list ends are real items) pass even without the fix — add mid-list separator tests that actually fail on old code.

## running-agents-menu-action-order - 2026-08-13
**What worked:** TDD with exact-order assertions (full item array + separator count + wrap targets) that failed on the old layout for the right reasons; nesting the `completed` group inside the `finished` block directly encodes the completed ⊆ finished invariant instead of a rank sort; refactor agent correctly NOOP'd rather than forcing a grouping helper that would diverge from the inline separator convention used by every menu.
**What failed:** one self-inflicted edit duplication (`__stop-all` block duplicated by a bad range replace) during implementation, caught by the red tests; the brainstorm step (voice-of-reason) added latency on a genuinely trivial change — user stopped it and called it trivial.
**Next time:** for layout/order changes, assert the exact full item array and separator count, not membership; when the user calls a change trivial, skip the brainstorm step (it never blocks anyway); a fast way to get a running+completed menu state for manual tests: spawn via the wizard and let an accidental second spawn with the default model complete quickly.

## project-level-config - 2026-08-13
**What worked:** TDD vertical slices (load merge → save write-back → store wiring → events trust gate) with mutation checks to prove the save-diff tests bite; the diff-write-back rule (union of project+merged keys, skip undefined) is deletion-aware by construction and was verified by removing keys at both nesting levels; verifying pi's trust model in library source before deciding the load gate (`hasTrustRequiringProjectResources` excludes `subagents-lite.json`, so auto-trust keeps the feature working in plain repos).
**What failed:** the save path was written in the same pass as the load path, so chunk B never had a RED run (caught via mutation check, not process); several single-anchor edits inserted multi-line replacements incorrectly, mangling test files — range replaces with both endpoints are the only reliable form; `JSON.stringify` of a malformed-JSON test string produced valid JSON (a string literal), hiding the warning-path bug.
**Next time:** when a feature adds a load path for repo-controlled files, check the codebase's trust gate precedents and pi's trust-requiring-resources list BEFORE deciding unconditional vs gated loading; write the malformed-input test with raw text, not a stringified value; for file-content assertions, use known-good literals rather than recomputing expectations.
