# Lessons Learned

> Dated wave reports were consolidated into these sections; only lessons that measurably improve the next outcome survive.

## Worktrees
- Clean up after merge first. Verify worktree path, branch, and checkout state before spawning agents.
- Read files through the worktree path, never the main checkout. Verify `git status` after writing.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.

## Testing
- Run `npm run test` after merging — clean merge ≠ passing tests.
- Test behavior, not implementation details: assert constructor args and call args, not downstream effects; export testable functions early.
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
- Clean up dev comments immediately; add the CHANGELOG entry as part of the initial implementation.
