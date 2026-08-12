# Lessons Learned

## General

### Worktrees
- Clean up after merge first. Verify worktree path, branch, and checkout state before spawning agents.
- Read files through the worktree path, never the main checkout. Verify `git status` after writing.
- Slice from feature branch HEAD, not main. Wave 2+ needs Wave 1 cleanup first.

### Testing
- Run `npm run test` after merging — clean merge ≠ passing tests.
- Test public interfaces and behavior matching plan.md. Don't assert implementation details; prune unused imports.
- Don't mock away the real path — assert constructor args, not just downstream behavior. Export testable functions early.
- Re-read before multi-line replaces on shifted code — stale ranges clobber adjacent signatures.
- Replace `setTimeout` sleeps with awaiting chained completion promises — faster, no flake.
- afterEach cleanup must remove the whole temp base dir, not one sibling.
- When AC review returns NEEDS_REVISION on recently fixed code, re-review fresh. Manual "all works" → record and proceed.
- vitest mocks are strict: extending a vi.mock factory must keep every symbol the production module imports. Guard config default merges with loadConfig-level tests.
- `parseInt` accepts trailing garbage. Fix: require `/^\d+$/` after trim in numeric validation.
- When two code paths must agree, share the exact computation — don't duplicate the rule with slight differences. Pin the contract as a state table.
- Config setter traps: check which getter the production path reads before choosing the setter in test setup.
- State consumed by render paths must be clamped at the render path, not only in mutators. Pin with tests that mutate state WITHOUT a nav move in between.
- Closure capture traps: a factory mock's closure binds its own parameter, so re-assigning the test's variable does nothing — assign explicitly against the outer variable.
- Recurring vacuous patterns to grep for: tests ending at `.find()` with no expect; global `some()` checks passing from initial state; `expect.any(String)` for branch-specific messages.

### Delegation
- Delegate immediately without pre-reading files. For simple tasks, propose 2-3 name/design alternatives upfront.
- Parallel sub-agents writing docs: mandate distinct output paths. Parallel slices (2+) consistently save time.

### Verification
- Don't assume — verify: confirm merge commits exist, code review catches silent production bugs.
- Never use `general-purpose` when the workflow specifies a specialized agent type.
- `ExtensionAPI` rejects calls to old ctx — wrap sendMessage in try-catch for defense-in-depth.
- Keep review loops strictly sequential; verify agent completion order before spawning the next agent.
- Verify agent output files exist before treating a return as verdict — an empty return with no file means restart, not approval.

### Types & Refactoring
- Run typecheck before removing "redundant" fallbacks. Verify narrowing claims with the typechecker.
- Make source fields optional from the start for explicit-vs-default overrides. Trace ALL mutation paths when adding similar config.
- Delete result fields whose check is implied by a sibling. Return the bare boolean.
- Check for WIP branches that might land before merging. Diff old paths before merging.
- Only extract mock factories with ≥1 consumer in the current slice. Module-level singletons still require vi.mock().
- Prefer public API for cross-package access — private fields break silently on upstream changes.
- After extracting a shared mock, prove each consumer reaches it: a mock is vacuous when the importing modules are themselves mocked. Run the file without it before keeping it.
- When a fix is about which arguments reach a function (e.g. `matchesKey(data, key)`), assert the call args — a mock implementation that ignores args keeps the old bug green.
- A lib-contract test via `vi.importActual` pins the input formats a delegation fix claims to support (legacy `\u000f` vs kitty/modifyOtherKeys `\x1b[111;5u`).
- Two mechanisms converging on the same state with the same gates are vestigial duplication: keep the one owned by the authoritative module (ConfigStore per ADR 0004), delete the other.

### pi-ai API & Subagent Lifecycle
- `deliverAs: "steer"` only queues while parent runs — if idle, pi drops it silently. `followUp` waits for agent to finish. Check `ctx.isIdle()` at call time.
- `createAgentSession` re-executes EVERY extension factory and re-fires session_start/shutdown in subagent context. Fix: bracket `runAgent` with nesting-depth flag; no-op factory and session handlers while subagent is in flight.
- `AgentSession.dispose()` does NOT emit session_shutdown; subagent `bindExtensions` DOES fire parent's session_start.

### Extension Tools
- When tools/resources are silently missing, find the gate first. Seed `createAgentSession({ tools })` with concrete names.
- Allowlist gate must derive from whitelist expansion alone in whitelist mode and gate builtins too.
- Cross-repo trust gate coverage is narrower than it reads: `.pi/` resources + `.agents/skills` are gated, but root `AGENTS.md`/`CLAUDE.md` load unconditionally.

### SettingsList & Menus
- SettingsList: toggles, submenus, separators, static display. No multi-step dialogs. Never call `ctx.ui.input/select/custom` inside it.
- Proxy pattern (`createDelegatingComponent`) chains submenus cleanly. Use `.has()` presence checks for nullable caches.
- Use library helpers instead of reimplementing filtering.

### Issue Design
- Prototype state machines/key handlers in issue.md as a contract. Call out overflow behavior as hard AC gate.

### Buffer & Error Patterns
- Buffer-then-flush is simplest fix for ordering/corruption. Consider error paths when deferring side effects; try/finally guarantees flush.
- When nudges stop working, restart the harness rather than debugging live state.
- `session.abort()`/`steer()` return promises fired from event listeners (abort signal, subscribe callbacks). Node's EventTarget re-throws a listener's returned rejected promise as an uncaught exception, so always `void promise.catch(() => {})` at those sites — a bare call leaks. Mock sessions must be promise-shaped too, or missing rejection handling hides behind `undefined` returns.

