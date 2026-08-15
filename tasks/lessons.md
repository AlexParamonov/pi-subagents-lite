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
- A "no render after close" test is vacuous without its trigger: fire the session event and run the debounce timer, or the closed guard is never exercised.
- Redundant guards (subscriber closed-check + timer-callback closed-check) mean a post-close test can only pin the combined no-render contract — verify which guard a test actually fails on before claiming it pins one of them.
- Prove each consumer reaches an extracted shared mock — a mock is vacuous when the importing modules are themselves mocked.
- When a fix is about which arguments reach a function, assert the call args — a mock that ignores args keeps the old bug green.
- A lib-contract test via `vi.importActual` pins the input formats a fix claims to support.
- Boolean flag inversion (hide vs show): write the test FIRST with the correct expected value.
- Test UI features through public APIs (session events), not private state; exercise both streaming and non-streaming paths.
- Time-window fixtures at exactly the filter edge are latent flakes — same-ms passes in isolation are luck. When adding a time-based filter, audit shared fixture boundaries.
- Pin listener lifecycle exactly-once with spy-based detach regression guards.
- For pi-tui widgets, verify `truncate()` runs on every render path — hard contract.
- In shared-mock files, `mockReturnValue` persists across describes — only `mockReset` clears it; prefer `mockReturnValueOnce` with exact per-test consumption counts so one describe can't leak its last return into the next.
- For layout/order changes, assert the exact full item array and separator count, not membership.
- Tests that pass on unfixed code are vacuous for the regression they claim: wrap-around edges pass even without the fix — include mid-list cases that fail on old code.
- File-content test fixtures: malformed input as raw text, not a stringified value (`JSON.stringify` of a malformed-JSON string is valid JSON); assert against known-good literals, not recomputed expectations.
- Clear operations that write a layer must gate on layer existence, not target availability: `projectTargetOffered` (status "absent") is true when no project file exists, so an unconditional project write through it created an inert file on every "all levels" clear. Gate on the loaded/created raw layer (`projectRaw === null` means nothing to clear), and pin the set-then-clear sequence in a test so the guard can't regress to a status check.
- Top-level test/ files import src with `../src/`, not `../../src/`: the latter only resolves via vite's root-relative fallback, which silently breaks when the test file imports real node builtins (e.g. `node:fs` for temp dirs) — failure shows up as a confusing "Cannot find module" on the relative import.
- Widget rendering tests: drive the public seam (`setUICtx` + `update()` + the captured `setWidget` factory's `render()`), not the private `renderWidget` — a shared helper keeps the reach-in out of every test. Real pi-tui components that render against pi's global theme (DynamicBorder) need `initTheme("dark", false)` once per test file.
- `test/` is excluded from tsconfig, so `npm run typecheck` never sees test-fixture type errors — validate new test files with `tsc --noEmit --strict --ignoreConfig <file>` and give fixtures the full required shape (typed base spread), not partial literals.

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
- Remove dead code in the same commit that makes it dead, not later — rewrite the tests that described the dead contract instead of layering new tests beside them.
- Centralize a decision on one authoritative field; downstream consumers key off it.
- When a callback consumer cannot observe an event (continuations bypass the coordinator), ride the signal on the record the callback receives — a settlement ordinal in the shared settlement chain cannot drift from the notify that fires there.
- New config setting: audit the full plumbing list in one pass (type, DEFAULT_AGENT, resolution/setter/sync, CONFIG_AGENT_NON_MODEL_KEYS, mirrored internal defaults). When changing a user-visible default, grep for the old value across src/ and test/. A "setting survives clearAllModelOverrides" test belongs with every new setting.
- Config constraints: enforce at every entry point in one pass (setter, load/default-merge, resolution getter) — enforcing two of three is a trap.
- When a merge needs tombstone markers to express deletions, stop and consider one-file-wins — the tombstone requirement is a design smell, not a feature.
- When overriding a property accessor via defineProperty, check pre-install state reads through the getter — a bootstrap read through the new getter silently stores the wrong value.
- When rewriting a class wholesale, grep the codebase for every public member the old class exposed before dropping any — a removed getter (hasSessionShowCost) surfaces only as a typecheck break in a caller test you haven't run yet.

## pi-ai API & Subagent Lifecycle

- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. `followUp` waits for the agent. Check `ctx.isIdle()` at call time.
- `createAgentSession` re-executes EVERY extension factory and re-fires session_start/shutdown in subagent context. Bracket `runAgent` with a nesting-depth flag; no-op factory and session handlers while a subagent is in flight.
- `AgentSession.dispose()` does NOT emit session_shutdown; subagent `bindExtensions` DOES fire parent's session_start.
- A one-shot gate (consumed set) hides re-occurring events: continuations re-settle, so before designing a delivery/notification gate, ask whether the event can re-occur.
- Verify pi API behavior claims in library source before committing to an approach — pi-tui/pi internals are checkable in ../pi.
- Reading pi's settings.json directly is acceptable when pi APIs don't expose the setting yet.

## Extension Tools

- When tools/resources are silently missing, find the gate first. Seed `createAgentSession({ tools })` with concrete names.
- Allowlist gate must derive from whitelist expansion alone in whitelist mode and gate builtins too.
- Cross-repo trust gate is narrower than it reads: `.pi/` resources + `.agents/skills` are gated, but root `AGENTS.md`/`CLAUDE.md` load unconditionally.
- Before deciding unconditional vs gated loading of repo-controlled files, check the codebase's trust-gate precedents and pi's trust-requiring-resources list in library source.

## SettingsList & Menus

- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs. Never call `ctx.ui.input/select/custom` inside it.
- Submenu rows do NOT refresh their displayed value in place: closing a submenu with a value only sets the raw `currentValue` and fires `onChange`. Menus with provenance tags (`[session]`/`[project]`) must wire `onRebuild` and trigger it from the SettingsList `onChange` (4th constructor arg) for submenu rows. Toggle rows update in place — rebuilding them would reset the cursor to the top.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly.
- Separator-skip lives in one shared helper (`installSeparatorSkip`): override `selectedIndex` on the list instance, since pi-tui stores it as a plain own property and writes ±1-with-wrap directly.
- When simulating library navigation writes in tests, initialize the state field exactly as the library class field does — `undefined + 1` is `NaN`, which silently passes any index check.
- Per-entry override rows need a remove path wherever a set path exists. After adding a per-layer value flow, audit sibling rows for set-only submenus: the default row lacked the Edit/Remove entry that per-provider/per-model rows had, so its value could not be cleared at a chosen level.
- Empty-submission clears are undiscoverable. A numeric submenu that clears on blank submit reads as a bug, and Esc just cancels — add an explicit "Clear..."/"Remove" entry instead (extend `createTargetSelectSubmenu` with `showClear`/`onClear` when the row already uses it).

## Issue Design

- Prototype state machines/key handlers in issue.md as a contract. Call out overflow behavior as a hard AC gate.
- Grill / voice-of-reason shape vague questions into precise issues.
- Verify keybinding claims against the host's default keybindings before writing ACs about keys.

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

## Model settings menu (2026-08-14/15) — consolidated

- Share one precedence chain: the menu and spawn must compute resolution from the same source (`resolveModelSource`). Every re-derived mirror (menu tag logic, test mock, docs) drifted and caused a bug round; a source-returning API kills the class.
- Ask before flipping semantics: the "settings disappear" report had two readings (display vs spawn). It was fixed as a display bug by reordering spawn resolution the user never asked to change — one reversal round later. Display-only fixes are reversible; semantics flips ripple.
- Follow-up issues reverse parent decisions: grep every site the old decision pinned (src, tests, CHANGELOG, docs) and flip them in the same commit. Reversals touch every site; the builder inheriting from the parent shipped the wrong tag set.
- Universal rules need a flow inventory: "clear levels only when set" must enumerate every picker (clear-all, per-type, default row) or one instance ships unfixed. Verify defect scenarios against documented precedence before writing manual-test steps.
- Layout specs: before/after ASCII samples are exact; "align X" is provisional until seen. Row identity is a marker field (`kind`), not label text; verify ANSI/width math in dependency source before styling list labels.
- Pure removals: drop the production field first and let the failing assertions enumerate the pins. Edit-tool slips recur (anchor re-inclusion, overlapping replace+append, broken payloads re-applied after stale-anchor rejections) — re-read payloads and sanity-check the test count.
- Availability predicates must match the action's scope, not the display's — clear-all covers the whole model family, so its "has settings" gate must count defaultThinking/defaultMaxTurns too (review-caught).
- Ancestor walks pay the scratch dir's listing cost: a production `readdirSync` walk up to git root (~250ms per call on a 435k-entry /tmp) makes every test that calls it slow. Keep test scratch under `node_modules/.tmp` (gitignored, prettier-safe) instead of `os.tmpdir()`; also flag the production `readdirSync(...).includes(".git")` → `existsSync(join(dir, ".git"))` O(1) equivalent in the report, but don't fix it from a test-maintenance pass.
- Split big suites at the existing describe boundaries and extract the shared fakes (in-memory IO, call-recording stubs) into a `*-helpers.ts` — moving tests unchanged keeps the split verifiable by test count.
- Node builtin ESM namespaces (node:os, node:fs) reject `vi.spyOn` — "namespace is not configurable in ESM". Fake a home dir with a partial `vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal()), homedir: vi.fn() }))` so the rest of the module (tmpdir, etc.) stays real.
- Mocking a schema library (TypeBox) produces mock-specific shapes: the hand-rolled mock emitted `optional: true`, which real TypeBox never does — optionality is absence from the parent `required` array. Assert against the real library; a mock that drifts from the real output lets tests pin a shape production never emits.

## Orchestration

- Never edit source files directly, even for a small, well-understood change — route through the loop pipeline (grill → write-issue → worktree → builder → review → merge). Direct edits get reverted and the work redone.
- The edit tool may reject anchors as stale even when git shows the file clean; fall back to `replace_text` with unique content instead of re-reading.
- The shell guard refuses `>>` redirection to existing files — append to existing files with the edit tool, not bash.