### Package Management
- Regenerate lockfiles with package manager when bumping versions; never hand-edit package-lock.json.
- Releasing: keep `[Unreleased]` as empty running header, insert versioned section below it.

### Cross-Platform
- `process.env.HOME` is unreliable on Windows — use `os.homedir()` or SDK's `getAgentDir()`.
- Check existing PRs for reference implementations before grilling alternatives.

### Refactor Scope
- Stay within issue scope.

## output-transcript-setting - 2025-01-15
**What worked:** Single gate design centralizing the decision on `record.outputFile` so all downstream consumers key off one field. Using `??` operator for precedence (agent-level ?? global-level ?? default true) is clean and correct. Voice-of-reason alternatives brainstorm caught design considerations early.
**What failed:** Initial test coverage for agent-level frontmatter override didn't actually exercise the branch — `getAgentConfig` always returned `undefined` in test context because `registerAgents` was never called. Tests were added but would have passed even if the override logic was deleted. Stale dev-artifact comments accumulated in test files. CHANGELOG entry was forgotten initially.
**Next time:** When adding tests for mocked functions, verify the mock is actually being called in the test context — a test that would pass if the feature was deleted is worse than no test. Review tests more carefully to ensure they would fail if the feature was broken. Clean up dev comments immediately. Add CHANGELOG entry as part of initial implementation, not as an afterthought.

## move-model-to-continuation - 2025-01-15
**What worked:** Moving model + thinking to continuation line improves header scannability. Using a shared `buildContinuationLineParts` function for both rendering and height calculation (`getBlockHeight`) prevents nav-mode window math drift. Extracting `resolveAgentModelThinking` removed duplicated resolution logic.
**What failed:** `getBlockHeight` initially didn't account for the new continuation line showing model/thinking, causing nav-mode overflow math to be wrong. The `hasContinuationLine` predicate initially triplicated logic instead of delegating to the shared function. `buildWorktreeOutputParts` became dead code after the refactor but wasn't removed immediately.
**Next time:** When adding a new continuation line element, immediately audit `getBlockHeight` and nav-mode math. Single source of truth — if two functions compute the same derived state, one should call the other. Remove dead code in the same commit that makes it dead, not later.

## model-thinking-placement-setting - follow-up fixes
**What failed:** The feature commit added the setting to only 4 of 7 config plumbing locations. It missed the `SubagentsConfig["agent"]` type in `model-precedence.ts` (typechecked only via the index signature), `DEFAULT_AGENT` in `config-io.ts`, and `CONFIG_AGENT_NON_MODEL_KEYS` in `types.ts`. The last one is a silent data-loss bug: `clearAllModelOverrides` rebuilds `config.agent` from that key list, wiping any setting not listed. A second commit changing the user-visible default ("continuation" → "header") updated only the config-store normalization, leaving the widget's private field default and `buildContinuationLineParts` param default stale at "continuation" — dead but misleading, and tests asserted the stale default.
**Next time:** When adding a config setting, audit the full plumbing list in one pass: `SubagentsConfig` type (`model-precedence.ts`), `DEFAULT_AGENT` (`config-io.ts`), resolution/setter/sync (`config-store.ts`), `CONFIG_AGENT_NON_MODEL_KEYS` (`types.ts`), and every internal default that mirrors the config default. When changing a user-visible default, grep for the old default value across src/ and test/ — internal defaults and tests asserting the old default are part of the change. A test asserting "setting survives clearAllModelOverrides" belongs with every new config setting.

## respect-hide-thinking-setting - 2025-01-15
**What worked:** Using Option 1 (Settings service abstraction) from alternatives.md was the right choice - it centralized file-read logic and decoupled the viewer from pi's file format. The voice-of-reason step caught this before implementation. Reading pi's settings.json directly is acceptable when pi APIs don't expose the setting yet. Handling ctrl+T in the viewer (local state, no persistence) matches the user's requirement perfectly.
**What failed:** Critical logic bug in initial implementation - `thinkingVisible = getHideThinkingBlock()` was inverted (hideThinkingBlock: true means hide, but set thinkingVisible = true). Tests validated the buggy behavior. Streaming thinking didn't show "Thinking..." label when hidden (inconsistent with non-streaming). Tests accessed private state directly instead of simulating session events. Multiple review cycles caught these issues.
**Next time:** When implementing boolean flag inversion (hide vs show), write the test FIRST with the correct expected value, then implement. Don't trust the initial implementation to be correct. For UI features with streaming + non-streaming paths, test both paths explicitly. Tests should simulate behavior through public APIs (session events) not private state manipulation. Use voice-of-reason alternatives earlier to avoid reimplementation.

## fix-agent-widget-progress-truncation - 2025-01-16
**What worked:** Grill skill shaped a vague question ("should we truncate?") into a precise issue with two distinct fixes. Voice-of-reason alternatives forced explicit consideration of approaches. Code review caught missing compact mode prioritization logic that the builder initially skipped. AC review caught missing test assertions for 3 criteria that looked implemented but weren't tested.
**What failed:** Builder missed compact mode prioritization in first implementation (caught in review R1). Builder accidentally removed `truncate()` call on compact mode header while implementing prioritization (caught in review R2). Refactor step had to fix incomplete full-mode description truncation that should have been in the initial implementation. AC review required a second round because tests were added but not initially present.
**Next time:** When the issue specifies prioritization logic with specific thresholds (15-char activity minimum, 30-char description threshold), verify the implementation actually computes those values rather than assuming `truncateToWidth` handles it. The `truncateToWidth` cuts from the right but doesn't implement nuanced prioritization. Review prompt should explicitly ask "does the code compute X threshold?" not just "is the feature implemented?". For pi-tui widgets, always verify `truncate()` is called on every render path - it's a hard contract, not optional.
